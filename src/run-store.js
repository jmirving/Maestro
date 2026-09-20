const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { reportRootForRepo, parseReportName } = require("./reporter");
const { runChecked } = require("./process");

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const stateRevisions = new WeakMap();

class RunStateConflictError extends Error {
  constructor(file) {
    super(`Maestro run state changed before it could be saved: ${file}. Reload the run and reapply the update.`);
    this.name = "RunStateConflictError";
    this.code = "RUN_STATE_CONFLICT";
    this.file = file;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function revision(contents) {
  return contents == null ? null : crypto.createHash("sha256").update(contents).digest("hex");
}

async function readFileIfPresent(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function removeStaleLock(lock) {
  try {
    const owner = Number((await fs.readFile(lock, "utf8")).trim());
    if (!Number.isInteger(owner) || owner <= 0) return false;
    process.kill(owner, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") return false;
    await fs.unlink(lock).catch((unlinkError) => {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    });
    return true;
  }
}

async function withRunStateLock(file, operation, {
  retryMs = LOCK_RETRY_MS,
  timeoutMs = LOCK_TIMEOUT_MS
} = {}) {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const started = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await fs.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await removeStaleLock(lock)) continue;
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for Maestro's run-state lock at ${lock}.`);
      }
      await sleep(retryMs);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lock).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function temporaryPrefix(file) {
  return `${path.basename(file)}.`;
}

async function cleanupTemporaryFiles(file) {
  const directory = path.dirname(file);
  const prefix = temporaryPrefix(file);
  const names = await fs.readdir(directory);
  await Promise.all(names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .map((name) => fs.unlink(path.join(directory, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    })));
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicReplace(file, contents, { afterTemporaryWrite = null, beforeRename = null } = {}) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    let existingMode = null;
    try {
      existingMode = (await fs.stat(file)).mode & 0o777;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    handle = await fs.open(temporary, "wx", existingMode ?? 0o666);
    if (existingMode != null) await handle.chmod(existingMode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (afterTemporaryWrite) await afterTemporaryWrite({ file, temporary });
    if (beforeRename) await beforeRename({ file, temporary });
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function statePath(repoPath, runId) {
  return path.join(reportRootForRepo(repoPath), `run-${runId}.json`);
}

async function latestRunId(repoPath) {
  const runIds = await listPersistedRunIds(repoPath);
  if (!runIds.length) throw new Error(`No Maestro runs found for ${path.resolve(repoPath)}.`);
  return runIds.at(-1);
}

async function listPersistedRunIds(repoPath) {
  const reportRoot = reportRootForRepo(repoPath);
  let names;
  try {
    names = await fs.readdir(reportRoot);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const stateRunIds = names
    .map((name) => name.match(/^run-(\d{14}-[a-f0-9]+)\.json$/)?.[1])
    .filter(Boolean);
  const reportRunIds = names.map(parseReportName).filter(Boolean).map((entry) => entry.runId);
  return [...new Set([...stateRunIds, ...reportRunIds])].sort();
}

async function loadPersistedRunStates(repoPath) {
  const runIds = await listPersistedRunIds(repoPath);
  return Promise.all(runIds.map((runId) => loadRunState(repoPath, runId)));
}

async function saveRunState(repoPath, runId, state, options = {}) {
  const file = statePath(repoPath, runId);
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  await withRunStateLock(file, async () => {
    await cleanupTemporaryFiles(file);
    const currentContents = await readFileIfPresent(file);
    const currentRevision = revision(currentContents);
    const expectedRevision = stateRevisions.get(state);

    if (currentContents === contents) {
      stateRevisions.set(state, currentRevision);
      return;
    }
    if ((currentContents != null && expectedRevision === undefined) ||
        (expectedRevision !== undefined && expectedRevision !== currentRevision)) {
      throw new RunStateConflictError(file);
    }

    await atomicReplace(file, contents, options);
    const nextRevision = revision(contents);
    stateRevisions.set(state, nextRevision);
  }, options);
  return file;
}

function verdictFromText(text) {
  const match = String(text || "").match(/^VERDICT:\s*(APPROVE|REWORK|HUMAN_GATE)\b/m);
  return match ? match[1].toLowerCase() : "invalid";
}

async function reconstructLegacyRun(repoPath, runId, runner = runChecked) {
  const reportRoot = reportRootForRepo(repoPath);
  const names = await fs.readdir(reportRoot);
  const reports = names.map(parseReportName).filter((entry) => entry?.runId === runId);
  if (!reports.length) throw new Error(`No Maestro run ${runId} found.`);

  const issues = [...new Set(reports.map((entry) => entry.issue))];
  const workers = [];
  const validations = [];
  for (const issue of issues) {
    const worktreePath = path.join(path.dirname(reportRoot), `${issue}-${runId}`);
    let branch = null;
    let headSha = null;
    try {
      branch = (await runner("git", ["branch", "--show-current"], { cwd: worktreePath })).stdout.trim() || null;
      headSha = (await runner("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim() || null;
    } catch {
      // Legacy reports are sufficient to reconstruct scheduling state. Their
      // disposable worktrees may already have been removed, so Git metadata is
      // best-effort and must not make status/start/next unusable.
    }
    const workerReportName = reports.find((entry) => entry.issue === issue && entry.kind === "worker")?.name;
    const validatorReportName = reports.find((entry) => entry.issue === issue && entry.kind === "validator")?.name;
    const workerReport = workerReportName ? await fs.readFile(path.join(reportRoot, workerReportName), "utf8") : "";
    const validatorReport = validatorReportName ? await fs.readFile(path.join(reportRoot, validatorReportName), "utf8") : "";
    workers.push({ issue, exitCode: 0, headSha, branch, worktreePath, report: workerReport });
    validations.push({ issue, exitCode: 0, verdict: verdictFromText(validatorReport), report: validatorReport });
  }

  return { runId, mode: "legacy", repoPath: path.resolve(repoPath), workers, validations, reviews: {} };
}

async function loadRunState(repoPath, runId) {
  const file = statePath(repoPath, runId);
  try {
    const contents = await fs.readFile(file, "utf8");
    const state = JSON.parse(contents);
    const loadedRevision = revision(contents);
    stateRevisions.set(state, loadedRevision);
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = await reconstructLegacyRun(repoPath, runId);
    stateRevisions.set(state, null);
    return state;
  }
}

module.exports = {
  statePath,
  latestRunId,
  listPersistedRunIds,
  loadPersistedRunStates,
  saveRunState,
  loadRunState,
  reconstructLegacyRun,
  RunStateConflictError
};

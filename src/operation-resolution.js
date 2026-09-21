const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { newRunId } = require("./controller");
const { executeConflictResolver } = require("./conflict-resolver");
const { captureConflict, inspectGitOperation, isAncestor } = require("./git-conflict");
const { runChecked, runShell } = require("./process");
const { reportRootForRepo } = require("./reporter");
const { loadPersistedRunStates, saveRunState } = require("./run-store");
const { resolveCurrentIssueStates } = require("./run-resolver");
const { reserveExplicitWork, withCapacityLock } = require("./scheduler");
const { processIsRunning } = require("./recovery-attempts");

const DEFAULT_ATTEMPT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

async function gitText(runner, args, cwd) {
  return (await runner("git", args, { cwd })).stdout || "";
}

function statusRecords(text) {
  const raw = String(text || "").split("\0").filter(Boolean);
  const records = [];
  for (let index = 0; index < raw.length; index += 1) {
    const record = raw[index];
    const code = record.slice(0, 2);
    const pathname = record.slice(3);
    const renamedFrom = /[RC]/.test(code) ? raw[++index] || null : null;
    records.push({ code, path: pathname, renamedFrom, record: renamedFrom ? `${record}\0${renamedFrom}` : record });
  }
  return records;
}

function contentHash(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function capturePathState(worktreePath, entry, runner) {
  const absolute = path.join(worktreePath, entry.path);
  const index = await gitText(runner, ["ls-files", "--stage", "-z", "--", entry.path], worktreePath);
  let workingTree;
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      const contents = Buffer.from(target);
      workingTree = { type: "symlink", mode: stat.mode & 0o777, size: contents.length, sha256: contentHash(contents), contentBase64: contents.toString("base64") };
    } else if (stat.isFile()) {
      const contents = await fs.readFile(absolute);
      workingTree = { type: "file", mode: stat.mode & 0o777, size: contents.length, sha256: contentHash(contents), contentBase64: contents.toString("base64") };
    } else {
      workingTree = { type: stat.isDirectory() ? "directory" : "other", mode: stat.mode & 0o777 };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    workingTree = { type: "absent" };
  }
  return { path: entry.path, status: entry.record, index, workingTree };
}

function comparablePathState(entry) {
  return {
    path: entry.path,
    status: entry.status,
    index: entry.index,
    workingTree: entry.workingTree && {
      type: entry.workingTree.type,
      mode: entry.workingTree.mode,
      size: entry.workingTree.size,
      sha256: entry.workingTree.sha256
    }
  };
}

function unrelatedPathStates(snapshot, operationFiles) {
  const allowed = new Set(operationFiles || []);
  return (snapshot.pathStates || [])
    .filter((entry) => !allowed.has(entry.path))
    .map(comparablePathState)
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function capturePreservationSnapshot(worktreePath, runner = runChecked) {
  const [status, unmergedIndex, stagedDiff, unstagedDiff, operationPaths] = await Promise.all([
    gitText(runner, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktreePath),
    gitText(runner, ["ls-files", "-u"], worktreePath),
    gitText(runner, ["diff", "--cached", "--binary"], worktreePath),
    gitText(runner, ["diff", "--binary"], worktreePath),
    gitText(runner, ["diff", "--name-only", "ORIG_HEAD"], worktreePath)
  ]);
  const records = statusRecords(status);
  const pathStates = await Promise.all(records.map((entry) => capturePathState(worktreePath, entry, runner)));
  return {
    capturedAt: new Date().toISOString(),
    statusRecords: records,
    pathStates,
    unmergedIndex,
    stagedDiff,
    unstagedDiff,
    operationPaths: operationPaths.split("\n").map((entry) => entry.trim()).filter(Boolean)
  };
}

async function persistRecoveryArtifact(repoPath, runId, snapshot) {
  const directory = reportRootForRepo(repoPath);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `resolution-${runId}-pre-attempt.json`);
  await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

function configuredChecks(config) {
  const checks = config.resolution?.commands || config.integration?.commands || [];
  if (!checks.length) {
    throw new Error(
      "Standalone conflict adoption requires at least one validation command in resolution.commands " +
      "(or integration.commands). Maestro will not claim an adopted operation was validated without configured checks."
    );
  }
  return checks;
}

async function findContinuableResolution(repoPath, worktreePath) {
  const expected = path.resolve(worktreePath);
  const states = await loadPersistedRunStates(repoPath);
  const matches = states.filter((state) => state.mode === "resolve" &&
    path.resolve(state.resolution?.worktreePath || "") === expected &&
    !["validated", "superseded"].includes(state.status));
  return matches.sort((left, right) => String(left.runId).localeCompare(String(right.runId))).at(-1) || null;
}

async function verifyCompletedOperation({ conflict, beforeSnapshot, worktreePath, runner }) {
  const observed = await inspectGitOperation(worktreePath, { runner });
  if (observed.operationActive || observed.conflictedFiles.length) {
    throw new Error(`Git ${conflict.operation} is still active or has unresolved index entries.`);
  }
  if (conflict.branch && observed.branch !== conflict.branch) {
    throw new Error(`Resolution moved from branch ${conflict.branch} to ${observed.branch || "detached HEAD"}.`);
  }
  if (!(await isAncestor(conflict.targetSha, observed.headSha, { cwd: worktreePath, runner }))) {
    throw new Error(`Resolved HEAD does not contain the recorded ${conflict.operation} target ${conflict.targetSha}.`);
  }
  if (conflict.operation === "merge" &&
      !(await isAncestor(conflict.sourceSha, observed.headSha, { cwd: worktreePath, runner }))) {
    throw new Error(`Resolved merge discarded its recorded source ${conflict.sourceSha}.`);
  }
  if (conflict.operation === "rebase" && observed.headSha === conflict.targetSha) {
    throw new Error("Resolved rebase discarded the source implementation and ended exactly at its target.");
  }
  const afterSnapshot = await capturePreservationSnapshot(worktreePath, runner);
  const operationFiles = [...new Set([...(conflict.conflictedFiles || []), ...(conflict.allowedOperationFiles || beforeSnapshot.operationPaths || [])])];
  const residualOperationFiles = afterSnapshot.statusRecords.filter((entry) => operationFiles.includes(entry.path));
  if (residualOperationFiles.length) {
    throw new Error(`Resolution left residual changes in operation files: ${residualOperationFiles.map((entry) => entry.path).join(", ")}.`);
  }
  const beforeUnrelated = unrelatedPathStates(beforeSnapshot, operationFiles);
  const afterUnrelated = unrelatedPathStates(afterSnapshot, operationFiles);
  if (JSON.stringify(beforeUnrelated) !== JSON.stringify(afterUnrelated)) {
    throw new Error("Resolution changed unrelated staged, unstaged, or untracked user state.");
  }
  return { headSha: observed.headSha, branch: observed.branch, unrelatedUserStatePreserved: true };
}

async function runResolutionChecks(commands, { cwd, shellRunner = runShell }) {
  const results = [];
  for (const command of commands) {
    const result = await shellRunner(command, { cwd, stream: true, streamPrefix: "[resolution check] " });
    results.push({ command, code: result.code, stdout: result.stdout || "", stderr: result.stderr || "" });
    if (result.code !== 0) {
      const error = new Error(`standalone resolution validation failed: ${command}`);
      error.code = "RESOLUTION_VALIDATION_FAILED";
      error.results = results;
      throw error;
    }
  }
  return results;
}

async function executeAdoptedResolution(config, {
  repoPath,
  worktreePath = repoPath,
  issue = null,
  runId = newRunId(),
  continueExisting = false,
  runner = runChecked,
  shellRunner = runShell,
  resolver = executeConflictResolver,
  stateSaver = saveRunState,
  capacityReserver = reserveExplicitWork
} = {}) {
  const checks = configuredChecks(config);
  let state = continueExisting ? await findContinuableResolution(repoPath, worktreePath) : null;
  if (continueExisting && !state) {
    throw new Error(`No persisted adopted operation is available to continue for ${path.resolve(worktreePath)}. Use --adopt for a new handoff.`);
  }
  let conflict;
  let beforeSnapshot;
  const resuming = Boolean(state);
  let expectedCurrent = [];
  if (state) {
    runId = state.runId;
    issue = state.resolution.issue;
    conflict = state.resolution.conflict;
    beforeSnapshot = state.resolution.preAttempt;
  } else {
    const manifestItem = issue == null ? null : config.work?.[String(issue)];
    if (issue != null && manifestItem?.status === "complete") {
      throw new Error(`Issue #${issue} is complete and cannot be revived by adopting a checkout operation.`);
    }
    if (issue != null && (manifestItem?.status === "human_gate" || manifestItem?.humanGate)) {
      throw new Error(`Issue #${issue} has a current human gate; adoption cannot bypass it.`);
    }
    if (issue != null) {
      const current = await resolveCurrentIssueStates(repoPath, [String(issue)]).catch((error) => {
        if (/No Maestro runs found|No relevant Maestro run/.test(error.message)) return [];
        throw error;
      });
      const existing = current[0];
      if (existing) {
        throw new Error(
          `Issue #${issue} already has current lifecycle ownership (${existing.evidence?.state || existing.state?.status || "unknown"}) ` +
          `in run ${existing.runId}; adoption cannot bypass or take it over.`
        );
      }
      expectedCurrent = [{ issue: String(issue), runId: null }];
    }
    const observed = await inspectGitOperation(worktreePath, { runner });
    if (!observed.operationActive) {
      throw new Error("No active Git merge or rebase is available to adopt in this checkout.");
    }
    if (!observed.operationSupported) {
      throw new Error(`Git ${observed.operation} adoption is not supported. Finish or abort it manually; Maestro currently supports merge and rebase.`);
    }
    beforeSnapshot = await capturePreservationSnapshot(worktreePath, runner);
    conflict = await captureConflict({
      repository: config.repository,
      issue,
      sourceRunId: runId,
      stage: "adopted-operation",
      interruptedAction: "explicit standalone operation adoption",
      worktreePath,
      branch: observed.branch,
      startedByMaestro: false,
      runner
    });
    const baseSha = (await gitText(runner, ["merge-base", conflict.sourceSha, conflict.targetSha], worktreePath)).trim();
    const sourceFiles = (await gitText(runner, ["diff", "--name-only", baseSha, conflict.sourceSha], worktreePath))
      .split("\n").map((entry) => entry.trim()).filter(Boolean);
    const targetFiles = (await gitText(runner, ["diff", "--name-only", baseSha, conflict.targetSha], worktreePath))
      .split("\n").map((entry) => entry.trim()).filter(Boolean);
    const relevantFiles = [...new Set([...(conflict.conflictedFiles || []), ...sourceFiles, ...targetFiles])];
    const unrelatedStaged = beforeSnapshot.statusRecords.filter((entry) =>
      entry.code !== "??" && entry.code[0] !== " " && !relevantFiles.includes(entry.path));
    if (unrelatedStaged.length) {
      throw new Error(
        `Cannot adopt this ${conflict.operation} while unrelated paths are staged (${unrelatedStaged.map((entry) => entry.path).join(", ")}); ` +
        "continuing the operation would commit them. Unstage those paths without discarding their working-tree contents, then retry --adopt."
      );
    }
    const artifact = await persistRecoveryArtifact(repoPath, runId, beforeSnapshot);
    conflict.originalBaseSha = baseSha;
    conflict.retainedDiff = await gitText(runner, ["diff", "--binary", baseSha, conflict.sourceSha], worktreePath);
    conflict.targetDiff = await gitText(runner, [
      "diff", "--binary", baseSha, conflict.targetSha, ...(relevantFiles.length ? ["--", ...relevantFiles] : [])
    ], worktreePath);
    conflict.gitStatus = beforeSnapshot.statusRecords.map((entry) => entry.record).join("\n");
    conflict.allowedOperationFiles = relevantFiles;
    conflict.continuationAction = "maestro resolve --continue --agent";
    conflict.preservedResolutionFiles = beforeSnapshot.operationPaths;
    conflict.preservation.recoveryArtifacts.push(artifact);
    state = {
      runId,
      mode: "resolve",
      status: "resolving",
      repoPath,
      plan: { selected: issue == null ? [] : [{ id: String(issue), mode: "resolve" }] },
      workers: [],
      validations: [],
      reviews: {},
      conflicts: issue == null ? {} : { [String(issue)]: conflict },
      resolution: {
        kind: "adopted-operation",
        issue: issue == null ? null : String(issue),
        worktreePath,
        conflict,
        preAttempt: beforeSnapshot,
        checks,
        deadlineAt: Date.now() + (config.resolution?.timeoutMs || DEFAULT_TIMEOUT_MS),
        attempts: []
      }
    };
  }

  if (resuming && issue != null) expectedCurrent = [{ issue: String(issue), runId: String(runId) }];
  let reserved = false;
  const releaseCapacity = async () => {
    if (!state?.capacity?.issues?.length) return;
    await withCapacityLock(repoPath, async () => {
      state.capacity.issues = [];
      state.capacity.releasedAt = new Date().toISOString();
      await stateSaver(repoPath, runId, state);
    });
    reserved = false;
  };

  const priorAttempt = state.resolution.attempts.at(-1);
  if (resuming && priorAttempt?.status === "running") {
    if (processIsRunning(priorAttempt.processId)) {
      throw new Error(`Conflict resolver attempt ${priorAttempt.number} is still running in process ${priorAttempt.processId}.`);
    }
    Object.assign(priorAttempt, {
      status: "interrupted",
      completedAt: new Date().toISOString(),
      failureKind: "resolver-process-exited",
      stderr: priorAttempt.stderr || "The resolver process exited without recording a result."
    });
    state.status = "human-required";
    state.failure = `Conflict resolver attempt ${priorAttempt.number} was interrupted; its charge is retained.`;
    if (state.capacity?.issues?.length) await releaseCapacity();
    else await stateSaver(repoPath, runId, state);
  }

  const observed = await inspectGitOperation(worktreePath, { runner });

  if (observed.operationActive) {
    const attemptLimit = config.resolution?.maxAttempts || DEFAULT_ATTEMPT_LIMIT;
    if (state.resolution.attempts.length >= attemptLimit) {
      state.status = "human-required";
      state.failure = `Conflict resolver attempt limit (${attemptLimit}) exhausted.`;
      await stateSaver(repoPath, runId, state);
      await releaseCapacity();
      throw new Error(`${state.failure} Continue manually in ${worktreePath}, then run \`maestro resolve --continue --agent\` to validate it.`);
    }
    const remainingMs = state.resolution.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      state.status = "human-required";
      state.failure = "Conflict resolver time budget exhausted; the adopted operation remains preserved.";
      await stateSaver(repoPath, runId, state);
      await releaseCapacity();
      return state;
    }
    if (observed.operation !== conflict.operation) {
      throw new Error(`Expected the adopted ${conflict.operation}, but found an active ${observed.operation}.`);
    }
  }

  const pendingAttempt = observed.operationActive ? {
    number: state.resolution.attempts.length + 1,
    at: new Date().toISOString(),
    status: "running",
    processId: process.pid,
    exitCode: null,
    timedOut: false,
    reportPath: null,
    report: null,
    stderr: null
  } : null;
  const reservation = await capacityReserver(config, {
    repoPath,
    runId,
    mode: "resolve",
    items: [{ id: issue == null ? `adopt-${runId}` : String(issue), mode: "resolve" }],
    expectedCurrent,
    currentEligibility: (current) => String(current.runId) === String(runId),
    existingState: state,
    beforePersist: ({ state: persisted }) => {
      persisted.status = observed.operationActive ? "resolving" : "validating";
      if (pendingAttempt) {
        persisted.resolution.attempts.push(pendingAttempt);
        persisted.resolution.conflict.resolution = pendingAttempt;
      }
    }
  });
  if (!reservation.reserved) {
    throw new Error(`Cannot reserve repository capacity for adopted conflict resolution: ${reservation.reason}.`);
  }
  state = reservation.state;
  reserved = true;

  try {
    if (observed.operationActive) {
      let resolution;
      try {
        resolution = await resolver({
          repository: config.repository,
          issue,
          issueContext: config.work?.[String(issue)]?.github || {},
          conflict,
          worktreePath,
          runId,
          timeoutMs: state.resolution.deadlineAt - Date.now()
        });
      } catch (error) {
        Object.assign(pendingAttempt, {
          status: "failed",
          completedAt: new Date().toISOString(),
          stderr: error.message,
          failureKind: "resolver-error"
        });
        state.status = "human-required";
        state.failure = `Conflict resolver failed before reporting a result: ${error.message}`;
        await stateSaver(repoPath, runId, state);
        throw error;
      }
      Object.assign(pendingAttempt, {
        status: resolution.status,
        completedAt: new Date().toISOString(),
        exitCode: resolution.exitCode ?? null,
        timedOut: resolution.timedOut === true,
        reportPath: resolution.reportPath || null,
        report: resolution.report || null,
        stderr: resolution.stderr || null
      });
      conflict.resolution = pendingAttempt;
      if (resolution.status !== "resolved") {
        conflict.requiresSemanticHumanDecision = resolution.status === "human-required";
        conflict.resolutionState = resolution.status === "human-required"
          ? "requires-semantic-human-decision"
          : "awaiting-technical-resolution";
        state.status = "human-required";
        state.failure = resolution.status === "human-required"
          ? "The resolver found a semantic ambiguity."
          : "The resolver did not safely finish the adopted operation.";
        await stateSaver(repoPath, runId, state);
        return state;
      }
    }

    const verification = await verifyCompletedOperation({ conflict, beforeSnapshot, worktreePath, runner });
    state.resolution.verification = verification;
    conflict.operationState = "completed";
    conflict.resolutionState = "verified-awaiting-configured-checks";
    conflict.resolvedHeadSha = verification.headSha;
    conflict.resolutionVerifiedAgainstSha = conflict.targetSha;
    const checkResults = await runResolutionChecks(checks, { cwd: worktreePath, shellRunner });
    const afterChecks = await verifyCompletedOperation({ conflict, beforeSnapshot, worktreePath, runner });
    if (afterChecks.headSha !== verification.headSha || afterChecks.branch !== verification.branch) {
      throw new Error(
        `Standalone resolution checks changed the verified Git result from ${verification.branch || "detached HEAD"}@${verification.headSha} ` +
        `to ${afterChecks.branch || "detached HEAD"}@${afterChecks.headSha}.`
      );
    }
    state.resolution.validation = { status: "passed", results: checkResults };
    conflict.resolutionState = "validated";
    state.status = "validated";
    delete state.failure;
  } catch (error) {
    if (state.status === "human-required" && pendingAttempt?.failureKind === "resolver-error") throw error;
    state.status = error.code === "RESOLUTION_VALIDATION_FAILED" ? "validation-failed" : "human-required";
    state.failure = error.message;
    if (error.results) state.resolution.validation = { status: "failed", results: error.results };
    await stateSaver(repoPath, runId, state);
    throw error;
  } finally {
    if (reserved) await releaseCapacity();
  }
  await stateSaver(repoPath, runId, state);
  return state;
}

module.exports = {
  configuredChecks,
  capturePreservationSnapshot,
  findContinuableResolution,
  verifyCompletedOperation,
  runResolutionChecks,
  executeAdoptedResolution
};

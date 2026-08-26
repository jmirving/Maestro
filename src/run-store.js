const fs = require("node:fs/promises");
const path = require("node:path");
const { reportRootForRepo, parseReportName } = require("./reporter");
const { runChecked } = require("./process");

function statePath(repoPath, runId) {
  return path.join(reportRootForRepo(repoPath), `run-${runId}.json`);
}

async function latestRunId(repoPath) {
  const reportRoot = reportRootForRepo(repoPath);
  let names;
  try {
    names = await fs.readdir(reportRoot);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`No Maestro runs found for ${path.resolve(repoPath)}.`);
    throw error;
  }

  const stateRunIds = names
    .map((name) => name.match(/^run-(\d{14}-[a-f0-9]+)\.json$/)?.[1])
    .filter(Boolean);
  const reportRunIds = names.map(parseReportName).filter(Boolean).map((entry) => entry.runId);
  const runIds = [...new Set([...stateRunIds, ...reportRunIds])];
  if (!runIds.length) throw new Error(`No Maestro runs found for ${path.resolve(repoPath)}.`);
  return runIds.sort().at(-1);
}

async function saveRunState(repoPath, runId, state) {
  const file = statePath(repoPath, runId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
    const branch = (await runner("git", ["branch", "--show-current"], { cwd: worktreePath })).stdout.trim();
    const headSha = (await runner("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
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
  try {
    return JSON.parse(await fs.readFile(statePath(repoPath, runId), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return reconstructLegacyRun(repoPath, runId);
  }
}

module.exports = { statePath, latestRunId, saveRunState, loadRunState, reconstructLegacyRun };

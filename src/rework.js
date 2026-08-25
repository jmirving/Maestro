const { loadRunState, saveRunState } = require("./run-store");
const { runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { runChecked } = require("./process");
const { newRunId } = require("./controller");

async function refreshWorker(worker, { defaultBranch = "main", runner = runChecked } = {}) {
  const status = (await runner("git", ["status", "--porcelain"], { cwd: worker.worktreePath })).stdout.trim();
  if (status) throw new Error(`Rework branch for issue #${worker.issue} is not clean:\n${status}`);
  await runner("git", ["fetch", "origin", defaultBranch], { cwd: worker.worktreePath });
  await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: worker.worktreePath }).catch(async (error) => {
    try { await runner("git", ["rebase", "--abort"], { cwd: worker.worktreePath }); } catch {}
    throw error;
  });
  const baseSha = (await runner("git", ["rev-parse", `origin/${defaultBranch}`], { cwd: worker.worktreePath })).stdout.trim();
  return { ...worker, baseSha };
}

async function executeReworkRun(config, {
  repoPath,
  sourceRunId,
  issueIds = null,
  runId = newRunId(),
  runner = runChecked,
  preflightRunner,
  baselineRunner,
  workerExecutor = executeWorker,
  validatorExecutor = validateWorker,
  stateSaver = saveRunState
} = {}) {
  const source = await loadRunState(repoPath, sourceRunId);
  const validationByIssue = new Map((source.validations || []).map((entry) => [String(entry.issue), entry]));
  const requested = issueIds ? new Set(issueIds.map(String)) : null;
  const candidates = (source.workers || []).filter((worker) => {
    const issue = String(worker.issue);
    return (!requested || requested.has(issue)) && validationByIssue.get(issue)?.verdict === "rework";
  });
  if (!candidates.length) throw new Error(`Run ${sourceRunId} has no selected REWORK issues.`);

  const items = candidates.map((worker) => {
    const configured = config.work?.[String(worker.issue)] || {};
    return { id: String(worker.issue), ...configured, mode: "rework" };
  });

  console.error(`[Maestro] rework ${runId} from ${sourceRunId}: capability preflight`);
  const preflights = await runPreflights(config, items, { cwd: repoPath, runner: preflightRunner });
  console.error(`[Maestro] rework ${runId}: baseline validation`);
  const baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner });

  const refreshed = [];
  for (const worker of candidates) {
    console.error(`[Maestro] rework #${worker.issue}: rebasing existing implementation onto current ${config.defaultBranch || "main"}`);
    refreshed.push(await refreshWorker(worker, { defaultBranch: config.defaultBranch || "main", runner }));
  }

  const workers = await Promise.all(refreshed.map((worker) => {
    const issue = String(worker.issue);
    const item = items.find((entry) => String(entry.id) === issue);
    const priorValidation = validationByIssue.get(issue);
    return workerExecutor({
      repository: config.repository,
      item,
      worktree: {
        repoRoot: repoPath,
        baseSha: worker.baseSha,
        branch: worker.branch,
        worktreePath: worker.worktreePath
      },
      runId,
      correctionContext: {
        sourceRunId,
        priorWorkerReport: worker.report || "",
        validatorReport: priorValidation?.report || ""
      }
    });
  }));

  const validations = await Promise.all(workers
    .filter((worker) => worker.exitCode === 0 && worker.headSha !== worker.baseSha)
    .map((worker) => validatorExecutor({ repository: config.repository, worker, baseline, runId })));

  const result = {
    runId,
    parentRunId: sourceRunId,
    mode: "rework",
    repoPath,
    plan: { selected: items },
    baseline,
    preflights,
    workers,
    validations,
    reviews: {}
  };
  await stateSaver(repoPath, runId, result);
  return result;
}

module.exports = { refreshWorker, executeReworkRun };

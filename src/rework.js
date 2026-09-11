const { loadRunState, saveRunState } = require("./run-store");
const { runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { runChecked } = require("./process");
const { newRunId } = require("./controller");
const { resolveCurrentIssueStates } = require("./run-resolver");

async function resolveIssueReworkSources(repoPath, issueIds) {
  const requested = [...new Set((issueIds || []).map(String))];
  const resolved = await resolveCurrentIssueStates(repoPath, requested);
  if (!requested.length) {
    const actionable = resolved.filter((entry) => (
      entry.evidence.state === "awaiting-rework" && entry.evidence.verdict === "rework"
    ));
    if (!actionable.length) {
      throw new Error("No currently relevant validator-REWORK issues are available.");
    }
    const sourceRunId = actionable
      .map((entry) => String(entry.runId))
      .sort((a, b) => b.localeCompare(a))[0];
    return [{
      sourceRunId,
      issueIds: actionable
        .filter((entry) => String(entry.runId) === sourceRunId)
        .map((entry) => entry.issue)
    }];
  }

  const refused = resolved.filter((entry) => entry.evidence.state !== "awaiting-rework");
  if (refused.length) {
    const details = refused
      .map((entry) => `#${entry.issue} (${entry.evidence.state || "unknown"} in run ${entry.runId})`)
      .join(", ");
    throw new Error(`Cannot rework the current workflow state for ${details}.`);
  }

  const grouped = new Map();
  for (const entry of resolved) {
    if (!grouped.has(entry.runId)) grouped.set(entry.runId, []);
    grouped.get(entry.runId).push(entry.issue);
  }
  return [...grouped.entries()].map(([sourceRunId, issues]) => ({ sourceRunId, issueIds: issues }));
}

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
  const workersByIssue = new Map();
  for (const worker of source.workers || []) {
    const issue = String(worker.issue);
    if (!workersByIssue.has(issue)) workersByIssue.set(issue, []);
    workersByIssue.get(issue).push(worker);
  }
  const validationByIssue = new Map((source.validations || []).map((entry) => [String(entry.issue), entry]));
  const requested = issueIds ? new Set(issueIds.map(String)) : null;
  if (requested) {
    const missing = [...requested].filter((issue) => !workersByIssue.has(issue));
    if (missing.length) {
      throw new Error(`Run ${sourceRunId} has no worker evidence for ${missing.map((issue) => `issue #${issue}`).join(", ")}.`);
    }
    const ambiguous = [...requested].filter((issue) => workersByIssue.get(issue).length !== 1);
    if (ambiguous.length) {
      throw new Error(`Run ${sourceRunId} has ambiguous worker evidence for ${ambiguous.map((issue) => `issue #${issue}`).join(", ")}.`);
    }
    const ineligible = [...requested].filter((issue) => {
      const validationRequiresRework = validationByIssue.get(issue)?.verdict === "rework";
      const humanRequestedRework = source.reviews?.[issue]?.disposition === "rework-original";
      return !validationRequiresRework && !humanRequestedRework;
    });
    if (ineligible.length) {
      const details = ineligible.map((issue) => {
        const verdict = validationByIssue.get(issue)?.verdict || "missing";
        const disposition = source.reviews?.[issue]?.disposition || "none";
        return `#${issue} (validator=${verdict}, review=${disposition})`;
      }).join(", ");
      throw new Error(`Cannot rework non-REWORK issue state in run ${sourceRunId}: ${details}.`);
    }
  }
  const candidates = (source.workers || []).filter((worker) => {
    const issue = String(worker.issue);
    const validationRequiresRework = validationByIssue.get(issue)?.verdict === "rework";
    const humanRequestedRework = source.reviews?.[issue]?.disposition === "rework-original";
    return (!requested || requested.has(issue)) && (validationRequiresRework || humanRequestedRework);
  });
  if (!candidates.length) throw new Error(`Run ${sourceRunId} has no selected REWORK issues.`);

  const items = candidates.map((worker) => {
    const configured = config.work?.[String(worker.issue)] || {};
    return { id: String(worker.issue), ...configured, mode: "rework" };
  });

  const result = {
    runId,
    parentRunId: sourceRunId,
    mode: "rework",
    status: "running",
    repoPath,
    plan: { selected: items },
    baseline: null,
    preflights: [],
    workers: [],
    validations: [],
    reviews: {}
  };
  await stateSaver(repoPath, runId, result);

  try {
    console.error(`[Maestro] rework ${runId} from ${sourceRunId}: capability preflight`);
    result.preflights = await runPreflights(config, items, { cwd: repoPath, runner: preflightRunner });
    console.error(`[Maestro] rework ${runId}: baseline validation`);
    result.baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner });

    const refreshed = [];
    for (const worker of candidates) {
      console.error(`[Maestro] rework #${worker.issue}: rebasing existing implementation onto current ${config.defaultBranch || "main"}`);
      refreshed.push(await refreshWorker(worker, { defaultBranch: config.defaultBranch || "main", runner }));
    }

    result.workers = await Promise.all(refreshed.map((worker) => {
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

    result.validations = await Promise.all(result.workers
      .filter((worker) => worker.exitCode === 0 && worker.headSha !== worker.baseSha)
      .map((worker) => validatorExecutor({ repository: config.repository, worker, baseline: result.baseline, runId })));

    result.status = "awaiting-review";
    await stateSaver(repoPath, runId, result);
    return result;
  } catch (error) {
    result.status = "failed";
    result.failure = error.message;
    await stateSaver(repoPath, runId, result);
    throw error;
  }
}

module.exports = { resolveIssueReworkSources, refreshWorker, executeReworkRun };

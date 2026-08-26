const fs = require("node:fs/promises");
const path = require("node:path");
const { loadRunState, saveRunState } = require("./run-store");
const { runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { validateWorker } = require("./validator");
const { runChecked, runProcess } = require("./process");
const { newRunId } = require("./controller");
const { currentHead } = require("./worktrees");

async function ensureCleanWorktree(worker, runner = runChecked) {
  const status = (await runner("git", ["status", "--porcelain"], { cwd: worker.worktreePath })).stdout.trim();
  if (status) throw new Error(`Reconcile branch for issue #${worker.issue} is not clean before rebase:\n${status}`);
}

async function rebaseInProgress(worktreePath, runner = runProcess) {
  const result = await runner("git", ["rev-parse", "-q", "--verify", "REBASE_HEAD"], { cwd: worktreePath });
  return result.code === 0;
}

function buildReconcilePrompt({ repository, worker, validation, sourceRunId, defaultBranch }) {
  return `Reconcile ${repository} issue #${worker.issue} after an integration-time rebase conflict.\n\n` +
    `The implementation was already validator-approved in Maestro run ${sourceRunId}. Do not redesign or restart the issue. ` +
    `The worktree is intentionally left in an active git rebase conflict against origin/${defaultBranch}.\n\n` +
    `Resolve ONLY the rebase conflict(s) while preserving both current ${defaultBranch} behavior and the approved issue behavior. ` +
    `Read repository instructions and inspect both sides of each conflict before editing. After resolving, stage the files and complete the rebase with GIT_EDITOR=true git rebase --continue. ` +
    `Then run focused tests for the touched behavior plus repository-required validation proportional to the conflict. Do not push, merge the default branch, or close the issue.\n\n` +
    `Previously approved validator report:\n---\n${validation?.report || "(none)"}\n---\n\n` +
    `Previously approved worker report:\n---\n${worker.report || "(none)"}\n---\n\n` +
    `Final report must state what conflicted, how both sides were preserved, tests/results, final commit SHA, and any human decision required.\n\n` +
    `End with a section titled exactly \"### Human review\" containing the highest-value manual regression check.`;
}

async function resolveConflictWithAgent({ repository, worker, validation, sourceRunId, runId, defaultBranch, codexCommand = "codex", runner = runProcess }) {
  const reportDir = path.join(path.dirname(worker.worktreePath), ".maestro-reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `worker-${worker.issue}-${runId}.md`);
  const prompt = buildReconcilePrompt({ repository, worker, validation, sourceRunId, defaultBranch });
  console.error(`[Maestro] reconcile #${worker.issue}: agent resolving rebase conflict`);
  const result = await runner(codexCommand, ["exec", "--sandbox", "danger-full-access", "--output-last-message", reportPath, "-"], {
    cwd: worker.worktreePath,
    input: `${prompt}\n`,
    stream: true,
    streamPrefix: `[#${worker.issue} reconcile] `
  });
  let report = "";
  try { report = await fs.readFile(reportPath, "utf8"); } catch {}
  return { result, report, reportPath };
}

async function executeReconcileRun(config, {
  repoPath,
  sourceRunId,
  issueIds = null,
  runId = newRunId(),
  runner = runChecked,
  processRunner = runProcess,
  preflightRunner,
  baselineRunner,
  validatorExecutor = validateWorker,
  stateSaver = saveRunState
} = {}) {
  const source = await loadRunState(repoPath, sourceRunId);
  const validationByIssue = new Map((source.validations || []).map((entry) => [String(entry.issue), entry]));
  const integrated = new Set((source.integration || []).map((entry) => String(entry.issue)));
  const requested = issueIds ? new Set(issueIds.map(String)) : null;
  const candidates = (source.workers || []).filter((worker) => {
    const issue = String(worker.issue);
    return (!requested || requested.has(issue)) && !integrated.has(issue) && validationByIssue.get(issue)?.verdict === "approve";
  });
  if (!candidates.length) throw new Error(`Run ${sourceRunId} has no selected approved, unintegrated issues to reconcile.`);

  const items = candidates.map((worker) => ({ id: String(worker.issue), ...(config.work?.[String(worker.issue)] || {}), mode: "reconcile" }));
  console.error(`[Maestro] reconcile ${runId} from ${sourceRunId}: capability preflight`);
  const preflights = await runPreflights(config, items, { cwd: repoPath, runner: preflightRunner });
  console.error(`[Maestro] reconcile ${runId}: baseline validation`);
  const baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner });
  const defaultBranch = config.defaultBranch || "main";
  const workers = [];

  for (const original of candidates) {
    await ensureCleanWorktree(original, runner);
    await runner("git", ["fetch", "origin", defaultBranch], { cwd: original.worktreePath });
    const baseSha = (await runner("git", ["rev-parse", `origin/${defaultBranch}`], { cwd: original.worktreePath })).stdout.trim();
    let conflicted = false;
    try {
      await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: original.worktreePath });
    } catch (error) {
      conflicted = true;
      console.error(`[Maestro] reconcile #${original.issue}: rebase conflict detected; delegating bounded resolution`);
    }

    let report = original.report || "";
    let reportPath = original.reportPath || null;
    let exitCode = 0;
    if (conflicted) {
      const resolved = await resolveConflictWithAgent({
        repository: config.repository,
        worker: original,
        validation: validationByIssue.get(String(original.issue)),
        sourceRunId,
        runId,
        defaultBranch,
        runner: processRunner
      });
      exitCode = resolved.result.code;
      report = resolved.report;
      reportPath = resolved.reportPath;
      const stillRebasing = await rebaseInProgress(original.worktreePath, processRunner);
      const dirty = (await runner("git", ["status", "--porcelain=v1"], { cwd: original.worktreePath })).stdout.trim();
      if (exitCode !== 0 || stillRebasing || dirty) {
        try { await runner("git", ["rebase", "--abort"], { cwd: original.worktreePath }); } catch {}
        if (exitCode === 0) {
          const reasons = [stillRebasing ? "rebase still in progress" : null, dirty ? `dirty worktree:\n${dirty}` : null].filter(Boolean).join("; ");
          throw new Error(`Reconcile agent did not complete issue #${original.issue} cleanly: ${reasons}`);
        }
      }
    }

    const headSha = await currentHead(original.worktreePath, runner);
    workers.push({
      ...original,
      mode: "reconcile",
      status: exitCode === 0 ? "worker-finished" : "worker-failed",
      exitCode,
      baseSha,
      headSha,
      report,
      reportPath,
      reconciledFromRunId: sourceRunId,
      hadRebaseConflict: conflicted
    });
  }

  const validations = await Promise.all(workers
    .filter((worker) => worker.exitCode === 0 && worker.headSha !== worker.baseSha)
    .map((worker) => validatorExecutor({ repository: config.repository, worker, baseline, runId })));

  const result = {
    runId,
    parentRunId: sourceRunId,
    mode: "reconcile",
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

module.exports = { buildReconcilePrompt, rebaseInProgress, executeReconcileRun };

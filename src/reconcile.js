const fs = require("node:fs/promises");
const path = require("node:path");
const { loadRunState, saveRunState } = require("./run-store");
const { runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { validateWorker } = require("./validator");
const { runChecked, runProcess } = require("./process");
const { newRunId } = require("./controller");
const { currentHead } = require("./worktrees");
const { reserveExplicitWork } = require("./scheduler");
const { commitLifecycleTransition } = require("./lifecycle-coordination");
const { resolveCurrentIssueStates, runDescendsFrom } = require("./run-resolver");
const { inspectGitOperation, captureConflict, contentConflictError, isAncestor } = require("./git-conflict");
const { bindValidation } = require("./authorization");

async function resolveReconcileSource(repoPath, issue, explicitRunId = null) {
  if (explicitRunId) return { sourceRunId: String(explicitRunId), issueIds: issue ? [String(issue)] : null };
  if (!issue) throw new Error("Issue-oriented reconciliation requires an issue number unless --run selects historical evidence.");
  const [current] = await resolveCurrentIssueStates(repoPath, [String(issue)]);
  const conflict = current.evidence?.conflict;
  if (current.evidence?.state !== "technical-conflict" ||
      !["integration-refresh", "reconciliation-refresh"].includes(conflict?.interruptedStage)) {
    throw new Error(`Issue #${issue} has no current integration conflict to reconcile.`);
  }
  return {
    sourceRunId: String(conflict.sourceRunId || current.runId),
    issueIds: [String(issue)],
    ...(current.state.mode === "reconcile" ? { resumeRunId: current.runId } : {})
  };
}

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
  stateSaver = saveRunState,
  reserveCapacity = false,
  capacityReserver = reserveExplicitWork
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

  const current = await resolveCurrentIssueStates(repoPath, candidates.map((worker) => String(worker.issue)));
  const superseded = [];
  for (const entry of current) {
    if (String(entry.runId) === String(sourceRunId)) continue;
    const conflict = entry.evidence?.conflict;
    const matchingConflictDescendant = entry.evidence?.state === "technical-conflict" &&
      String(conflict?.sourceRunId) === String(sourceRunId) &&
      !["completed", "resolved", "manually-resolved"].includes(conflict?.operationState) &&
      await runDescendsFrom(repoPath, entry.state, sourceRunId);
    if (!matchingConflictDescendant) superseded.push(entry);
  }
  if (superseded.length) {
    throw new Error(
      `Cannot reconcile superseded implementation evidence from run ${sourceRunId}: ` +
      superseded.map((entry) => `#${entry.issue} is current in ${entry.runId}`).join(", ") + "."
    );
  }

  const items = candidates.map((worker) => ({ id: String(worker.issue), ...(config.work?.[String(worker.issue)] || {}), mode: "reconcile" }));
  const resumeState = runId && String(runId) !== String(sourceRunId)
    ? await loadRunState(repoPath, runId).catch((error) => /No Maestro run/.test(error.message) ? null : Promise.reject(error))
    : null;
  const resuming = resumeState?.mode === "reconcile" && resumeState?.status === "technical-conflict";
  let reservation = null;
  if (reserveCapacity) {
    reservation = await capacityReserver(config, {
      repoPath,
      runId,
      mode: "reconcile",
      items,
      existingState: resumeState,
      extraState: resuming
        ? { ...resumeState, status: "running" }
        : {
            parentRunId: sourceRunId,
            ...(source.authorization?.allowedActions?.correct === true ? { authorization: source.authorization } : {})
          }
    });
    if (!reservation.reserved) {
      throw new Error(`Cannot reserve worker capacity for conflict resolution: ${reservation.reason}.`);
    }
  }
  const result = Object.assign(reservation?.state || resumeState || {}, {
    runId,
    parentRunId: sourceRunId,
    mode: "reconcile",
    status: "running",
    repoPath,
    plan: { selected: items },
    baseline: null,
    preflights: [],
    workers: [],
    validations: [],
    reviews: reservation?.state?.reviews || resumeState?.reviews || {},
    conflicts: resumeState?.conflicts || {}
  });
  if (resuming) {
    result.workers = [];
    result.validations = [];
    delete result.failure;
  }
  if (!reservation) await stateSaver(repoPath, runId, result);
  try {
  console.error(`[Maestro] reconcile ${runId} from ${sourceRunId}: capability preflight`);
  result.preflights = await runPreflights(config, items, { cwd: repoPath, runner: preflightRunner });
  console.error(`[Maestro] reconcile ${runId}: baseline validation`);
  result.baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner });
  await stateSaver(repoPath, runId, result);
  const defaultBranch = config.defaultBranch || "main";

  for (const original of candidates) {
    const before = await inspectGitOperation(original.worktreePath, { runner });
    if (before.operationActive || before.conflictedFiles.length) {
      const conflict = await captureConflict({
        repository: config.repository, issue: original.issue, sourceRunId,
        parentRunId: sourceRunId, stage: "reconciliation-refresh",
        interruptedAction: "fresh reconciliation validation",
        worktreePath: original.worktreePath, branch: original.branch || null,
        originalBaseSha: original.baseSha || null, targetBranch: defaultBranch,
        startedByMaestro: false, runner
      });
      result.conflicts[String(original.issue)] = conflict;
      result.status = "technical-conflict";
      await stateSaver(repoPath, runId, result);
      throw contentConflictError(conflict);
    }
    await ensureCleanWorktree(original, runner);
    await runner("git", ["fetch", "origin", defaultBranch], { cwd: original.worktreePath });
    const baseSha = (await runner("git", ["rev-parse", `origin/${defaultBranch}`], { cwd: original.worktreePath })).stdout.trim();
    const sourceSha = (await runner("git", ["rev-parse", "HEAD"], { cwd: original.worktreePath })).stdout.trim();
    const issue = String(original.issue);
    let conflicted = false;
    const persistedConflict = resuming
      ? result.conflicts?.[issue]
      : source.conflicts?.[issue];
    let conflict = persistedConflict
      ? { ...persistedConflict }
      : null;
    if (conflict) result.conflicts[issue] = conflict;
    try {
      await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: original.worktreePath });
    } catch (error) {
      conflicted = true;
      conflict = await captureConflict({
        repository: config.repository, issue: original.issue, sourceRunId,
        parentRunId: sourceRunId, stage: "reconciliation-refresh",
        interruptedAction: "fresh reconciliation validation",
        worktreePath: original.worktreePath, branch: original.branch || null,
        originalBaseSha: original.baseSha || null, sourceSha,
        targetBranch: defaultBranch, targetSha: baseSha, failure: error, runner
      });
      if (conflict) {
        result.conflicts[String(original.issue)] = conflict;
        await stateSaver(repoPath, runId, result);
      }
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
        if (conflict) {
          conflict.operationState = "aborted";
          conflict.resolutionState = "awaiting-technical-resolution";
          conflict.failure = exitCode === 0
            ? [stillRebasing ? "rebase still in progress" : null, dirty ? `dirty worktree:\n${dirty}` : null].filter(Boolean).join("; ")
            : `bounded resolver exited ${exitCode}`;
          result.status = "technical-conflict";
          result.failure = conflict.failure;
          await stateSaver(repoPath, runId, result);
          throw contentConflictError(conflict);
        }
        const reasons = [exitCode !== 0 ? `resolver exited ${exitCode}` : null, stillRebasing ? "rebase still in progress" : null, dirty ? `dirty worktree:\n${dirty}` : null].filter(Boolean).join("; ");
        throw new Error(`Reconcile agent did not complete issue #${original.issue} cleanly: ${reasons}`);
      }
    }

    const headSha = await currentHead(original.worktreePath, runner);
    if (!(await isAncestor(baseSha, headSha, { cwd: original.worktreePath, runner })) || headSha === baseSha) {
      throw new Error(`Reconcile recovery for issue #${original.issue} discarded the source implementation instead of retaining it beyond ${baseSha}.`);
    }
    if (conflict) {
      conflict.operationState = "completed";
      conflict.resolutionState = "verified-awaiting-fresh-validation";
      conflict.resolvedBy = conflicted ? "bounded-conflict-resolver" : "reconciliation-refresh";
      conflict.resolvedHeadSha = headSha;
      conflict.resolutionVerifiedAgainstSha = baseSha;
    }
    result.workers.push({
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
    await stateSaver(repoPath, runId, result);
  }

  result.validations = await Promise.all(result.workers
    .filter((worker) => worker.exitCode === 0 && worker.headSha !== worker.baseSha)
    .map(async (worker) => bindValidation(config, worker, await validatorExecutor({ repository: config.repository, worker, baseline: result.baseline, runId }), { scopeRevision: result.authorization?.scope?.revision })));

  result.status = "awaiting-review";
  if (stateSaver === saveRunState) {
    await commitLifecycleTransition({
      repoPath,
      runId,
      issueIds: items.map((item) => item.id),
      mutate: (current) => {
        const reviews = current.reviews || {};
        Object.assign(current, result, { reviews });
        if (current.capacity?.issues) current.capacity.issues = [];
        return current;
      }
    });
    if (result.capacity?.issues) result.capacity.issues = [];
  } else {
    await stateSaver(repoPath, runId, result);
  }
  return result;
  } catch (error) {
    if (result.status !== "technical-conflict") result.status = "failed";
    result.failure = result.failure || error.message;
    if (result.capacity?.issues) result.capacity.issues = [];
    if (reservation?.state) {
      if (stateSaver === saveRunState) {
        await commitLifecycleTransition({
          repoPath,
          runId,
          issueIds: items.map((item) => item.id),
          mutate: () => result
        });
      } else {
        await stateSaver(repoPath, runId, result);
      }
    } else {
      await stateSaver(repoPath, runId, result);
    }
    throw error;
  }
}

module.exports = { buildReconcilePrompt, rebaseInProgress, resolveReconcileSource, executeReconcileRun };

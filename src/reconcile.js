const { loadRunState, saveRunState } = require("./run-store");
const { runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { MAX_VALIDATOR_OUTPUT_BYTES, validateWorker } = require("./validator");
const { runChecked, runProcess } = require("./process");
const { newRunId } = require("./controller");
const { currentHead } = require("./worktrees");
const { reserveExplicitWork, withCapacityLock } = require("./scheduler");
const { commitLifecycleTransition } = require("./lifecycle-coordination");
const { resolveCurrentIssueStates, runDescendsFrom } = require("./run-resolver");
const { inspectGitOperation, captureConflict, contentConflictError, isAncestor } = require("./git-conflict");
const { bindValidation } = require("./authorization");
const { executeConflictResolver } = require("./conflict-resolver");
const {
  DEFAULT_RECOVERY_ATTEMPT_LIMIT,
  ensureRecoveryContract,
  interruptExitedAttempt,
  nextRecoveryAttempt,
  assertRecoveryAvailable,
  runWithinRecoveryDeadline
} = require("./recovery-attempts");

const DEFAULT_RECONCILE_TIMEOUT_MS = 10 * 60 * 1000;

function validationTimeout(issue, remainingMs) {
  const error = new Error(`Fresh validation for issue #${issue} timed out after ${remainingMs}ms.`);
  error.code = "RECOVERY_TIMEOUT";
  return error;
}

async function validateWithinRecoveryDeadline(validatorExecutor, args, { issue, deadlineAt }) {
  return runWithinRecoveryDeadline({ deadlineAt }, (timeoutMs) => validatorExecutor({
    ...args,
    timeoutMs,
    maxOutputBytes: MAX_VALIDATOR_OUTPUT_BYTES
  }), { label: `Fresh validation for issue #${issue}` });
}

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
  try {
    const result = await runner("git", ["rev-parse", "-q", "--verify", "REBASE_HEAD"], { cwd: worktreePath });
    return result.code === undefined || result.code === 0;
  } catch {
    return false;
  }
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
  conflictResolver = executeConflictResolver,
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
  const resuming = resumeState?.mode === "reconcile" && Object.values(resumeState.conflicts || {})
    .some((conflict) => !["completed", "resolved", "manually-resolved"].includes(conflict.operationState));
  if (resuming) {
    let interrupted = false;
    for (const conflict of Object.values(resumeState.conflicts || {})) {
      if (!conflict.recovery) continue;
      interrupted = Boolean(interruptExitedAttempt(conflict.recovery)) || interrupted;
    }
    if (interrupted || resumeState.capacity?.issues?.length) {
      const releaseInterrupted = async () => {
        if (resumeState.capacity?.issues) resumeState.capacity.issues = [];
        resumeState.capacity = resumeState.capacity || {};
        resumeState.capacity.releasedAt = new Date().toISOString();
        resumeState.status = "technical-conflict";
        await stateSaver(repoPath, runId, resumeState);
      };
      if (stateSaver === saveRunState) await withCapacityLock(repoPath, releaseInterrupted);
      else await releaseInterrupted();
    }
  }
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
    plan: {
      ...(reservation?.state?.plan || resumeState?.plan || source.plan || {}),
      selected: items
    },
    baseline: resumeState?.baseline || null,
    preflights: resumeState?.preflights || [],
    workers: [],
    validations: [],
    reviews: reservation?.state?.reviews || resumeState?.reviews || {},
    conflicts: resumeState?.conflicts || {}
  });
  result.recovery = ensureRecoveryContract(result.recovery, {
    kind: "managed-reconciliation",
    issue: null,
    timeoutMs: config.resolution?.timeoutMs || DEFAULT_RECONCILE_TIMEOUT_MS,
    sourceRunId
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
    const issue = String(original.issue);
    const before = await inspectGitOperation(original.worktreePath, { runner });
    const persistedConflict = resuming
      ? result.conflicts?.[issue]
      : source.conflicts?.[issue];
    let conflict = persistedConflict ? { ...persistedConflict } : null;
    let baseSha;
    let sourceSha;
    let conflicted = false;
    if ((before.operationActive || before.conflictedFiles.length) && resuming && conflict) {
      if (before.operation !== conflict.operation) {
        throw new Error(`Expected the persisted ${conflict.operation} for issue #${issue}, but found ${before.operation || "no matching operation"}.`);
      }
      conflicted = true;
      baseSha = conflict.targetSha;
      sourceSha = conflict.sourceSha;
      result.conflicts[issue] = conflict;
    } else if (before.operationActive || before.conflictedFiles.length) {
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
    } else {
      await ensureCleanWorktree(original, runner);
      await runner("git", ["fetch", "origin", defaultBranch], { cwd: original.worktreePath });
      baseSha = (await runner("git", ["rev-parse", `origin/${defaultBranch}`], { cwd: original.worktreePath })).stdout.trim();
      sourceSha = (await runner("git", ["rev-parse", "HEAD"], { cwd: original.worktreePath })).stdout.trim();
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
          const originalBaseSha = conflict.originalBaseSha || (await runner("git", ["merge-base", sourceSha, baseSha], { cwd: original.worktreePath })).stdout.trim();
          conflict.originalBaseSha = originalBaseSha;
          conflict.retainedDiff = (await runner("git", ["diff", "--binary", originalBaseSha, sourceSha], { cwd: original.worktreePath })).stdout;
          conflict.targetDiff = (await runner("git", [
            "diff", "--binary", originalBaseSha, baseSha, "--", ...conflict.conflictedFiles
          ], { cwd: original.worktreePath })).stdout;
          conflict.implementationFiles = (await runner("git", ["diff", "--name-only", originalBaseSha, sourceSha], { cwd: original.worktreePath })).stdout
            .split("\n").map((entry) => entry.trim()).filter(Boolean);
          conflict.gitStatus = conflict.statusEvidence;
          result.conflicts[issue] = conflict;
          await stateSaver(repoPath, runId, result);
        }
        console.error(`[Maestro] reconcile #${original.issue}: rebase conflict detected; delegating bounded resolution`);
      }
    }

    let report = original.report || "";
    let reportPath = original.reportPath || null;
    let exitCode = 0;
    if (conflicted) {
      conflict.recovery = ensureRecoveryContract(conflict.recovery, {
        kind: "managed-conflict",
        issue,
        timeoutMs: config.resolution?.timeoutMs || DEFAULT_RECONCILE_TIMEOUT_MS,
        sourceRunId,
        operation: conflict.operation
      });
      let remainingMs;
      try {
        remainingMs = assertRecoveryAvailable(conflict.recovery, {
          attemptLimit: config.resolution?.maxAttempts || DEFAULT_RECOVERY_ATTEMPT_LIMIT,
          label: `Conflict resolution for issue #${issue}`
        });
      } catch (error) {
        conflict.resolutionState = "awaiting-technical-resolution";
        conflict.failure = error.message;
        result.status = "technical-conflict";
        result.failure = error.message;
        await stateSaver(repoPath, runId, result);
        throw contentConflictError(conflict);
      }
      const attempt = nextRecoveryAttempt(conflict.recovery, { phase: "resolver", status: "running" });
      conflict.resolution = attempt;
      result.status = "running";
      await stateSaver(repoPath, runId, result);
      let resolved;
      try {
        resolved = await conflictResolver({
          repository: config.repository,
          issue,
          issueContext: config.work?.[issue]?.github || {},
          priorWorkerReport: original.report || "",
          validatorReport: validationByIssue.get(issue)?.report || "",
          conflict,
          worktreePath: original.worktreePath,
          runId,
          runner: processRunner,
          timeoutMs: remainingMs
        });
      } catch (error) {
        Object.assign(attempt, {
          status: "failed",
          outcome: "resolver-error",
          completedAt: new Date().toISOString(),
          stderr: error.message
        });
        conflict.operationState = "active";
        conflict.resolutionState = "awaiting-technical-resolution";
        conflict.failure = `bounded resolver failed before reporting: ${error.message}`;
        result.status = "technical-conflict";
        result.failure = conflict.failure;
        await stateSaver(repoPath, runId, result);
        throw contentConflictError(conflict);
      }
      exitCode = resolved.exitCode ?? (resolved.status === "resolved" ? 0 : 1);
      report = resolved.report;
      reportPath = resolved.reportPath;
      Object.assign(attempt, {
        status: "completed",
        outcome: resolved.status,
        completedAt: new Date().toISOString(),
        exitCode,
        timedOut: resolved.timedOut === true,
        reportPath,
        report,
        stderr: resolved.stderr || null
      });
      const stillRebasing = (await inspectGitOperation(original.worktreePath, { runner })).operationActive;
      const dirty = (await runner("git", ["status", "--porcelain=v1"], { cwd: original.worktreePath })).stdout.trim();
      if (resolved.status !== "resolved" || exitCode !== 0 || stillRebasing || dirty) {
        if (conflict) {
          conflict.operationState = stillRebasing ? "active" : "completed-unverified";
          conflict.requiresSemanticHumanDecision = resolved.status === "human-required";
          conflict.resolutionState = resolved.status === "human-required"
            ? "requires-semantic-human-decision"
            : "awaiting-technical-resolution";
          conflict.resolution = attempt;
          conflict.failure = resolved.status === "resolved" && exitCode === 0
            ? [stillRebasing ? "rebase still in progress" : null, dirty ? `dirty worktree:\n${dirty}` : null].filter(Boolean).join("; ")
            : resolved.status === "human-required" ? "bounded resolver requires a semantic human decision" : `bounded resolver failed (exit ${exitCode})`;
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

  result.validations = [];
  for (const worker of result.workers.filter((entry) => entry.exitCode === 0 && entry.headSha !== entry.baseSha)) {
    const conflict = result.conflicts?.[String(worker.issue)];
    if (conflict) {
      conflict.recovery = ensureRecoveryContract(conflict.recovery, {
        kind: "managed-conflict",
        issue: worker.issue,
        timeoutMs: config.resolution?.timeoutMs || DEFAULT_RECONCILE_TIMEOUT_MS,
        sourceRunId,
        operation: conflict.operation
      });
    }
    let validation;
    try {
      const deadlineAt = conflict?.recovery?.deadlineAt || result.recovery.deadlineAt;
      validation = await validateWithinRecoveryDeadline(validatorExecutor, {
        repository: config.repository, worker, baseline: result.baseline, runId
      }, { issue: worker.issue, deadlineAt });
    } catch (error) {
      if (error.code !== "RECOVERY_TIMEOUT") throw error;
      validation = { issue: worker.issue, exitCode: 1, timedOut: true, verdict: "failed", report: "", stderr: error.message };
    }
    if (validation.timedOut) {
      const failure = `Fresh validation timed out within the persisted recovery deadline for issue #${worker.issue}.`;
      const recovery = conflict?.recovery || result.recovery;
      recovery.outcome = "timeout";
      recovery.timeoutStage = "validator";
      recovery.validation = validation;
      result.failure = failure;
      if (conflict) {
        conflict.operationState = "completed";
        conflict.resolutionState = "awaiting-technical-resolution";
        conflict.failure = failure;
        result.status = "technical-conflict";
        await stateSaver(repoPath, runId, result);
        throw contentConflictError(conflict);
      }
      const error = validationTimeout(worker.issue, 0);
      error.message = failure;
      throw error;
    }
    result.validations.push(bindValidation(config, worker, validation, { scopeRevision: result.authorization?.scope?.revision }));
    const verifiedHead = await currentHead(worker.worktreePath, runner);
    const verifiedBranch = (await runner("git", ["branch", "--show-current"], { cwd: worker.worktreePath })).stdout.trim();
    const residual = (await runner("git", ["status", "--porcelain"], { cwd: worker.worktreePath })).stdout.trim();
    if (verifiedHead !== worker.headSha || verifiedBranch !== worker.branch || residual) {
      throw new Error(
        `Fresh validation changed the verified reconciliation result for issue #${worker.issue}: ` +
        `${worker.branch || "detached HEAD"}@${worker.headSha} became ${verifiedBranch || "detached HEAD"}@${verifiedHead}` +
        (residual ? ` with residual changes:\n${residual}` : ".")
      );
    }
  }

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

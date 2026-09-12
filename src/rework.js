const { loadRunState, saveRunState } = require("./run-store");
const { runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { runChecked } = require("./process");
const { newRunId } = require("./controller");
const { resolveCurrentIssueStates } = require("./run-resolver");
const { isRecoverableValidatorRework } = require("./run-lifecycle");
const { reserveExplicitWork } = require("./scheduler");

const DEFAULT_AUTO_REWORK_LIMIT = 3;
const DEFAULT_AUTO_REWORK_TIMEOUT_MS = 30 * 60 * 1000;

function remainingTime(deadlineAt) {
  if (!deadlineAt) return null;
  return Math.max(1, deadlineAt - Date.now());
}

function correctionAttempt(state, issue) {
  return state.correction?.attempts?.[String(issue)] || null;
}

async function loadCorrectionLineage(repoPath, sourceRunId, issue, stateLoader = loadRunState) {
  const lineage = [];
  const seen = new Set();
  let runId = String(sourceRunId);
  let rootRunId = runId;

  while (runId) {
    if (seen.has(runId)) throw new Error(`Maestro correction provenance contains a cycle at ${runId}.`);
    seen.add(runId);
    const state = await stateLoader(repoPath, runId);
    rootRunId = runId;
    const attempt = correctionAttempt(state, issue);
    if (attempt) lineage.push({ runId, ...attempt });
    runId = state.parentRunId ? String(state.parentRunId) : null;
  }

  return { rootRunId, attempts: lineage.reverse() };
}

function validationSnapshot(validation) {
  if (!validation) return null;
  return {
    verdict: validation.verdict ?? null,
    exitCode: validation.exitCode ?? null,
    report: validation.report ?? null
  };
}

function resultOutcome(result, issue) {
  const worker = (result.workers || []).find((entry) => String(entry.issue) === String(issue));
  const validation = (result.validations || []).find((entry) => String(entry.issue) === String(issue));
  if (worker?.timedOut) return { status: "timeout", verdict: null, timeoutStage: "worker" };
  if (!worker || worker.exitCode !== 0) return { status: "worker-failure", verdict: null };
  if (worker.headSha === worker.baseSha) return { status: "no-progress", verdict: null };
  if (validation?.timedOut) return { status: "timeout", verdict: null, timeoutStage: "validator" };
  if (!validation) return { status: "validator-failure", verdict: null };
  if (validation.exitCode !== 0 || !["approve", "rework", "human_gate"].includes(validation.verdict)) {
    return { status: "validator-failure", verdict: validation.verdict || null };
  }
  return {
    status: validation.verdict === "approve" ? "approved" : validation.verdict === "human_gate" ? "human-gate" : "rework",
    verdict: validation.verdict
  };
}

async function resolveIssueReworkSources(repoPath, issueIds) {
  const requested = [...new Set((issueIds || []).map(String))];
  const resolved = await resolveCurrentIssueStates(repoPath, requested);
  if (!requested.length) {
    const actionable = resolved.filter((entry) => (
      isRecoverableValidatorRework(entry.evidence)
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

  const refused = resolved.filter((entry) => !isRecoverableValidatorRework(entry.evidence));
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

async function resolveReworkParentRunId(repoPath, sourceRunId, issueIds) {
  const issues = [...new Set((issueIds || []).map(String))];
  if (issues.length !== 1) return sourceRunId;
  const [current] = await resolveCurrentIssueStates(repoPath, issues);
  const correction = current?.evidence?.correction;
  if (
    current?.state?.status === "failed" &&
    correction?.outcome === "technical-conflict" &&
    String(correction.sourceRunId) === String(sourceRunId)
  ) {
    return current.runId;
  }
  return sourceRunId;
}

async function refreshWorker(worker, { defaultBranch = "main", sourceRunId = null, runner = runChecked, deadlineAt = null } = {}) {
  const status = (await runner("git", ["status", "--porcelain"], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) })).stdout.trim();
  if (status) throw new Error(`Rework branch for issue #${worker.issue} is not clean:\n${status}`);
  await runner("git", ["fetch", "origin", defaultBranch], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) });
  await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) }).catch(async (error) => {
    let conflictedFiles = [];
    try {
      const unmerged = await runner("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) });
      conflictedFiles = unmerged.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
    } catch {}
    let operationState = "active";
    let abortError = null;
    try {
      await runner("git", ["rebase", "--abort"], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) });
      operationState = "aborted";
    } catch (abortFailure) {
      abortError = abortFailure.message;
    }
    const continuationAction = sourceRunId
      ? `maestro rework ${worker.issue} --run ${sourceRunId}`
      : `maestro rework ${worker.issue}`;
    const wrapped = new Error(
      `Rework refresh for issue #${worker.issue} failed before its correction worker started. ` +
      `Maestro ${operationState === "aborted" ? "aborted" : "could not abort"} its rebase so the implementation remains at ${worker.worktreePath}. ` +
      `Inspect \`maestro details ${worker.issue}\`; after resolving the refresh safely, run \`${continuationAction}\`. ` +
      `Cause: ${error.message}`
    );
    wrapped.cause = error;
    wrapped.issue = String(worker.issue);
    if (conflictedFiles.length) {
      wrapped.code = "REWORK_REFRESH_CONFLICT";
      wrapped.outcome = "technical-conflict";
      wrapped.conflict = {
        type: "content",
        operation: "rebase",
        operationState,
        interruptedStage: "rework-refresh",
        conflictedFiles,
        worktreePath: worker.worktreePath,
        branch: worker.branch || null,
        originalBaseSha: worker.baseSha || null,
        targetBranch: defaultBranch,
        targetRef: `origin/${defaultBranch}`,
        continuationAction,
        failure: error.message,
        stderr: error.result?.stderr?.trim() || null,
        ...(abortError ? { abortError } : {})
      };
    }
    throw wrapped;
  });
  const baseSha = (await runner("git", ["rev-parse", `origin/${defaultBranch}`], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) })).stdout.trim();
  return { ...worker, baseSha };
}

async function executeReworkRun(config, {
  repoPath,
  sourceRunId,
  parentRunId = sourceRunId,
  issueIds = null,
  runId = newRunId(),
  runner = runChecked,
  preflightRunner,
  baselineRunner,
  workerExecutor = executeWorker,
  validatorExecutor = validateWorker,
  stateSaver = saveRunState,
  stateLoader = loadRunState,
  automatic = false,
  retryLimit = null,
  deadlineAt = null,
  reserveCapacity = false,
  capacityReserver = reserveExplicitWork,
  reservedState = null
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

  const attempts = {};
  for (const worker of candidates) {
    const issue = String(worker.issue);
    const lineage = await loadCorrectionLineage(repoPath, parentRunId, issue, stateLoader);
    attempts[issue] = {
      number: lineage.attempts.length + 1,
      automatic,
      sourceRunId,
      rootRunId: lineage.rootRunId,
      retryLimit,
      chargedAt: "child-run-created-before-preflight",
      phase: "preparing",
      outcome: null,
      trigger: validationSnapshot(validationByIssue.get(issue)),
      implementation: {
        branch: worker.branch || null,
        worktreePath: worker.worktreePath || null,
        baseSha: worker.baseSha || null,
        targetBranch: config.defaultBranch || "main"
      }
    };
  }

  const initialState = {
    runId,
    parentRunId,
    mode: "rework",
    status: "running",
    repoPath,
    plan: { selected: items },
    baseline: null,
    preflights: [],
    workers: [],
    validations: [],
    reviews: {},
    correction: { attempts }
  };
  if (reserveCapacity && !reservedState) {
    const reservation = await capacityReserver(config, {
      repoPath,
      runId,
      mode: "rework",
      items,
      stateLoader: async () => require("./work-state").loadExecutionStates(repoPath),
      stateSaver,
      extraState: { parentRunId, correction: { attempts } }
    });
    if (!reservation.reserved) {
      const error = new Error(`Cannot reserve worker capacity for rework: ${reservation.reason}.`);
      error.code = "CAPACITY_UNAVAILABLE";
      throw error;
    }
    reservedState = reservation.state;
  }
  const result = reservedState ? { ...reservedState, correction: { attempts } } : initialState;
  if (!reservedState) await stateSaver(repoPath, runId, result);

  let currentStage = "preflight";
  try {
    console.error(`[Maestro] rework ${runId} from ${sourceRunId}: capability preflight`);
    result.preflights = await runPreflights(config, items, { cwd: repoPath, runner: preflightRunner, timeoutMs: remainingTime(deadlineAt) });
    currentStage = "baseline";
    console.error(`[Maestro] rework ${runId}: baseline validation`);
    result.baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner, timeoutMs: remainingTime(deadlineAt) });

    const refreshed = [];
    for (const worker of candidates) {
      currentStage = "refresh";
      console.error(`[Maestro] rework #${worker.issue}: rebasing existing implementation onto current ${config.defaultBranch || "main"}`);
      refreshed.push(await refreshWorker(worker, {
        defaultBranch: config.defaultBranch || "main",
        sourceRunId,
        runner,
        deadlineAt
      }));
      result.correction.attempts[String(worker.issue)].phase = "worker-pending";
      await stateSaver(repoPath, runId, result);
    }

    currentStage = "worker";
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
        },
        timeoutMs: remainingTime(deadlineAt)
      });
    }));

    for (const worker of result.workers) {
      result.correction.attempts[String(worker.issue)].phase = worker.exitCode === 0 ? "validation-pending" : "stopped";
    }
    await stateSaver(repoPath, runId, result);

    currentStage = "validator";
    result.validations = await Promise.all(result.workers
      .filter((worker) => worker.exitCode === 0 && worker.headSha !== worker.baseSha)
      .map((worker) => validatorExecutor({
        repository: config.repository,
        worker,
        baseline: result.baseline,
        runId,
        timeoutMs: remainingTime(deadlineAt)
      })));

    const outcomes = candidates.map((worker) => ({
      issue: String(worker.issue),
      ...resultOutcome(result, worker.issue)
    }));
    for (const outcome of outcomes) {
      const attempt = result.correction.attempts[outcome.issue];
      attempt.phase = "completed";
      attempt.outcome = outcome.status;
      attempt.finalVerdict = outcome.verdict;
      if (outcome.timeoutStage) attempt.timeoutStage = outcome.timeoutStage;
    }
    const failed = outcomes.filter((entry) => ["worker-failure", "validator-failure", "timeout", "no-progress"].includes(entry.status));
    result.status = failed.length ? "failed" : "awaiting-review";
    if (failed.length) {
      result.failure = failed.map((entry) => `#${entry.issue} ${entry.status}`).join("; ");
    }
    await stateSaver(repoPath, runId, result);
    return result;
  } catch (error) {
    const timedOut = error.code === "AUTOMATION_TIMEOUT" || error.result?.timedOut || error.cause?.result?.timedOut;
    if (timedOut) {
      error.code = "AUTOMATION_TIMEOUT";
      error.timeoutStage = currentStage;
    }
    result.status = "failed";
    result.failure = error.message;
    for (const [issue, attempt] of Object.entries(result.correction.attempts)) {
      if (attempt.phase !== "completed") {
        attempt.phase = "stopped";
        if (timedOut) {
          attempt.outcome = "timeout";
          attempt.timeoutStage = currentStage;
        } else if (error.code === "REWORK_REFRESH_CONFLICT" && String(error.issue) === issue) {
          attempt.outcome = "technical-conflict";
          attempt.conflict = error.conflict;
        } else {
          attempt.outcome = "infrastructure-failure";
        }
      }
    }
    await stateSaver(repoPath, runId, result);
    throw error;
  }
}

async function autoReworkIssue(config, {
  repoPath,
  issue,
  retryLimit,
  resolver,
  stateLoader,
  stateSaver,
  recordOutcome,
  reworkExecutor,
  reworkOptions,
  now
}) {
  const runs = [];
  for (;;) {
    const [resolved] = await resolver(repoPath, [String(issue)]);
    const evidence = resolved.evidence;
    const worker = evidence.worker;
    const validation = evidence.validation;
    const persistedAutomaticOutcome = evidence.autoRework?.status;

    if (["timeout", "no-progress"].includes(persistedAutomaticOutcome)) {
      return {
        issue: String(issue),
        outcome: persistedAutomaticOutcome,
        finalRunId: resolved.runId,
        finalVerdict: evidence.autoRework.finalVerdict ?? validation?.verdict ?? null,
        ...(evidence.autoRework.timeoutStage ? { timeoutStage: evidence.autoRework.timeoutStage } : {}),
        runs
      };
    }

    if (resolved.state.status === "failed") {
      const persistedOutcome = evidence.correction?.outcome;
      const outcome = ["validator-failure", "worker-failure", "technical-conflict", "timeout", "no-progress"].includes(persistedOutcome)
        ? persistedOutcome
        : "infrastructure-failure";
      await recordOutcome(resolved.runId, issue, {
        status: outcome,
        finalVerdict: validation?.verdict || null
      });
      return { issue: String(issue), outcome, finalRunId: resolved.runId, finalVerdict: validation?.verdict || null, runs };
    }
    if (!worker || worker.exitCode !== 0) {
      await recordOutcome(resolved.runId, issue, { status: "worker-failure", finalVerdict: null });
      return { issue: String(issue), outcome: "worker-failure", finalRunId: resolved.runId, runs };
    }
    if (!validation || validation.exitCode !== 0 || !["approve", "rework", "human_gate"].includes(validation.verdict)) {
      await recordOutcome(resolved.runId, issue, { status: "validator-failure", finalVerdict: validation?.verdict || null });
      return { issue: String(issue), outcome: "validator-failure", finalRunId: resolved.runId, finalVerdict: validation?.verdict || null, runs };
    }
    if (validation.verdict === "approve") {
      await recordOutcome(resolved.runId, issue, { status: "approved", finalVerdict: "approve" });
      return { issue: String(issue), outcome: "approved", finalRunId: resolved.runId, finalVerdict: "approve", runs };
    }
    if (validation.verdict === "human_gate") {
      await recordOutcome(resolved.runId, issue, { status: "human-gate", finalVerdict: "human_gate" });
      return { issue: String(issue), outcome: "human-gate", finalRunId: resolved.runId, finalVerdict: "human_gate", runs };
    }

    const lineage = await loadCorrectionLineage(repoPath, resolved.runId, issue, stateLoader);
    if (lineage.attempts.length >= retryLimit) {
      await recordOutcome(resolved.runId, issue, {
        status: "retry-exhausted",
        attemptsUsed: lineage.attempts.length,
        finalVerdict: "rework"
      });
      return {
        issue: String(issue),
        outcome: "retry-exhausted",
        finalRunId: resolved.runId,
        finalVerdict: "rework",
        attemptsUsed: lineage.attempts.length,
        retryLimit,
        runs
      };
    }

    if (reworkOptions.deadlineAt && now() >= reworkOptions.deadlineAt) {
      await recordOutcome(resolved.runId, issue, {
        status: "timeout",
        attemptsUsed: lineage.attempts.length,
        finalVerdict: "rework",
        timeoutStage: "session"
      });
      return {
        issue: String(issue),
        outcome: "timeout",
        finalRunId: resolved.runId,
        finalVerdict: "rework",
        timeoutStage: "session",
        runs
      };
    }

    const runId = newRunId();
    try {
      const result = await reworkExecutor(config, {
        repoPath,
        sourceRunId: resolved.runId,
        issueIds: [String(issue)],
        runId,
        stateLoader,
        stateSaver,
        automatic: true,
        retryLimit,
        ...reworkOptions
      });
      runs.push(result);
      const outcome = resultOutcome(result, issue);
      if (["worker-failure", "validator-failure", "timeout", "no-progress"].includes(outcome.status)) {
        await recordOutcome(result.runId, issue, {
          status: outcome.status,
          finalVerdict: outcome.verdict,
          timeoutStage: outcome.timeoutStage
        });
        return {
          issue: String(issue),
          outcome: outcome.status,
          finalRunId: result.runId,
          finalVerdict: outcome.verdict,
          ...(outcome.timeoutStage ? { timeoutStage: outcome.timeoutStage } : {}),
          runs
        };
      }
    } catch (error) {
      if (error.code === "CAPACITY_UNAVAILABLE") {
        return {
          issue: String(issue),
          outcome: "capacity-unavailable",
          finalRunId: resolved.runId,
          finalVerdict: "rework",
          error: error.message,
          runs
        };
      }
      const outcome = error.code === "AUTOMATION_TIMEOUT"
        ? "timeout"
        : error.code === "REWORK_REFRESH_CONFLICT" ? "technical-conflict" : "infrastructure-failure";
      await recordOutcome(runId, issue, {
        status: outcome,
        finalVerdict: null,
        timeoutStage: error.timeoutStage
      });
      return {
        issue: String(issue),
        outcome,
        finalRunId: runId,
        error: error.message,
        ...(error.timeoutStage ? { timeoutStage: error.timeoutStage } : {}),
        runs
      };
    }
  }
}

async function autoRework(config, {
  repoPath,
  issueIds,
  retryLimit = DEFAULT_AUTO_REWORK_LIMIT,
  capacity = config.defaultConcurrency || 2,
  resolver = resolveCurrentIssueStates,
  stateLoader = loadRunState,
  stateSaver = saveRunState,
  reworkExecutor = executeReworkRun,
  reworkOptions = {},
  timeoutMs = DEFAULT_AUTO_REWORK_TIMEOUT_MS,
  now = Date.now
} = {}) {
  const issues = [...new Set((issueIds || []).map(String))];
  if (!Number.isInteger(retryLimit) || retryLimit < 1) {
    throw new Error("Automatic rework retry limit must be a positive integer.");
  }
  if (!Number.isInteger(capacity) || capacity < 0) throw new Error("Automatic rework capacity must be a non-negative integer.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Automatic rework timeout must be a positive number of milliseconds.");
  if (!issues.length || capacity === 0) {
    return { mode: "auto-rework", retryLimit, capacity, timeoutMs, issues: [] };
  }

  const deadlineAt = now() + timeoutMs;

  const results = new Array(issues.length);
  let cursor = 0;
  let outcomeWrite = Promise.resolve();
  function recordOutcome(runId, issue, outcome) {
    outcomeWrite = outcomeWrite.then(async () => {
      const state = await stateLoader(repoPath, runId);
      const attempt = correctionAttempt(state, issue);
      state.autoRework = state.autoRework || {};
      state.autoRework[String(issue)] = {
        status: outcome.status,
        retryLimit,
        attemptsUsed: outcome.attemptsUsed ?? attempt?.number ?? 0,
        finalVerdict: outcome.finalVerdict ?? null,
        ...(outcome.timeoutStage ? { timeoutStage: outcome.timeoutStage } : {}),
        action: outcome.action || (["approved"].includes(outcome.status)
          ? `maestro approve ${issue}`
          : outcome.status === "human-gate"
            ? `maestro review --run ${runId} --issue ${issue} --disposition rework-original`
            : `maestro details ${issue}`)
      };
      await stateSaver(repoPath, runId, state);
    });
    return outcomeWrite;
  }
  async function runNext() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= issues.length) return;
      results[index] = await autoReworkIssue(config, {
        repoPath,
        issue: issues[index],
        retryLimit,
        resolver,
        stateLoader,
        stateSaver,
        recordOutcome,
        reworkExecutor,
        reworkOptions: { ...reworkOptions, deadlineAt },
        now
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(capacity, issues.length) }, () => runNext()));
  return { mode: "auto-rework", retryLimit, capacity, timeoutMs, issues: results };
}

module.exports = {
  DEFAULT_AUTO_REWORK_LIMIT,
  DEFAULT_AUTO_REWORK_TIMEOUT_MS,
  resolveIssueReworkSources,
  resolveReworkParentRunId,
  refreshWorker,
  loadCorrectionLineage,
  resultOutcome,
  executeReworkRun,
  autoRework
};

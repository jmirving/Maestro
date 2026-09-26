const fs = require("node:fs/promises");
const path = require("node:path");
const { loadRunState, saveRunState } = require("./run-store");
const { resolveConcurrency } = require("./concurrency");
const { runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { runChecked } = require("./process");
const { newRunId } = require("./controller");
const { resolveCurrentIssueStates, runDescendsFrom } = require("./run-resolver");
const { isRecoverableValidatorRework } = require("./run-lifecycle");
const { reserveExplicitWork } = require("./scheduler");
const { commitLifecycleTransition } = require("./lifecycle-coordination");
const { selectReady } = require("./planner");
const { loadExecutionStates, unresolvedWork } = require("./work-state");
const { boundedText, executeConflictResolver } = require("./conflict-resolver");
const { bindValidation } = require("./authorization");
const { isValidHumanGateResolution } = require("./reviews");

const DEFAULT_AUTO_REWORK_LIMIT = 3;
const DEFAULT_AUTO_REWORK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CONFLICT_RESOLUTION_TIMEOUT_MS = 10 * 60 * 1000;

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

  const resumable = (entry) => {
    const correction = entry.evidence?.correction;
    const conflict = entry.evidence?.conflict;
    return entry.state?.mode === "rework" &&
      entry.state?.status === "failed" &&
      correction &&
      ["technical-conflict", "human-required"].includes(correction.outcome) &&
      conflict?.interruptedStage === "rework-refresh" &&
      !["completed", "resolved", "manually-resolved"].includes(conflict.operationState);
  };
  const refused = resolved.filter((entry) => !isRecoverableValidatorRework(entry.evidence) && !resumable(entry));
  if (refused.length) {
    const details = refused
      .map((entry) => `#${entry.issue} (${entry.evidence.state || "unknown"} in run ${entry.runId})`)
      .join(", ");
    throw new Error(`Cannot rework the current workflow state for ${details}.`);
  }

  const grouped = new Map();
  for (const entry of resolved) {
    const correction = entry.evidence?.correction;
    const sourceRunId = resumable(entry) ? String(correction.sourceRunId) : entry.runId;
    const key = resumable(entry) ? `resume:${entry.runId}` : `source:${sourceRunId}`;
    if (!grouped.has(key)) grouped.set(key, {
      sourceRunId,
      ...(resumable(entry) ? { parentRunId: entry.state.parentRunId, resumeRunId: entry.runId } : {}),
      issueIds: []
    });
    grouped.get(key).issueIds.push(entry.issue);
  }
  return [...grouped.values()];
}

async function resolveReworkParentRunId(repoPath, sourceRunId, issueIds) {
  const issues = [...new Set((issueIds || []).map(String))];
  if (issues.length !== 1) return sourceRunId;
  const [current] = await resolveCurrentIssueStates(repoPath, issues);
  const correction = current?.evidence?.correction;
  const descendsFromSource = String(current?.runId) === String(sourceRunId) ||
    await runDescendsFrom(repoPath, current?.state, sourceRunId);
  if (
    descendsFromSource &&
    current?.state?.status === "failed" &&
    ["technical-conflict", "human-required"].includes(correction?.outcome) &&
    String(correction.sourceRunId) === String(sourceRunId)
  ) {
    throw new Error(
      `Run ${sourceRunId} has a current interrupted correction for issue #${current.issue} in ${current.runId}. ` +
      `Resume authoritative current state with \`maestro rework ${current.issue}\`; --run is only for explicit historical selection.`
    );
  }
  if (String(current?.runId) !== String(sourceRunId)) {
    throw new Error(
      `Cannot rework superseded implementation evidence from run ${sourceRunId}: ` +
      `#${current.issue} is current in ${current.runId} (${current.evidence?.state || "unknown"}).`
    );
  }
  return sourceRunId;
}

async function gitOutput(runner, args, options) {
  return (await runner("git", args, options)).stdout.trim();
}

async function captureOptionalGitOutput(runner, args, options) {
  try {
    return await gitOutput(runner, args, options);
  } catch {
    return null;
  }
}

async function gitPathState(runner, worktreePath, relativePath, options) {
  const gitPath = await captureOptionalGitOutput(runner, ["rev-parse", "--git-path", relativePath], options);
  if (!gitPath) return { exists: false, value: null };
  const resolvedPath = path.isAbsolute(gitPath) ? gitPath : path.resolve(worktreePath, gitPath);
  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) return { exists: true, value: null };
    return { exists: true, value: (await fs.readFile(resolvedPath, "utf8")).trim() || null };
  } catch {
    return { exists: false, value: null };
  }
}

async function captureRebaseOperationState(worker, conflict, { runner, deadlineAt }) {
  const options = { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) };
  const mergeState = await gitPathState(runner, worker.worktreePath, "rebase-merge", options);
  const applyState = mergeState.exists
    ? { exists: false }
    : await gitPathState(runner, worker.worktreePath, "rebase-apply", options);
  const kind = mergeState.exists ? "merge" : applyState.exists ? "apply" : null;
  const statePath = kind ? `rebase-${kind}` : null;
  const readState = async (name) => statePath
    ? (await gitPathState(runner, worker.worktreePath, `${statePath}/${name}`, options)).value
    : null;
  const gitStatus = boundedText(await captureOptionalGitOutput(runner, ["status", "--porcelain=v2", "--branch"], options), 12000);
  const conflictedFiles = (await captureOptionalGitOutput(runner, ["diff", "--name-only", "--diff-filter=U"], options) || "")
    .split("\n").map((entry) => entry.trim()).filter(Boolean);
  let targetAncestor = false;
  try {
    await runner("git", ["merge-base", "--is-ancestor", conflict.targetSha, "HEAD"], options);
    targetAncestor = true;
  } catch {}
  return {
    active: Boolean(kind),
    kind,
    rebaseHeadSha: await captureOptionalGitOutput(runner, ["rev-parse", "-q", "--verify", "REBASE_HEAD"], options),
    originalHeadSha: await readState("orig-head"),
    ontoSha: await readState("onto"),
    headName: await readState("head-name"),
    currentHeadSha: await captureOptionalGitOutput(runner, ["rev-parse", "HEAD"], options),
    branch: await captureOptionalGitOutput(runner, ["branch", "--show-current"], options),
    conflictedFiles,
    gitStatus,
    worktreeClean: gitStatus !== null && !gitStatus.split("\n").some((line) => line && !line.startsWith("#")),
    targetAncestor,
    reflogSubject: await captureOptionalGitOutput(runner, ["reflog", "-1", "--format=%gs"], options)
  };
}

function assessExpectedRebase(conflict, actual) {
  const expectedHeadName = conflict.branch ? `refs/heads/${conflict.branch}` : null;
  if (actual.active) {
    const missing = [];
    if (!actual.rebaseHeadSha) missing.push("REBASE_HEAD");
    if (!actual.originalHeadSha) missing.push("original head");
    if (!actual.ontoSha) missing.push("target");
    if (expectedHeadName && !actual.headName) missing.push("branch");
    if (missing.length) {
      return { state: "unrecoverable", recoverable: false, expectedRebasePresent: false, reason: `active rebase is missing ${missing.join(", ")} metadata` };
    }
    const mismatches = [];
    if (actual.originalHeadSha !== conflict.sourceSha) mismatches.push("original head");
    if (actual.ontoSha !== conflict.targetSha) mismatches.push("target");
    if (expectedHeadName && actual.headName !== expectedHeadName) mismatches.push("branch");
    return mismatches.length
      ? { state: "replaced", recoverable: false, expectedRebasePresent: false, reason: `active rebase has a different ${mismatches.join(", ")}` }
      : { state: "active", recoverable: true, expectedRebasePresent: true, reason: null };
  }
  if (actual.targetAncestor && actual.worktreeClean && (!conflict.branch || actual.branch === conflict.branch)) {
    return { state: "completed-unverified", recoverable: false, expectedRebasePresent: false, reason: "the expected rebase is no longer active and its result was not accepted" };
  }
  if (/^rebase \(abort\):/.test(actual.reflogSubject || "") ||
      (actual.currentHeadSha === conflict.sourceSha && (!conflict.branch || actual.branch === conflict.branch))) {
    return { state: "aborted", recoverable: false, expectedRebasePresent: false, reason: "the resolver aborted or reset away the expected rebase" };
  }
  if (!actual.branch) {
    return { state: "detached", recoverable: false, expectedRebasePresent: false, reason: "the expected rebase is gone and HEAD is detached" };
  }
  if (conflict.branch && actual.branch !== conflict.branch) {
    return { state: "branch-changed", recoverable: false, expectedRebasePresent: false, reason: `the expected rebase is gone and branch changed to ${actual.branch}` };
  }
  return { state: "reset-or-replaced", recoverable: false, expectedRebasePresent: false, reason: "the resolver reset, replaced, or otherwise destroyed the expected rebase" };
}

function resolutionFailure(worker, conflict, resolution, sourceRunId) {
  const continuationAction = `maestro rework ${worker.issue}`;
  const semantic = resolution.status === "human-required";
  const reason = semantic
    ? "reported a semantic ambiguity that requires a human decision"
    : "could not safely complete and verify the active rebase";
  const active = conflict.operationState === "active";
  const recovery = active
    ? `The expected rebase remains active in ${worker.worktreePath}. Supported retry after resolving it: \`${continuationAction}\`.`
    : `The expected rebase is no longer safely active in ${worker.worktreePath} (${conflict.operationState}). Do not assume it can be continued; inspect preserved evidence before recovering or retrying.`;
  const error = new Error(
    `Rework refresh for issue #${worker.issue} encountered a content conflict and its bounded resolver ${reason}. ` +
    `${recovery} Inspect \`maestro details ${worker.issue}\` and the worktree before continuing.`
  );
  error.code = "REWORK_REFRESH_CONFLICT";
  error.outcome = "human-required";
  error.issue = String(worker.issue);
  error.conflict = conflict;
  return error;
}

async function verifyResolvedRebase(worker, conflict, { runner, deadlineAt }) {
  const options = { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) };
  await runner("git", ["merge-base", "--is-ancestor", conflict.targetSha, "HEAD"], options);
  const status = await gitOutput(runner, ["status", "--porcelain"], options);
  if (status) throw new Error(`worktree is not clean:\n${status}`);
  const branch = await gitOutput(runner, ["branch", "--show-current"], options);
  if (conflict.branch && branch !== conflict.branch) {
    throw new Error(`expected branch ${conflict.branch}, found ${branch || "detached HEAD"}`);
  }
  const aheadCount = Number(await gitOutput(runner, ["rev-list", "--count", `${conflict.targetSha}..HEAD`], options));
  const retainedFiles = (await gitOutput(runner, ["diff", "--name-only", conflict.targetSha, "HEAD"], options))
    .split("\n").map((entry) => entry.trim()).filter(Boolean);
  const allowedFiles = new Set([...(conflict.implementationFiles || []), ...conflict.conflictedFiles]);
  const unexpectedFiles = retainedFiles.filter((entry) => !allowedFiles.has(entry));
  const retainedImplementationFiles = retainedFiles.filter((entry) => (conflict.implementationFiles || []).includes(entry));
  if (!Number.isInteger(aheadCount) || aheadCount < 1 || !retainedFiles.length) {
    throw new Error("the rebased branch no longer contains a retained implementation beyond the target");
  }
  if (!retainedImplementationFiles.length) {
    throw new Error("none of the original implementation files remain changed beyond the target");
  }
  if (unexpectedFiles.length) {
    throw new Error(`resolver changed files outside the retained implementation: ${unexpectedFiles.join(", ")}`);
  }
  return {
    verified: true,
    targetAncestor: true,
    worktreeClean: true,
    branch,
    aheadCount,
    retainedFiles,
    retainedImplementationFiles,
    headSha: await gitOutput(runner, ["rev-parse", "HEAD"], options)
  };
}

async function refreshWorker(worker, {
  repository = null,
  issueContext = {},
  priorWorkerReport = "",
  validatorReport = "",
  runId = "unknown",
  defaultBranch = "main",
  sourceRunId = null,
  runner = runChecked,
  conflictResolver = executeConflictResolver,
  onConflictEvidence = async () => {},
  deadlineAt = null
} = {}) {
  const options = { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) };
  const status = (await runner("git", ["status", "--porcelain"], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) })).stdout.trim();
  if (status) throw new Error(`Rework branch for issue #${worker.issue} is not clean:\n${status}`);
  await runner("git", ["fetch", "origin", defaultBranch], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) });
  const sourceSha = await gitOutput(runner, ["rev-parse", "HEAD"], options);
  const targetRef = `origin/${defaultBranch}`;
  const targetSha = await gitOutput(runner, ["rev-parse", targetRef], options);
  const originalBaseSha = worker.baseSha || await gitOutput(runner, ["merge-base", sourceSha, targetSha], options);
  const retainedDiff = await gitOutput(runner, ["diff", "--binary", originalBaseSha, sourceSha], options);
  const implementationFiles = (await gitOutput(runner, ["diff", "--name-only", originalBaseSha, sourceSha], options))
    .split("\n").map((entry) => entry.trim()).filter(Boolean);
  await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) }).catch(async (error) => {
    let conflictedFiles = [];
    try {
      const unmerged = await runner("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: worker.worktreePath, timeoutMs: remainingTime(deadlineAt) });
      conflictedFiles = unmerged.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
    } catch {}
    if (!conflictedFiles.length) throw error;
    const continuationAction = `maestro rework ${worker.issue}`;
    const targetDiff = await captureOptionalGitOutput(runner, ["diff", "--binary", originalBaseSha, targetSha, "--", ...conflictedFiles], options);
    const conflict = {
      contractVersion: 1,
      type: "content",
      repository,
      issue: String(worker.issue),
      sourceRunId: sourceRunId == null ? null : String(sourceRunId),
      operation: "rebase",
      operationOwner: "maestro",
      operationState: "active",
      resolutionState: "resolving-in-place",
      requiresSemanticHumanDecision: false,
      interruptedStage: "rework-refresh",
      interruptedAction: "validator correction refresh",
      conflictedFiles,
      worktreePath: worker.worktreePath,
      branch: worker.branch || null,
      originalBaseSha,
      sourceSha,
      implementationFiles,
      targetBranch: defaultBranch,
      targetRef,
      targetSha,
      rebaseHeadSha: null,
      gitStatus: null,
      retainedDiff: boundedText(retainedDiff),
      targetDiff: boundedText(targetDiff),
      continuationAction,
      failure: error.message,
      stderr: error.result?.stderr?.trim() || null,
      resolution: { status: "pending" }
    };
    const beforeResolver = await captureRebaseOperationState(worker, conflict, { runner, deadlineAt });
    conflict.rebaseHeadSha = beforeResolver.rebaseHeadSha;
    conflict.gitStatus = beforeResolver.gitStatus;
    conflict.statusEvidence = beforeResolver.gitStatus;
    conflict.operationOriginalHeadSha = beforeResolver.originalHeadSha;
    conflict.operationCurrentHeadSha = beforeResolver.currentHeadSha;
    conflict.operationHeadSha = beforeResolver.rebaseHeadSha;
    conflict.operationOntoSha = beforeResolver.ontoSha;
    conflict.preservation = {
      existingUserEditsPreserved: false,
      partialResolutionsPreserved: false,
      recoveryArtifacts: []
    };
    conflict.operationEvidence = { beforeResolver };
    await onConflictEvidence(conflict);
    let resolution;
    try {
      resolution = await conflictResolver({
        repository,
        issue: String(worker.issue),
        issueContext,
        priorWorkerReport,
        validatorReport,
        conflict,
        worktreePath: worker.worktreePath,
        runId,
        timeoutMs: Math.min(remainingTime(deadlineAt) || DEFAULT_CONFLICT_RESOLUTION_TIMEOUT_MS, DEFAULT_CONFLICT_RESOLUTION_TIMEOUT_MS)
      });
    } catch (resolverError) {
      resolution = { status: "failed", report: "", stderr: resolverError.message, thrown: true };
    }
    if (!resolution || !["resolved", "human-required", "failed"].includes(resolution.status)) {
      resolution = {
        status: "failed",
        report: resolution?.report || "",
        stderr: resolution?.stderr || `Resolver returned unsupported status: ${resolution?.status || "missing"}`
      };
    }
    conflict.resolution = {
      status: resolution.status,
      exitCode: resolution.exitCode ?? null,
      timedOut: resolution.timedOut === true,
      reportPath: resolution.reportPath || null,
      report: resolution.report || null,
      stderr: resolution.stderr || null
    };
    if (resolution.status === "resolved") {
      try {
        conflict.resolution.verification = await verifyResolvedRebase(worker, conflict, { runner, deadlineAt });
        conflict.operationState = "completed";
        conflict.resolutionState = "verified-awaiting-fresh-validation";
        conflict.resolutionVerifiedAgainstSha = conflict.targetSha;
        await onConflictEvidence(conflict);
        return;
      } catch (verificationError) {
        conflict.resolution.status = "failed";
        conflict.resolution.verification = { verified: false, failure: verificationError.message };
      }
    }
    const afterResolver = await captureRebaseOperationState(worker, conflict, { runner, deadlineAt });
    const operationVerification = assessExpectedRebase(conflict, afterResolver);
    conflict.operationEvidence.afterResolver = afterResolver;
    conflict.operationEvidence.verification = operationVerification;
    conflict.operationState = operationVerification.state;
    conflict.requiresSemanticHumanDecision = resolution.status === "human-required";
    conflict.resolutionState = resolution.status === "human-required"
      ? "requires-semantic-human-decision"
      : "awaiting-technical-resolution";
    await onConflictEvidence(conflict);
    throw resolutionFailure(worker, conflict, conflict.resolution, sourceRunId);
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
  conflictResolver = executeConflictResolver,
  stateSaver = saveRunState,
  stateLoader = loadRunState,
  executionStateLoader = loadExecutionStates,
  automatic = false,
  retryLimit = null,
  deadlineAt = null,
  reserveCapacity = false,
  capacityReserver = reserveExplicitWork,
  reservedState = null,
  concurrency = null
} = {}) {
  const resumedState = reservedState?.runId === runId && reservedState?.correction?.attempts
    ? reservedState
    : null;
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
      const validation = validationByIssue.get(issue);
      const review = source.reviews?.[issue];
      const validationRequiresRework = validation?.verdict === "rework";
      const humanRequestedRework = review?.disposition === "rework-original" ||
        isValidHumanGateResolution(review, validation, ["rework"]);
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
  const eligibleCandidates = (source.workers || []).filter((worker) => {
    const issue = String(worker.issue);
    const validation = validationByIssue.get(issue);
    const review = source.reviews?.[issue];
    const validationRequiresRework = validation?.verdict === "rework";
    const humanRequestedRework = review?.disposition === "rework-original" ||
      isValidHumanGateResolution(review, validation, ["rework"]);
    return (!requested || requested.has(issue)) && (validationRequiresRework || humanRequestedRework);
  });
  if (!eligibleCandidates.length) throw new Error(`Run ${sourceRunId} has no selected REWORK issues.`);
  const concurrencySetting = concurrency?.value
    ? concurrency
    : resolveConcurrency({ savedDefault: config.defaultConcurrency });
  const reservedIssues = reservedState?.plan?.selected
    ? new Set(reservedState.plan.selected.map((item) => String(item.id)))
    : null;
  const eligibleItems = eligibleCandidates.map((worker) => {
    const configured = config.work?.[String(worker.issue)] || {};
    return { id: String(worker.issue), ...configured, mode: "rework" };
  });
  let advisoryDeferred = [];
  let selectedItems;
  if (reservedIssues) {
    selectedItems = eligibleItems.filter((item) => reservedIssues.has(item.id));
  } else {
    const states = await executionStateLoader(repoPath);
    const activeIssues = [...unresolvedWork(states, config).values()]
      .filter((item) => ["running", "rework-running"].includes(item.state))
      .map((item) => item.issue);
    const selection = selectReady(
      eligibleItems,
      Math.max(0, concurrencySetting.value - activeIssues.length),
      config.planning?.advisoryConflicts || [],
      activeIssues
    );
    selectedItems = selection.selected;
    advisoryDeferred = selection.advisoryDeferred;
  }
  if (!selectedItems.length) {
    const error = new Error("Cannot start selected rework because repository capacity is exhausted or every available item has an advisory conflict with active work.");
    error.code = "CAPACITY_UNAVAILABLE";
    throw error;
  }
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const candidates = eligibleCandidates.filter((worker) => selectedIds.has(String(worker.issue)));
  const items = candidates.map((worker) => selectedItems.find((item) => item.id === String(worker.issue)));

  const attempts = resumedState?.correction?.attempts || {};
  for (const worker of candidates) {
    const issue = String(worker.issue);
    if (attempts[issue]) {
      attempts[issue].phase = "preparing-resume";
      delete attempts[issue].finalVerdict;
      continue;
    }
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
      ...(source.reviews?.[issue]?.humanGateResolution ? {
        humanDecision: {
          disposition: source.reviews[issue].disposition,
          notes: source.reviews[issue].notes,
          recordedAt: source.reviews[issue].recordedAt || null
        }
      } : {}),
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
    plan: {
      concurrency: concurrencySetting.value,
      concurrencySource: concurrencySetting.source,
      savedDefaultConcurrency: concurrencySetting.savedDefault,
      ready: eligibleCandidates.map((worker) => ({ id: String(worker.issue), mode: "rework" })),
      selected: items,
      advisoryDeferred
    },
    baseline: null,
    preflights: [],
    workers: [],
    validations: [],
    reviews: {},
    correction: { attempts },
    ...(source.authorization?.allowedActions?.correct === true ? { authorization: source.authorization } : {})
  };
  if (reserveCapacity && !reservedState) {
    const reservation = await capacityReserver(config, {
      repoPath,
      runId,
      mode: "rework",
      items,
      planOptions: { concurrency: concurrencySetting },
      stateLoader: async () => require("./work-state").loadExecutionStates(repoPath),
      stateSaver,
      extraState: {
        parentRunId,
        correction: { attempts },
        ...(source.authorization?.allowedActions?.correct === true ? { authorization: source.authorization } : {})
      }
    });
    if (!reservation.reserved) {
      const error = new Error(`Cannot reserve worker capacity for rework: ${reservation.reason}.`);
      error.code = "CAPACITY_UNAVAILABLE";
      throw error;
    }
    reservedState = reservation.state;
  }
  const result = reservedState
    ? Object.assign(reservedState, { parentRunId, correction: { attempts } })
    : initialState;
  result.status = "running";
  delete result.failure;
  if (resumedState) {
    result.workers = [];
    result.validations = [];
    for (const issue of Object.keys(attempts)) {
      if (result.autoRework) delete result.autoRework[issue];
    }
  }
  if (!reservedState) await stateSaver(repoPath, runId, result);

  async function persistTerminalState() {
    if (stateSaver !== saveRunState) {
      if (result.capacity?.issues) result.capacity.issues = [];
      await stateSaver(repoPath, runId, result);
      return;
    }
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
  }

  let currentStage = "preflight";
  try {
    console.error(`[Maestro] rework ${runId} from ${sourceRunId}: capability preflight`);
    result.preflights = await runPreflights(config, items, { cwd: repoPath, runner: preflightRunner, timeoutMs: remainingTime(deadlineAt) });
    currentStage = "baseline";
    console.error(`[Maestro] rework ${runId}: baseline validation`);
    result.baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner, timeoutMs: remainingTime(deadlineAt) });

    const refreshed = [];
    for (const worker of candidates) {
      const issue = String(worker.issue);
      const configuredIssue = config.work?.[issue] || {};
      const selectedIssue = (source.plan?.selected || []).find((entry) => String(entry.id) === issue) || {};
      const issueContext = {
        title: selectedIssue.title || configuredIssue.title || configuredIssue.github?.title || null,
        body: selectedIssue.body || configuredIssue.body || null
      };
      const priorValidation = validationByIssue.get(issue);
      const persistedConflict = resumedState?.correction?.attempts?.[issue]?.conflict || null;
      let refreshInput = worker;
      if (persistedConflict) {
        currentStage = "manual-recovery-verification";
        console.error(`[Maestro] rework #${worker.issue}: verifying completed manual conflict recovery`);
        let verification;
        try {
          verification = await verifyResolvedRebase(worker, persistedConflict, { runner, deadlineAt });
        } catch (verificationError) {
          persistedConflict.resolutionState = "awaiting-manual-completion";
          persistedConflict.manualVerificationFailure = verificationError.message;
          const recoveryError = new Error(
            `Manual conflict recovery for issue #${worker.issue} is not complete or valid: ${verificationError.message}. ` +
            `Inspect \`maestro details ${worker.issue}\`, finish the recorded Git operation, and retry \`maestro rework ${worker.issue}\`.`
          );
          recoveryError.code = "REWORK_REFRESH_CONFLICT";
          recoveryError.outcome = persistedConflict.requiresSemanticHumanDecision ? "human-required" : "technical-conflict";
          recoveryError.issue = issue;
          recoveryError.conflict = persistedConflict;
          throw recoveryError;
        }
        result.correction.attempts[issue].outcome = null;
        persistedConflict.operationState = "manually-resolved";
        persistedConflict.resolutionState = "verified-awaiting-refresh";
        persistedConflict.resolvedHeadSha = verification.headSha;
        persistedConflict.resolutionVerifiedAgainstSha = persistedConflict.targetSha;
        persistedConflict.resolution = {
          ...(persistedConflict.resolution || {}),
          verification,
          resumedBy: "manual-recovery"
        };
        refreshInput = { ...worker, baseSha: persistedConflict.targetSha, headSha: verification.headSha };
        await stateSaver(repoPath, runId, result);
      }
      currentStage = "refresh";
      console.error(`[Maestro] rework #${worker.issue}: rebasing existing implementation onto current ${config.defaultBranch || "main"}`);
      refreshed.push(await refreshWorker(refreshInput, {
        repository: config.repository,
        issueContext,
        priorWorkerReport: worker.report || "",
        validatorReport: priorValidation?.report || "",
        runId,
        defaultBranch: config.defaultBranch || "main",
        sourceRunId,
        runner,
        conflictResolver,
        onConflictEvidence: async (conflict) => {
          const attempt = result.correction.attempts[issue];
          attempt.phase = conflict.resolution?.status === "pending" ? "resolving-refresh-conflict" : "refresh";
          attempt.conflict = conflict;
          await stateSaver(repoPath, runId, result);
        },
        deadlineAt
      }));
      result.correction.attempts[issue].phase = "worker-pending";
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
          validatorReport: priorValidation?.report || "",
          humanDecision: source.reviews?.[issue]?.humanGateResolution
            ? source.reviews[issue].notes
            : null
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
      .map(async (worker) => bindValidation(config, worker, await validatorExecutor({
        repository: config.repository,
        worker,
        baseline: result.baseline,
        runId,
        timeoutMs: remainingTime(deadlineAt)
      }), { scopeRevision: result.authorization?.scope?.revision })));

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
    await persistTerminalState();
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
          attempt.outcome = error.outcome || "human-required";
          attempt.conflict = error.conflict;
        } else {
          attempt.outcome = "infrastructure-failure";
        }
      }
    }
    await persistTerminalState();
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
  initialReservation,
  now
}) {
  const runs = [];
  let prepared = initialReservation || null;
  async function finishWithoutExecution(result, reason) {
    if (prepared?.reservedState) {
      const reservation = await stateLoader(repoPath, prepared.runId);
      if (reservation.status === "running") {
        const release = (current) => {
          if (current.capacity?.issues) {
            current.capacity.issues = current.capacity.issues
              .filter((entry) => String(entry) !== String(issue));
          }
          current.status = "cancelled";
          current.reservationRelease = {
            issue: String(issue),
            reason,
            releasedAt: new Date().toISOString()
          };
          return current;
        };
        if (stateSaver === saveRunState && stateLoader === loadRunState) {
          await commitLifecycleTransition({
            repoPath,
            runId: prepared.runId,
            issueIds: [issue],
            mutate: release
          });
        } else {
          await stateSaver(repoPath, prepared.runId, release(reservation));
        }
      }
      prepared = null;
    }
    return result;
  }
  for (;;) {
    const [resolved] = prepared?.resolved
      ? [prepared.resolved]
      : await resolver(repoPath, [String(issue)]);
    const evidence = resolved.evidence;
    const worker = evidence.worker;
    const validation = evidence.validation;
    const persistedAutomaticOutcome = evidence.autoRework?.status;

    if (["timeout", "no-progress"].includes(persistedAutomaticOutcome)) {
      return finishWithoutExecution({
        issue: String(issue),
        outcome: persistedAutomaticOutcome,
        finalRunId: resolved.runId,
        finalVerdict: evidence.autoRework.finalVerdict ?? validation?.verdict ?? null,
        ...(evidence.autoRework.timeoutStage ? { timeoutStage: evidence.autoRework.timeoutStage } : {}),
        runs
      }, `persisted-${persistedAutomaticOutcome}`);
    }

    if (resolved.state.status === "failed") {
      const persistedOutcome = evidence.correction?.outcome;
      const outcome = ["validator-failure", "worker-failure", "technical-conflict", "human-required", "timeout", "no-progress"].includes(persistedOutcome)
        ? persistedOutcome
        : "infrastructure-failure";
      await recordOutcome(resolved.runId, issue, {
        status: outcome,
        finalVerdict: validation?.verdict || null
      });
      return finishWithoutExecution(
        { issue: String(issue), outcome, finalRunId: resolved.runId, finalVerdict: validation?.verdict || null, runs },
        `current-${outcome}`
      );
    }
    if (!worker || worker.exitCode !== 0) {
      await recordOutcome(resolved.runId, issue, { status: "worker-failure", finalVerdict: null });
      return finishWithoutExecution(
        { issue: String(issue), outcome: "worker-failure", finalRunId: resolved.runId, runs },
        "current-worker-failure"
      );
    }
    if (!validation || validation.exitCode !== 0 || !["approve", "rework", "human_gate"].includes(validation.verdict)) {
      await recordOutcome(resolved.runId, issue, { status: "validator-failure", finalVerdict: validation?.verdict || null });
      return finishWithoutExecution({
        issue: String(issue), outcome: "validator-failure", finalRunId: resolved.runId,
        finalVerdict: validation?.verdict || null, runs
      }, "current-validator-failure");
    }
    if (validation.verdict === "approve") {
      await recordOutcome(resolved.runId, issue, { status: "approved", finalVerdict: "approve" });
      return finishWithoutExecution(
        { issue: String(issue), outcome: "approved", finalRunId: resolved.runId, finalVerdict: "approve", runs },
        "current-approved"
      );
    }
    if (validation.verdict === "human_gate") {
      await recordOutcome(resolved.runId, issue, { status: "human-gate", finalVerdict: "human_gate" });
      return finishWithoutExecution({
        issue: String(issue), outcome: "human-gate", finalRunId: resolved.runId,
        finalVerdict: "human_gate", runs
      }, "current-human-gate");
    }

    const lineage = await loadCorrectionLineage(repoPath, resolved.runId, issue, stateLoader);
    if (lineage.attempts.length >= retryLimit) {
      await recordOutcome(resolved.runId, issue, {
        status: "retry-exhausted",
        attemptsUsed: lineage.attempts.length,
        finalVerdict: "rework"
      });
      return finishWithoutExecution({
        issue: String(issue),
        outcome: "retry-exhausted",
        finalRunId: resolved.runId,
        finalVerdict: "rework",
        attemptsUsed: lineage.attempts.length,
        retryLimit,
        runs
      }, "retry-exhausted");
    }

    if (reworkOptions.deadlineAt && now() >= reworkOptions.deadlineAt) {
      await recordOutcome(resolved.runId, issue, {
        status: "timeout",
        attemptsUsed: lineage.attempts.length,
        finalVerdict: "rework",
        timeoutStage: "session"
      });
      return finishWithoutExecution({
        issue: String(issue),
        outcome: "timeout",
        finalRunId: resolved.runId,
        finalVerdict: "rework",
        timeoutStage: "session",
        runs
      }, "session-timeout");
    }

    const runId = prepared?.runId || newRunId();
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
        ...(prepared?.reservedState ? { reservedState: prepared.reservedState } : {}),
        ...reworkOptions
      });
      prepared = null;
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
        return finishWithoutExecution({
          issue: String(issue),
          outcome: "capacity-unavailable",
          finalRunId: resolved.runId,
          finalVerdict: "rework",
          error: error.message,
          runs
        }, "capacity-unavailable");
      }
      const outcome = error.code === "AUTOMATION_TIMEOUT"
        ? "timeout"
        : error.code === "REWORK_REFRESH_CONFLICT" ? (error.outcome || "human-required") : "infrastructure-failure";
      await recordOutcome(runId, issue, {
        status: outcome,
        finalVerdict: null,
        timeoutStage: error.timeoutStage
      });
      return finishWithoutExecution({
        issue: String(issue),
        outcome,
        finalRunId: runId,
        error: error.message,
        ...(error.timeoutStage ? { timeoutStage: error.timeoutStage } : {}),
        runs
      }, `execution-${outcome}`);
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
  initialReservations = {},
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
        initialReservation: initialReservations[String(issues[index])] || null,
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
  DEFAULT_CONFLICT_RESOLUTION_TIMEOUT_MS,
  resolveIssueReworkSources,
  resolveReworkParentRunId,
  refreshWorker,
  loadCorrectionLineage,
  resultOutcome,
  executeReworkRun,
  autoRework
};

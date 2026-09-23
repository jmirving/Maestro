const { isValidValidatorOverride, isValidHumanGateResolution } = require("./reviews");
const { retryableValidationFailure } = require("./validator");

function isRecoverableValidatorRework(evidence) {
  const reviewDisposition = evidence?.review?.disposition;
  const humanRequestedRework = reviewDisposition === "rework-original";
  const validatorRequestedRework = evidence?.verdict === "rework" &&
    (!evidence?.review || humanRequestedRework);
  const resolvedHumanGate = evidence?.verdict === "human_gate" &&
    isValidHumanGateResolution(evidence.review, evidence.validation, ["rework"]);
  return ["awaiting-rework", "rework-exhausted"].includes(evidence?.state) &&
    (humanRequestedRework || validatorRequestedRework || resolvedHumanGate);
}

const RESUMABLE_REWORK_SETUP_STAGES = new Set(["preflight", "baseline"]);

function isSafelyResumableReworkSetup(state, evidence) {
  const correction = evidence?.correction;
  if (
    state?.mode !== "rework" ||
    state?.status !== "failed" ||
    !correction?.sourceRunId ||
    !Number.isInteger(correction?.number) || correction.number < 1 ||
    !["infrastructure-failure", "timeout"].includes(correction?.outcome) ||
    correction?.phase !== "stopped" ||
    evidence?.worker ||
    evidence?.validation
  ) return false;

  const failureStage = correction.failureStage || state.failureStage || null;
  if (failureStage) {
    return RESUMABLE_REWORK_SETUP_STAGES.has(failureStage) &&
      correction.workerExecution?.status === "not-started";
  }

  if (RESUMABLE_REWORK_SETUP_STAGES.has(correction.timeoutStage)) {
    return correction.workerExecution === undefined &&
      Array.isArray(state.workers) && state.workers.length === 0 &&
      Array.isArray(state.validations) && state.validations.length === 0;
  }

  // Runs persisted before failureStage/workerExecution were introduced can
  // still prove a pre-worker failure: executeReworkRun only populates baseline
  // after setup completes, and only invokes a correction worker afterwards.
  return correction.workerExecution === undefined &&
    state.baseline === null &&
    Array.isArray(state.preflights) &&
    Array.isArray(state.workers) && state.workers.length === 0 &&
    Array.isArray(state.validations) && state.validations.length === 0;
}

function classifyRunIssue(state, worker) {
  const issue = String(worker.issue);
  const validation = (state.validations || []).find((entry) => String(entry.issue) === issue);
  const review = state.reviews?.[issue];
  const integrated = (state.integration || []).some((entry) => String(entry.issue) === issue);
  const conflict = state.conflicts?.[issue] || state.correction?.attempts?.[issue]?.conflict;

  if (integrated) return { state: "integrated-pending-manifest", action: `maestro commit --run ${state.runId}` };
  if (conflict && !["completed", "resolved", "manually-resolved"].includes(conflict.operationState)) {
    return { state: "technical-conflict", action: conflict.continuationAction || `maestro details ${issue}` };
  }
  const capacityIssues = state.capacity?.issues?.map(String);
  if (state.status === "running" && (!capacityIssues || capacityIssues.includes(issue))) {
    return {
      state: state.mode === "rework" ? "rework-running" : "running",
      action: "maestro status"
    };
  }
  if (review?.disposition === "discard" && (
    validation?.verdict === "rework" || isValidHumanGateResolution(review, validation, ["discard"])
  )) {
    return { state: "discarded", action: "maestro start" };
  }
  if (review?.disposition === "rework-original" && ["rework", "human_gate"].includes(validation?.verdict)) {
    return { state: "awaiting-rework", action: `maestro rework ${issue}` };
  }
  if (isValidHumanGateResolution(review, validation, ["rework"])) {
    return { state: "awaiting-rework", action: `maestro rework ${issue}` };
  }
  if (isValidValidatorOverride(review, validation)) {
    return { state: "awaiting-integration", action: `maestro commit --run ${state.runId}` };
  }
  if (isValidHumanGateResolution(review, validation, ["approve", "approve-with-follow-up"])) {
    return { state: "awaiting-integration", action: `maestro commit --run ${state.runId}` };
  }
  if (state.autoRework?.[issue]?.status === "retry-exhausted") {
    return { state: "rework-exhausted", action: `maestro details ${issue}` };
  }
  if (["worker-failure", "validator-failure", "infrastructure-failure", "technical-conflict", "human-required", "timeout", "no-progress"].includes(state.autoRework?.[issue]?.status)) {
    return { state: "failed-awaiting-retry", action: `maestro details ${issue}` };
  }
  if (["approve", "approve-with-follow-up"].includes(review?.disposition) && validation?.verdict === "approve") {
    return { state: "awaiting-integration", action: `maestro commit --run ${state.runId}` };
  }
  if (validation?.verdict === "rework") {
    return { state: "awaiting-rework", action: `maestro rework ${issue}` };
  }
  if (validation?.verdict === "human_gate") {
    return {
      state: "awaiting-human-decision",
      action: `maestro review --run ${state.runId} --issue ${issue} --disposition rework --notes decision-context`
    };
  }
  if (validation?.verdict === "approve") {
    return { state: "awaiting-human-review", action: `maestro approve ${issue} --run ${state.runId}` };
  }
  if (worker.exitCode === 0 && retryableValidationFailure(validation)) {
    return { state: "failed-awaiting-retry", action: `maestro validate ${issue} --retry` };
  }
  if (worker.exitCode !== 0 || state.status === "failed") {
    return { state: "failed-awaiting-retry", action: "maestro start --rerun" };
  }
  return { state: "awaiting-validation-or-review", action: "maestro status" };
}

module.exports = {
  classifyRunIssue,
  isRecoverableValidatorRework,
  isSafelyResumableReworkSetup
};

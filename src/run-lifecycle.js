const { isValidValidatorOverride, isValidHumanGateResolution } = require("./reviews");
const { retryableValidationFailure } = require("./validator");
const { isSafelyResumableSetupFailure } = require("./setup-resume");

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

function isSafelyResumableReworkSetup(state, evidence) {
  if (state?.mode !== "rework" || evidence?.worker || evidence?.validation) return false;
  const issue = evidence?.issue || Object.keys(state.correction?.attempts || {})[0];
  const persisted = state.correction?.attempts?.[String(issue)];
  if (!persisted || !evidence?.correction ||
      evidence.correction.workerExecution?.status !== "not-started" ||
      evidence.correction.failureStage !== state.failureStage ||
      evidence.correction.failureCode !== state.failureCode) return false;
  return isSafelyResumableSetupFailure(state, { issueIds: evidence?.issue ? [evidence.issue] : null });
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
  isSafelyResumableReworkSetup,
  isSafelyResumableSetupFailure
};

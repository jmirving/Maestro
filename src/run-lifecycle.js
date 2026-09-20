const { isValidValidatorOverride } = require("./reviews");

function isRecoverableValidatorRework(evidence) {
  const reviewDisposition = evidence?.review?.disposition;
  const humanRequestedRework = reviewDisposition === "rework-original";
  const validatorRequestedRework = evidence?.verdict === "rework" && !evidence?.review;
  return ["awaiting-rework", "rework-exhausted"].includes(evidence?.state) &&
    (humanRequestedRework || validatorRequestedRework);
}

function classifyRunIssue(state, worker) {
  const issue = String(worker.issue);
  const validation = (state.validations || []).find((entry) => String(entry.issue) === issue);
  const review = state.reviews?.[issue];
  const integrated = (state.integration || []).some((entry) => String(entry.issue) === issue);

  if (integrated) return { state: "integrated-pending-manifest", action: `maestro commit --run ${state.runId}` };
  const capacityIssues = state.capacity?.issues?.map(String);
  if (state.status === "running" && (!capacityIssues || capacityIssues.includes(issue))) {
    return {
      state: state.mode === "rework" ? "rework-running" : "running",
      action: "maestro status"
    };
  }
  if (review?.disposition === "discard") {
    return { state: "discarded", action: "maestro start" };
  }
  if (review?.disposition === "rework-original") {
    return { state: "awaiting-rework", action: `maestro rework ${issue}` };
  }
  if (isValidValidatorOverride(review, validation)) {
    return { state: "awaiting-integration", action: `maestro commit --run ${state.runId}` };
  }
  if (state.autoRework?.[issue]?.status === "retry-exhausted") {
    return { state: "rework-exhausted", action: `maestro details ${issue}` };
  }
  if (["worker-failure", "validator-failure", "infrastructure-failure", "technical-conflict", "human-required", "timeout", "no-progress"].includes(state.autoRework?.[issue]?.status)) {
    return { state: "failed-awaiting-retry", action: `maestro details ${issue}` };
  }
  if (review && validation?.verdict === "approve") {
    return { state: "awaiting-integration", action: `maestro commit --run ${state.runId}` };
  }
  if (validation?.verdict === "rework") {
    return { state: "awaiting-rework", action: `maestro rework ${issue}` };
  }
  if (validation?.verdict === "human_gate") {
    return {
      state: "awaiting-human-review",
      action: `maestro review --run ${state.runId} --issue ${issue} --disposition rework-original`
    };
  }
  if (validation?.verdict === "approve") {
    return { state: "awaiting-human-review", action: `maestro approve ${issue} --run ${state.runId}` };
  }
  if (worker.exitCode !== 0 || state.status === "failed") {
    return { state: "failed-awaiting-retry", action: "maestro start --rerun" };
  }
  return { state: "awaiting-validation-or-review", action: "maestro status" };
}

module.exports = { classifyRunIssue, isRecoverableValidatorRework };

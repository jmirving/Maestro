function classifyRunIssue(state, worker) {
  const issue = String(worker.issue);
  const validation = (state.validations || []).find((entry) => String(entry.issue) === issue);
  const review = state.reviews?.[issue];
  const integrated = (state.integration || []).some((entry) => String(entry.issue) === issue);

  if (integrated) return { state: "integrated-pending-manifest", action: `maestro commit --run ${state.runId}` };
  if (state.status === "running") {
    return {
      state: state.mode === "rework" ? "rework-running" : "running",
      action: "maestro status"
    };
  }
  if (review?.disposition === "rework-original") {
    return { state: "awaiting-rework", action: `maestro rework --run ${state.runId}` };
  }
  if (review && validation?.verdict === "approve") {
    return { state: "awaiting-integration", action: `maestro commit --run ${state.runId}` };
  }
  if (validation?.verdict === "rework") {
    return { state: "awaiting-rework", action: `maestro rework --run ${state.runId}` };
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

module.exports = { classifyRunIssue };

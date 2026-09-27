const BUDGET_STOP_REASONS = new Set(["max-cycles", "max-runtime", "no-progress-limit"]);

function relaunchSessionAction(session, { renew = false } = {}) {
  const scope = session.scope.type === "workset" && session.scope.workset
    ? `--workset ${session.scope.workset}`
    : session.scope.issueIds.join(" ");
  const renewal = renew ? ` --renew ${session.authorization.id}` : "";
  return `maestro start ${scope} --delegate --continuous${renewal}`;
}

function budgetExhausted(session) {
  return BUDGET_STOP_REASONS.has(session.stopReason);
}

module.exports = { BUDGET_STOP_REASONS, relaunchSessionAction, budgetExhausted };

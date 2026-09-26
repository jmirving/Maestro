function reviewCommand(entry, disposition) {
  return `maestro review --run ${entry.runId} --issue ${entry.issue} --disposition ${disposition}`;
}

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter((action) => action?.command && !seen.has(action.command) && seen.add(action.command));
}

function hasRecordedIntegration(states) {
  return states.some((state) => Array.isArray(state.integration) && state.integration.length > 0);
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildRecommendations(items, readiness, selected, {
  states = [],
  issueLimit = Number.POSITIVE_INFINITY,
  actionLimit = Number.POSITIVE_INFINITY,
  expansionCommand = null
} = {}) {
  const primary = [];
  const alternatives = [];
  const omittedIssues = new Set();
  const limitIssues = (entries) => {
    if (!Number.isFinite(issueLimit) || entries.length <= issueLimit) return entries;
    entries.slice(issueLimit).forEach((entry) => omittedIssues.add(String(entry.issue)));
    return entries.slice(0, issueLimit);
  };
  const actionable = items.filter((item) => item.actionable !== false);
  const technicalConflicts = actionable.filter((item) => item.autoReworkStatus === "technical-conflict" || item.technicalConflict);
  const available = actionable.filter((item) => !technicalConflicts.includes(item));
  const exhaustedRework = limitIssues(available.filter((item) => item.autoReworkStatus === "retry-exhausted" && !item.humanReview));
  const humanRequiredConflicts = limitIssues(available.filter((item) => item.autoReworkStatus === "human-required"));
  const currentRework = limitIssues(available.filter((item) => item.lifecycleState === "awaiting-rework" && !item.humanReview));
  const reviewedRework = limitIssues(available.filter((item) => item.lifecycleState === "awaiting-rework" && item.humanReview));
  const approvals = limitIssues(available.filter((item) => item.validator === "approve" && !item.humanReview));
  const humanGates = limitIssues(available.filter((item) => item.validator === "human_gate" && !item.humanReview));
  const visibleTechnicalConflicts = limitIssues(technicalConflicts);

  if (currentRework.length) {
    primary.push({ command: `maestro rework ${currentRework.map((item) => item.issue).join(" ")}` });
    alternatives.push({ command: `maestro details ${currentRework.map((item) => item.issue).join(" ")}` });
    for (const item of currentRework) {
      alternatives.push({ command: `maestro approve ${item.issue} --override` });
      alternatives.push({ command: `maestro discard ${item.issue}` });
    }
  }

  if (exhaustedRework.length) {
    const action = { command: `maestro details ${exhaustedRework.map((item) => item.issue).join(" ")}` };
    (primary.length ? alternatives : primary).push(action);
    for (const item of exhaustedRework) {
      alternatives.push({ command: `maestro rework ${item.issue}` });
      alternatives.push({ command: `maestro approve ${item.issue} --override` });
      alternatives.push({ command: `maestro discard ${item.issue}` });
    }
  }

  for (const item of visibleTechnicalConflicts) {
    const action = { command: item.action || `maestro details ${item.issue}` };
    (primary.length ? alternatives : primary).push(action);
    alternatives.push({ command: `maestro details ${item.issue}` });
  }

  for (const item of humanRequiredConflicts) {
    const action = { command: item.action || `maestro details ${item.issue}` };
    (primary.length ? alternatives : primary).push(action);
  }

  if (approvals.length) {
    const action = { command: `maestro approve ${approvals.map((item) => item.issue).join(" ")}` };
    (primary.length ? alternatives : primary).push(action);
    if (!currentRework.length) {
      alternatives.push({ command: `maestro details ${approvals.map((item) => item.issue).join(" ")}` });
    }
  }

  for (const item of humanGates) {
    const action = { command: reviewCommand(item, "rework-original") };
    (primary.length ? alternatives : primary).push(action);
    alternatives.push({ command: `maestro details ${item.issue}` });
  }

  for (const run of readiness) {
    for (const missing of run.missing.filter((entry) => entry.kind === "human rework disposition")) {
      const action = {
        command: `maestro review --run ${run.runId} --issue ${missing.issue} --disposition rework-original`
      };
      (primary.length ? alternatives : primary).push(action);
    }
  }

  for (const run of readiness.filter((entry) => entry.ready)) {
    const action = { command: run.command };
    (primary.length ? alternatives : primary).push(action);
  }

  if (reviewedRework.length) {
    const action = { command: `maestro rework ${reviewedRework.map((item) => item.issue).join(" ")}` };
    (primary.length ? alternatives : primary).push(action);
    alternatives.push({ command: `maestro details ${reviewedRework.map((item) => item.issue).join(" ")}` });
  }

  if (!primary.length && selected.length) {
    primary.push({ command: hasRecordedIntegration(states) ? "maestro next" : "maestro start" });
  }

  if (!primary.length) {
    const stateActions = [...new Set(actionable.map((item) => item.action).filter(Boolean))];
    if (stateActions.length) primary.push({ command: stateActions.shift() });
    alternatives.push(...stateActions.map((command) => ({ command })));
  }

  const ordered = uniqueActions([...primary.slice(0, 1), ...primary.slice(1), ...alternatives]);
  const visible = Number.isFinite(actionLimit) ? ordered.slice(0, actionLimit) : ordered;
  const result = {
    recommended: visible[0]?.command || null,
    alternatives: visible.slice(1).map((entry) => entry.command)
  };
  const hiddenActions = ordered.length - visible.length;
  if (omittedIssues.size || hiddenActions) {
    result.omitted = {
      issues: omittedIssues.size,
      actions: hiddenActions,
      expansionCommand
    };
  }
  return result;
}

function formatRecommendations(recommendations) {
  if (!recommendations?.recommended) return "";
  const lines = [`Recommended: \`${recommendations.recommended}\``];
  if (recommendations.alternatives?.length) {
    lines.push(`Also available: ${recommendations.alternatives.map((command) => `\`${command}\``).join(", ")}`);
  }
  if (recommendations.omitted?.issues || recommendations.omitted?.actions) {
    const counts = [];
    if (recommendations.omitted.issues) counts.push(`${countLabel(recommendations.omitted.issues, "more actionable issue")}`);
    if (recommendations.omitted.actions) counts.push(`${countLabel(recommendations.omitted.actions, "more action")}`);
    const expansion = recommendations.omitted.expansionCommand
      ? `; use ${recommendations.omitted.expansionCommand}`
      : "";
    lines.push(`More available: ${counts.join(" and ")}${expansion}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatRecommendationFooter(snapshot, { includeIssues = false } = {}) {
  const sections = [];
  if (includeIssues && snapshot.items?.length) {
    sections.push(snapshot.items.map((item) => (
      `Issue #${item.issue}${item.title ? ` — ${item.title}` : ""} — ${item.state}`
    )).join("\n"));
  }
  const recommendations = formatRecommendations(snapshot.recommendations);
  if (recommendations) sections.push(recommendations.trimEnd());
  return sections.length ? `\n${sections.join("\n\n")}\n` : "";
}

function appendRecommendationFooter(text, footer) {
  if (!footer) return text;
  return `${String(text).trimEnd()}\n${footer}`;
}

module.exports = {
  buildRecommendations,
  formatRecommendations,
  formatRecommendationFooter,
  appendRecommendationFooter
};

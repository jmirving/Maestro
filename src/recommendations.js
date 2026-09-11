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

function buildRecommendations(items, readiness, selected, { states = [] } = {}) {
  const primary = [];
  const alternatives = [];
  const currentRework = items.filter((item) => item.validator === "rework" && !item.humanReview);
  const reviewedRework = items.filter((item) => item.humanReview === "rework-original");
  const approvals = items.filter((item) => item.validator === "approve" && !item.humanReview);
  const humanGates = items.filter((item) => item.validator === "human_gate" && !item.humanReview);

  if (currentRework.length) {
    primary.push({ command: `maestro rework ${currentRework.map((item) => item.issue).join(" ")}` });
    alternatives.push({ command: `maestro details ${currentRework.map((item) => item.issue).join(" ")}` });
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
    const stateActions = [...new Set(items.map((item) => item.action).filter(Boolean))];
    if (stateActions.length) primary.push({ command: stateActions.shift() });
    alternatives.push(...stateActions.map((command) => ({ command })));
  }

  const ordered = uniqueActions([...primary.slice(0, 1), ...primary.slice(1), ...alternatives]);
  return {
    recommended: ordered[0]?.command || null,
    alternatives: ordered.slice(1).map((entry) => entry.command)
  };
}

function formatRecommendations(recommendations) {
  if (!recommendations?.recommended) return "";
  const lines = [`Recommended: \`${recommendations.recommended}\``];
  if (recommendations.alternatives?.length) {
    lines.push(`Also available: ${recommendations.alternatives.map((command) => `\`${command}\``).join(", ")}`);
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

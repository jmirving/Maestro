const { loadRunState } = require("./run-store");
const { evidenceForIssue, resolveRunsForIssues } = require("./run-resolver");

function issueTitle(config, evidence) {
  const issue = evidence.issue;
  const candidates = [
    evidence.selected?.title,
    evidence.worker?.title,
    config?.work?.[issue]?.title
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

async function loadLineage(repoPath, issue, resolvedState, stateLoader) {
  const lineage = [];
  const seen = new Set([String(resolvedState.runId)]);
  let state = resolvedState;

  while (state.parentRunId) {
    const parentRunId = String(state.parentRunId);
    if (seen.has(parentRunId)) {
      throw new Error(`Maestro run provenance contains a cycle at ${parentRunId}.`);
    }
    seen.add(parentRunId);
    const parent = await stateLoader(repoPath, parentRunId);
    lineage.push({
      runId: parentRunId,
      state: parent,
      evidence: evidenceForIssue(parent, issue)
    });
    state = parent;
  }
  return lineage;
}

async function loadIssueDetails(repoPath, issueIds, {
  runId = null,
  config = null,
  resolver = resolveRunsForIssues,
  stateLoader = loadRunState
} = {}) {
  const resolved = await resolver(repoPath, issueIds, { explicitRunId: runId });
  return Promise.all(resolved.map(async (entry) => ({
    ...entry,
    title: issueTitle(config, entry.evidence),
    manifestStatus: config?.work?.[entry.issue]?.status || null,
    lineage: await loadLineage(repoPath, entry.issue, entry.state, stateLoader)
  })));
}

function valueOrNone(value) {
  return value === null || value === undefined || value === "" ? "none" : String(value);
}

function appendReport(lines, label, report) {
  lines.push(`  ${label}:`);
  const text = String(report || "").trim();
  if (!text) {
    lines.push("    (not recorded)");
    return;
  }
  for (const line of text.split("\n")) lines.push(`    ${line}`);
}

function appendEvidence(lines, state, evidence, { heading = null } = {}) {
  if (heading) {
    lines.push("");
    lines.push(heading);
  }
  lines.push(`Run: ${state.runId}`);
  lines.push(`Mode: ${valueOrNone(state.mode)}`);
  lines.push(`Run status: ${valueOrNone(state.status)}`);

  if (!evidence) {
    lines.push("Issue evidence: not recorded in this parent run");
    return;
  }

  lines.push(`Issue state: ${valueOrNone(evidence.state)}`);
  lines.push("Worker:");
  if (evidence.worker) {
    const worker = evidence.worker;
    lines.push(`  Result: ${valueOrNone(worker.status || (worker.exitCode === 0 ? "succeeded" : "failed"))}`);
    lines.push(`  Exit code: ${valueOrNone(worker.exitCode)}`);
    lines.push(`  Commit: ${valueOrNone(worker.headSha)}`);
    lines.push(`  Base commit: ${valueOrNone(worker.baseSha)}`);
    lines.push(`  Branch: ${valueOrNone(worker.branch)}`);
    lines.push(`  Worktree: ${valueOrNone(worker.worktreePath)}`);
    appendReport(lines, "Report", worker.report);
  } else {
    lines.push("  (not recorded)");
  }

  lines.push("Validator:");
  if (evidence.validation) {
    lines.push(`  Verdict: ${valueOrNone(evidence.validation.verdict)}`);
    lines.push(`  Exit code: ${valueOrNone(evidence.validation.exitCode)}`);
    appendReport(lines, "Report", evidence.validation.report);
  } else {
    lines.push("  (not recorded)");
  }

  lines.push("Human review:");
  if (evidence.review) {
    lines.push(`  Disposition: ${valueOrNone(evidence.review.disposition)}`);
    lines.push(`  Recorded at: ${valueOrNone(evidence.review.recordedAt)}`);
    if (evidence.review.title) lines.push(`  Follow-up title: ${evidence.review.title}`);
    if (evidence.review.notes) lines.push(`  Notes: ${evidence.review.notes}`);
    if (evidence.review.followUpUrl) lines.push(`  Follow-up: ${evidence.review.followUpUrl}`);
  } else {
    lines.push("  Disposition: none");
  }

  lines.push("Integration:");
  if (evidence.integration) {
    lines.push("  State: integrated");
    lines.push(`  Commit: ${valueOrNone(evidence.integration.integratedSha)}`);
    lines.push(`  Branch: ${valueOrNone(evidence.integration.branch)}`);
  } else {
    lines.push("  State: not integrated");
  }
}

function formatDetails(items, { repository = null } = {}) {
  const sections = items.map((item) => {
    const lines = [];
    lines.push(`# Issue #${item.issue}${item.title ? ` — ${item.title}` : ""}`);
    if (repository) lines.push(`Repository: ${repository}`);
    lines.push(`Resolved run: ${item.runId}`);
    if (item.state.parentRunId) {
      lines.push(`Provenance: ${item.state.mode || "child"} child run of ${item.state.parentRunId}`);
    } else {
      lines.push("Provenance: original/source run");
    }
    lines.push(`Manifest state: ${valueOrNone(item.manifestStatus)}`);
    appendEvidence(lines, item.state, item.evidence);

    for (const ancestor of item.lineage) {
      const relationship = ancestor.state.parentRunId ? "Parent evidence" : "Original/source evidence";
      appendEvidence(lines, ancestor.state, ancestor.evidence, {
        heading: `## ${relationship} for #${item.issue}`
      });
    }
    return lines.join("\n");
  });
  return `${sections.join("\n\n")}\n`;
}

module.exports = { loadIssueDetails, formatDetails };

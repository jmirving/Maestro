const { loadRunState } = require("./run-store");
const { evidenceForIssue, resolveCurrentIssueStates } = require("./run-resolver");
const { recordReview } = require("./reviews");
const { isRecoverableValidatorRework } = require("./run-lifecycle");

function isDiscardable(evidence) {
  return isRecoverableValidatorRework(evidence);
}

async function discardIssues({ repoPath, runId = null, requestedIssues = [], reviewRecorder = recordReview }) {
  const requested = [...new Set(requestedIssues.map(String))];
  if (!requested.length) throw new Error("maestro discard requires at least one explicit issue number.");

  let candidates;
  if (runId) {
    const state = await loadRunState(repoPath, String(runId));
    candidates = requested.map((issue) => ({
      issue,
      runId: String(runId),
      evidence: evidenceForIssue(state, issue)
    }));
    const missing = candidates.find((entry) => !entry.evidence);
    if (missing) throw new Error(`Issue #${missing.issue} is not part of Maestro run ${runId}.`);
  } else {
    candidates = await resolveCurrentIssueStates(repoPath, requested);
  }

  const refused = candidates.filter((entry) => !isDiscardable(entry.evidence));
  if (refused.length) {
    const details = refused.map((entry) => (
      `#${entry.issue} (${entry.evidence?.state || "unknown"}; validator=${entry.evidence?.verdict || "missing"}; run ${entry.runId})`
    )).join(", ");
    throw new Error(`Cannot discard the current workflow state for ${details}. Only unreviewed validator-REWORK items can be discarded.`);
  }

  const discarded = [];
  for (const candidate of candidates) {
    await reviewRecorder({
      repoPath,
      runId: candidate.runId,
      issue: candidate.issue,
      disposition: "discard"
    });
    discarded.push({ issue: candidate.issue, runId: candidate.runId });
  }
  return { explicitRunId: runId ? String(runId) : null, discarded };
}

function formatDiscardSummary(result) {
  const entries = result.discarded.map((entry) => `#${entry.issue} (run ${entry.runId})`).join(", ");
  return `Discarded: ${entries}\nImplementation branches/worktrees were preserved for audit; ready manifest items are eligible for a fresh run.\n`;
}

module.exports = { isDiscardable, discardIssues, formatDiscardSummary };

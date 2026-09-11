const { loadRunState } = require("./run-store");
const { evidenceForIssue, issueIdsForRun, resolveCurrentIssueStates } = require("./run-resolver");
const { recordReview } = require("./reviews");

function approvalReason(evidence) {
  if (evidence.state === "awaiting-rework") return "rework-required";
  if (evidence.state === "awaiting-integration") return "already-reviewed";
  if (evidence.state === "integrated-pending-manifest") return "already-integrated";
  if (evidence.state === "awaiting-human-review" && evidence.verdict === "human_gate") return "human-decision-required";
  if (evidence.state === "running" || evidence.state === "rework-running") return evidence.state;
  if (evidence.state === "failed-awaiting-retry") return "retry-required";
  return evidence.verdict === "approve" ? "not-unreviewed" : `not-validator-approved:${evidence.verdict || "missing"}`;
}

function isNormallyApprovable(evidence) {
  return evidence.state === "awaiting-human-review" && evidence.verdict === "approve" && !evidence.review;
}

function summarizeEntry(resolved) {
  return {
    issue: resolved.issue,
    runId: resolved.runId,
    state: resolved.evidence.state,
    verdict: resolved.evidence.verdict,
    reason: approvalReason(resolved.evidence)
  };
}

async function explicitRunCandidates(repoPath, runId, requestedIssues) {
  const state = await loadRunState(repoPath, runId);
  const available = new Map(issueIdsForRun(state).map((issue) => [issue, evidenceForIssue(state, issue)]));
  const targets = requestedIssues.length
    ? requestedIssues
    : [...available.keys()].filter((issue) => {
      const evidence = available.get(issue);
      return evidence?.verdict === "approve" && !evidence.review;
    });

  const missing = targets.filter((issue) => !available.has(issue));
  if (missing.length) throw new Error(`Issue #${missing[0]} is not part of Maestro run ${runId}.`);
  const refused = targets.filter((issue) => available.get(issue)?.verdict !== "approve");
  if (refused.length) {
    const issue = refused[0];
    const verdict = available.get(issue)?.verdict || "missing";
    throw new Error(`Issue #${issue} is not validator-approved (${verdict}); it cannot be approved by the shorthand command.`);
  }

  return {
    candidates: targets.map((issue) => ({ issue, runId, state, evidence: available.get(issue) })),
    skipped: requestedIssues.length ? [] : [...available.entries()]
      .filter(([issue]) => !targets.includes(issue))
      .map(([issue, evidence]) => summarizeEntry({ issue, runId, evidence }))
  };
}

async function approveIssues({ repoPath, runId = null, requestedIssues = [], reviewRecorder = recordReview }) {
  const requested = [...new Set(requestedIssues.map(String))];
  let candidates;
  let skipped;

  if (runId) {
    ({ candidates, skipped } = await explicitRunCandidates(repoPath, String(runId), requested));
  } else {
    const resolved = await resolveCurrentIssueStates(repoPath, requested);
    const current = requested.length
      ? resolved
      : resolved.filter((entry) => entry.evidence.state !== "integrated-pending-manifest");
    candidates = current.filter((entry) => isNormallyApprovable(entry.evidence));
    skipped = current.filter((entry) => !isNormallyApprovable(entry.evidence)).map(summarizeEntry);
    if (requested.length && skipped.length) {
      const details = skipped.map((entry) => `#${entry.issue} (${entry.reason} in run ${entry.runId})`).join(", ");
      throw new Error(`Cannot approve the current workflow state for ${details}.`);
    }
  }

  const approved = [];
  for (const candidate of candidates) {
    await reviewRecorder({
      repoPath,
      runId: candidate.runId,
      issue: candidate.issue,
      disposition: "approve"
    });
    approved.push({ issue: candidate.issue, runId: candidate.runId });
  }

  const actionable = skipped.filter((entry) => [
    "rework-required",
    "human-decision-required",
    "already-reviewed",
    "retry-required"
  ].includes(entry.reason));
  return { explicitRunId: runId ? String(runId) : null, approved, skipped, actionable };
}

function formatApprovalSummary(result) {
  const lines = [];
  if (result.approved.length) {
    const approved = result.approved.map((entry) => `#${entry.issue} (run ${entry.runId})`).join(", ");
    lines.push(`Approved: ${approved}`);
  } else {
    lines.push("Approved: none");
  }
  if (result.skipped.length) {
    lines.push(`Skipped: ${result.skipped.map((entry) => `#${entry.issue} (${entry.reason}; run ${entry.runId})`).join(", ")}`);
  } else {
    lines.push("Skipped: none");
  }
  if (result.actionable.length) {
    lines.push(`Still actionable: ${result.actionable.map((entry) => `#${entry.issue} remains ${entry.reason}`).join(", ")}`);
  } else {
    lines.push("Still actionable: none");
  }
  return `${lines.join("\n")}\n`;
}

module.exports = { approvalReason, isNormallyApprovable, approveIssues, formatApprovalSummary };

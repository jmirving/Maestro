const { loadRunState } = require("./run-store");
const { evidenceForIssue, issueIdsForRun, resolveCurrentIssueStates } = require("./run-resolver");
const { recordReview } = require("./reviews");
const { isRecoverableValidatorRework } = require("./run-lifecycle");

function approvalReason(evidence) {
  if (isRecoverableValidatorRework(evidence)) return "rework-required";
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

function isOverrideApprovable(evidence) {
  return isRecoverableValidatorRework(evidence);
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

async function explicitRunCandidates(repoPath, runId, requestedIssues, { override = false } = {}) {
  const state = await loadRunState(repoPath, runId);
  const available = new Map(issueIdsForRun(state).map((issue) => [issue, evidenceForIssue(state, issue)]));
  const targets = requestedIssues.length
    ? requestedIssues
    : [...available.keys()].filter((issue) => {
      const evidence = available.get(issue);
      return (override ? isOverrideApprovable(evidence) : isNormallyApprovable(evidence));
    });

  const missing = targets.filter((issue) => !available.has(issue));
  if (missing.length) throw new Error(`Issue #${missing[0]} is not part of Maestro run ${runId}.`);
  const refused = targets.filter((issue) => (
    override ? !isOverrideApprovable(available.get(issue)) : !isNormallyApprovable(available.get(issue))
  ));
  if (refused.length) {
    const issue = refused[0];
    const verdict = available.get(issue)?.verdict || "missing";
    if (override) {
      throw new Error(`Issue #${issue} is not an unreviewed validator-REWORK item (${verdict}); it cannot be override-approved.`);
    }
    throw new Error(`Issue #${issue} is not an unreviewed validator-approved item (${verdict}); it cannot be approved by the shorthand command.`);
  }

  return {
    candidates: targets.map((issue) => ({ issue, runId, state, evidence: available.get(issue) })),
    skipped: requestedIssues.length ? [] : [...available.entries()]
      .filter(([issue]) => !targets.includes(issue))
      .map(([issue, evidence]) => summarizeEntry({ issue, runId, evidence }))
  };
}

async function approveIssues({
  repoPath,
  runId = null,
  requestedIssues = [],
  override = false,
  reviewRecorder = recordReview
}) {
  const requested = [...new Set(requestedIssues.map(String))];
  if (override && !requested.length) {
    throw new Error("maestro approve --override requires at least one explicit issue number.");
  }
  let candidates;
  let skipped;

  if (runId) {
    ({ candidates, skipped } = await explicitRunCandidates(repoPath, String(runId), requested, { override }));
  } else {
    const resolved = await resolveCurrentIssueStates(repoPath, requested);
    const current = requested.length
      ? resolved
      : resolved.filter((entry) => entry.evidence.state !== "integrated-pending-manifest");
    const eligible = override ? isOverrideApprovable : isNormallyApprovable;
    candidates = current.filter((entry) => eligible(entry.evidence));
    skipped = current.filter((entry) => !eligible(entry.evidence)).map(summarizeEntry);
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
      disposition: override ? "approve-override" : "approve",
      ...(override ? {
        validatorOverride: {
          verdict: candidate.evidence.verdict,
          exitCode: candidate.evidence.validation?.exitCode ?? null,
          report: candidate.evidence.validation?.report ?? null
        }
      } : {})
    });
    approved.push({ issue: candidate.issue, runId: candidate.runId, ...(override ? { override: true } : {}) });
  }

  const actionable = skipped.filter((entry) => [
    "rework-required",
    "human-decision-required",
    "already-reviewed",
    "retry-required"
  ].includes(entry.reason));
  return { explicitRunId: runId ? String(runId) : null, override, approved, skipped, actionable };
}

function formatApprovalSummary(result) {
  const lines = [];
  if (result.approved.length) {
    const approved = result.approved.map((entry) => `#${entry.issue} (run ${entry.runId})`).join(", ");
    lines.push(`${result.override ? "Override-approved" : "Approved"}: ${approved}`);
  } else {
    lines.push(`${result.override ? "Override-approved" : "Approved"}: none`);
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

module.exports = { approvalReason, isNormallyApprovable, isOverrideApprovable, approveIssues, formatApprovalSummary };

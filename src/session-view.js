const { listSessions } = require("./session-store");
const { budgetExhausted, relaunchSessionAction } = require("./session-policy");

function relaunchAction(session) {
  return relaunchSessionAction(session, { renew: budgetExhausted(session) });
}

function sessionNextAction(session) {
  if (session.owner) return "maestro status --watch";
  if (["created", "paused", "quiescent"].includes(session.status)) return `maestro resume --session ${session.id}`;
  if (session.status === "stopped") return session.terminal?.nextAction || relaunchAction(session);
  if (session.status === "complete") return "maestro status --completed";
  return session.terminal?.nextAction || `maestro resume --session ${session.id}`;
}

function summarizeSession(session) {
  const unresolved = (session.terminal?.unresolved || []).map((entry) => ({
    issue: String(entry.issue),
    reason: entry.reason,
    nextAction: entry.nextAction || `maestro details ${entry.issue}`
  }));
  return {
    id: session.id,
    status: session.status,
    phase: session.phase,
    ownerPid: session.owner?.pid || null,
    scope: {
      type: session.scope.type,
      workset: session.scope.workset || null,
      issueIds: session.scope.issueIds.map(String),
      revision: session.scope.revision
    },
    authorizationId: session.authorization.id,
    settings: session.settings,
    cycles: session.cycles || 0,
    progress: {
      integratedIssueIds: (session.progress?.integratedIssueIds || []).map(String),
      bookkeepingPendingIssueIds: (session.progress?.bookkeepingPendingIssueIds || []).map(String),
      manifestPublicationState: session.progress?.manifestPublication?.state || null,
      noProgressCycles: session.progress?.noProgressCycles || 0,
      issueAttempts: { ...(session.lineage?.issueAttempts || {}) },
      remainingIssueIds: (session.terminal?.remainingIssueIds || []).map(String)
    },
    stopReason: session.stopReason || null,
    acceptance: session.acceptance ? {
      outcome: session.acceptance.outcome,
      targetSha: session.acceptance.targetSha || null,
      scopeRevision: session.acceptance.scopeRevision || null,
      authorizedSnapshotSatisfied: session.acceptance.authorizedSnapshotSatisfied === true,
      liveScopeComplete: session.acceptance.liveScopeComplete === true,
      checks: session.acceptance.checks || []
    } : null,
    gates: unresolved,
    lastError: session.lastError || null,
    nextAction: sessionNextAction(session)
  };
}

async function loadSessionSummaries(repoPath, { issueIds = [], runId = null, loader = listSessions } = {}) {
  const selectedIssues = new Set(issueIds.map(String));
  return (await loader(repoPath))
    .filter((session) => !selectedIssues.size || session.scope.issueIds.some((issue) => selectedIssues.has(String(issue))))
    .filter((session) => !runId || session.lineage.runIds.includes(String(runId)))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map(summarizeSession);
}

function list(values, prefix = "#") {
  return values.length ? values.map((value) => `${prefix}${value}`).join(", ") : "none";
}

function formatSessionSummaries(sessions, { heading = "Autonomous sessions" } = {}) {
  if (!sessions?.length) return "";
  const lines = [`## ${heading}`];
  for (const session of sessions) {
    const limits = session.settings.limits;
    const correction = session.settings.correction || {};
    lines.push(
      "",
      `Session ${session.id}: ${session.status} (${session.phase})`,
      `  Scope: ${session.scope.workset ? `workset ${session.scope.workset}; ` : ""}${list(session.scope.issueIds)}; revision ${session.scope.revision}`,
      `  Authorization: ${session.authorizationId}`,
      `  Limits: concurrency ${session.settings.concurrency}; cycles ${session.cycles}/${limits.maxCycles}; runtime ${limits.maxRuntimeMs}ms; no-progress ${session.progress.noProgressCycles}/${limits.maxNoProgressCycles}; correction attempts ${correction.retryLimit ?? 0}, deadline ${correction.deadlineMs ?? 0}ms`,
      `  Progress: integrated ${list(session.progress.integratedIssueIds)}; bookkeeping pending ${list(session.progress.bookkeepingPendingIssueIds)}; publication ${session.progress.manifestPublicationState || "not started"}; remaining ${list(session.progress.remainingIssueIds)}`,
      `  Attempts: ${Object.keys(session.progress.issueAttempts).length ? Object.entries(session.progress.issueAttempts).map(([issue, count]) => `#${issue}=${count}`).join(", ") : "none"}`,
      `  Stop reason: ${session.stopReason || "none"}`
    );
    if (session.acceptance) {
      lines.push(
        `  Acceptance: ${session.acceptance.outcome}; authorized snapshot ${session.acceptance.authorizedSnapshotSatisfied ? "satisfied" : "incomplete"}; live scope ${session.acceptance.liveScopeComplete ? "complete" : "changed/unverified"}; target ${session.acceptance.targetSha || "unavailable"}`
      );
    }
    if (session.ownerPid) lines.push(`  Active owner: process ${session.ownerPid}`);
    if (session.lastError) lines.push(`  Last error: ${session.lastError.code || "error"}: ${session.lastError.message}`);
    if (session.gates.length) {
      lines.push("  Gates:");
      for (const gate of session.gates) lines.push(`    #${gate.issue}: ${gate.reason}; next: ${gate.nextAction}`);
    } else {
      lines.push("  Gates: none");
    }
    lines.push(`  Next: ${session.nextAction}`);
  }
  return `${lines.join("\n")}\n`;
}

module.exports = { sessionNextAction, summarizeSession, loadSessionSummaries, formatSessionSummaries };

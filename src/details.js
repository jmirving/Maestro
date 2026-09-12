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
  if (state.failure) lines.push(`Run failure: ${state.failure}`);

  if (!evidence) {
    lines.push("Issue evidence: not recorded in this parent run");
    return;
  }

  lines.push(`Issue state: ${valueOrNone(evidence.state)}`);
  if (evidence.correction) {
    lines.push("Correction attempt:");
    lines.push(`  Number: ${valueOrNone(evidence.correction.number)}`);
    lines.push(`  Automatic: ${evidence.correction.automatic === true ? "yes" : "no"}`);
    lines.push(`  Root run: ${valueOrNone(evidence.correction.rootRunId)}`);
    lines.push(`  Source run: ${valueOrNone(evidence.correction.sourceRunId)}`);
    lines.push(`  Phase: ${valueOrNone(evidence.correction.phase)}`);
    lines.push(`  Outcome: ${valueOrNone(evidence.correction.outcome)}`);
    if (evidence.correction.implementation) {
      lines.push(`  Implementation branch: ${valueOrNone(evidence.correction.implementation.branch)}`);
      lines.push(`  Implementation worktree: ${valueOrNone(evidence.correction.implementation.worktreePath)}`);
      lines.push(`  Original base: ${valueOrNone(evidence.correction.implementation.baseSha)}`);
      lines.push(`  Target branch: ${valueOrNone(evidence.correction.implementation.targetBranch)}`);
    }
    if (evidence.correction.trigger) {
      lines.push(`  Trigger verdict: ${valueOrNone(evidence.correction.trigger.verdict)}`);
      appendReport(lines, "Trigger report", evidence.correction.trigger.report);
    }
    if (evidence.correction.conflict) {
      const conflict = evidence.correction.conflict;
      lines.push("  Technical conflict:");
      lines.push(`    Type: ${valueOrNone(conflict.type)}`);
      lines.push(`    Operation: ${valueOrNone(conflict.operation)}`);
      lines.push(`    Operation state: ${valueOrNone(conflict.operationState)}`);
      lines.push(`    Interrupted stage: ${valueOrNone(conflict.interruptedStage)}`);
      lines.push(`    Conflicted files: ${conflict.conflictedFiles?.length ? conflict.conflictedFiles.join(", ") : "none recorded"}`);
      lines.push(`    Target ref: ${valueOrNone(conflict.targetRef)}`);
      lines.push(`    Continuation action: ${valueOrNone(conflict.continuationAction)}`);
      if (conflict.stderr) appendReport(lines, "Git evidence", conflict.stderr);
      if (conflict.abortError) lines.push(`    Abort error: ${conflict.abortError}`);
    }
  }
  if (evidence.autoRework) {
    lines.push("Automatic rework:");
    lines.push(`  Status: ${valueOrNone(evidence.autoRework.status)}`);
    lines.push(`  Attempts used: ${valueOrNone(evidence.autoRework.attemptsUsed)}`);
    lines.push(`  Retry limit: ${valueOrNone(evidence.autoRework.retryLimit)}`);
    lines.push(`  Next action: ${valueOrNone(evidence.autoRework.action)}`);
  }
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
    if (evidence.review.validatorOverride) {
      lines.push(`  Overridden validator verdict: ${valueOrNone(evidence.review.validatorOverride.verdict)}`);
      lines.push(`  Overridden validator exit code: ${valueOrNone(evidence.review.validatorOverride.exitCode)}`);
      if (evidence.review.validatorOverride.report) {
        appendReport(lines, "Overridden validator report", evidence.review.validatorOverride.report);
      }
    }
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

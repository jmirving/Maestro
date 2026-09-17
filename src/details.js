const { loadRunState } = require("./run-store");
const { evidenceForIssue, resolveRunsForIssues } = require("./run-resolver");
const { conflictRecoveryCommands } = require("./git-conflict");

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
  const resolved = [];
  for (const issue of issueIds.map(String)) {
    try {
      const [entry] = await resolver(repoPath, [issue], { explicitRunId: runId });
      resolved.push(entry);
    } catch (error) {
      const noHistory = /No Maestro runs found|No relevant Maestro run/.test(error.message);
      if (runId || !noHistory || config?.work?.[issue]?.completion?.source !== "external") throw error;
      resolved.push({ issue, runId: null, state: null, evidence: null });
    }
  }
  return Promise.all(resolved.map(async (entry) => ({
    ...entry,
    title: entry.evidence ? issueTitle(config, entry.evidence) : config?.work?.[entry.issue]?.github?.title || null,
    manifestStatus: config?.work?.[entry.issue]?.status || null,
    completion: config?.work?.[entry.issue]?.completion || null,
    lineage: entry.state ? await loadLineage(repoPath, entry.issue, entry.state, stateLoader) : []
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
  if (evidence.conflict && evidence.conflict !== evidence.correction?.conflict) {
    appendConflict(lines, evidence.conflict);
  }
  if (evidence.correction) {
    lines.push("Correction attempt:");
    lines.push(`  Number: ${valueOrNone(evidence.correction.number)}`);
    lines.push(`  Automatic: ${evidence.correction.automatic === true ? "yes" : "no"}`);
    lines.push(`  Root run: ${valueOrNone(evidence.correction.rootRunId)}`);
    lines.push(`  Source run: ${valueOrNone(evidence.correction.sourceRunId)}`);
    lines.push(`  Phase: ${valueOrNone(evidence.correction.phase)}`);
    lines.push(`  Outcome: ${valueOrNone(evidence.correction.outcome)}`);
    if (evidence.correction.timeoutStage) lines.push(`  Timeout stage: ${evidence.correction.timeoutStage}`);
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
      appendConflict(lines, evidence.correction.conflict);
    }
  }
  if (evidence.autoRework) {
    lines.push("Automatic rework:");
    lines.push(`  Status: ${valueOrNone(evidence.autoRework.status)}`);
    lines.push(`  Attempts used: ${valueOrNone(evidence.autoRework.attemptsUsed)}`);
    lines.push(`  Retry limit: ${valueOrNone(evidence.autoRework.retryLimit)}`);
    if (evidence.autoRework.timeoutStage) lines.push(`  Timeout stage: ${evidence.autoRework.timeoutStage}`);
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

function appendConflict(lines, conflict) {
  lines.push("  Technical conflict:");
  lines.push(`    Type: ${valueOrNone(conflict.type)}`);
  lines.push(`    Repository: ${valueOrNone(conflict.repository)}`);
  lines.push(`    Issue: ${valueOrNone(conflict.issue)}`);
  lines.push(`    Source run: ${valueOrNone(conflict.sourceRunId)}`);
  lines.push(`    Operation: ${valueOrNone(conflict.operation)}`);
  lines.push(`    Operation owner: ${valueOrNone(conflict.operationOwner)}`);
  lines.push(`    Operation state: ${valueOrNone(conflict.operationState)}`);
  lines.push(`    Resolution state: ${valueOrNone(conflict.resolutionState)}`);
  lines.push(`    Requires semantic human decision: ${conflict.requiresSemanticHumanDecision === true ? "yes" : "no"}`);
  lines.push(`    Interrupted stage: ${valueOrNone(conflict.interruptedStage)}`);
  lines.push(`    Interrupted action: ${valueOrNone(conflict.interruptedAction)}`);
  lines.push(`    Conflicted files: ${conflict.conflictedFiles?.length ? conflict.conflictedFiles.join(", ") : "none recorded"}`);
  lines.push(`    Branch: ${valueOrNone(conflict.branch)}`);
  lines.push(`    Worktree: ${valueOrNone(conflict.worktreePath)}`);
  lines.push(`    Source SHA: ${valueOrNone(conflict.sourceSha)}`);
  lines.push(`    Original base: ${valueOrNone(conflict.originalBaseSha)}`);
  lines.push(`    Target ref: ${valueOrNone(conflict.targetRef)}`);
  lines.push(`    Target SHA: ${valueOrNone(conflict.targetSha)}`);
  lines.push(`    Operation original HEAD: ${valueOrNone(conflict.operationOriginalHeadSha)}`);
  lines.push(`    Operation current HEAD: ${valueOrNone(conflict.operationCurrentHeadSha)}`);
  lines.push(`    Operation head: ${valueOrNone(conflict.operationHeadSha)}`);
  if (conflict.operation === "rebase") lines.push(`    Rebase onto SHA: ${valueOrNone(conflict.operationOntoSha)}`);
  if (conflict.operation === "merge") lines.push(`    Merge head SHA: ${valueOrNone(conflict.operationMergeHeadSha)}`);
  lines.push(`    Continuation action: ${valueOrNone(conflict.continuationAction)}`);
  const recoveryCommands = conflictRecoveryCommands(conflict);
  if (recoveryCommands.length) {
    lines.push("    Manual recovery (resolve and stage every conflict; repeat continue if Git stops again):");
    for (const command of recoveryCommands) lines.push(`      ${command}`);
  }
  if (conflict.resolutionVerifiedAgainstSha) lines.push(`    Resolution verified against: ${conflict.resolutionVerifiedAgainstSha}`);
  if (conflict.operationEvidence?.verification) {
    const operation = conflict.operationEvidence.verification;
    lines.push(`    Expected rebase present: ${operation.expectedRebasePresent === true ? "yes" : "no"}`);
    lines.push(`    Rebase recoverable: ${operation.recoverable === true ? "yes" : "no"}`);
    if (operation.reason) lines.push(`    Operation verification: ${operation.reason}`);
  }
  if (conflict.resolution) {
    lines.push(`    Resolver status: ${valueOrNone(conflict.resolution.status)}`);
    if (conflict.resolution.verification) {
      lines.push(`    Target ancestry verified: ${conflict.resolution.verification.targetAncestor === true ? "yes" : "no"}`);
      lines.push(`    Worktree clean: ${conflict.resolution.verification.worktreeClean === true ? "yes" : "no"}`);
      if (conflict.resolution.verification.failure) lines.push(`    Verification failure: ${conflict.resolution.verification.failure}`);
    }
    if (conflict.resolution.report) appendReport(lines, "Resolver report", conflict.resolution.report);
    if (conflict.resolution.stderr) appendReport(lines, "Resolver stderr", conflict.resolution.stderr);
  }
  if (conflict.preservation) {
    lines.push(`    Existing user edits preserved: ${conflict.preservation.existingUserEditsPreserved === true ? "yes" : "no user edits were present"}`);
    lines.push(`    Partial resolutions preserved: ${conflict.preservation.partialResolutionsPreserved === true ? "yes" : "not applicable"}`);
    lines.push(`    Recovery artifacts: ${conflict.preservation.recoveryArtifacts?.length ? conflict.preservation.recoveryArtifacts.join(", ") : "none"}`);
  }
  if (conflict.statusEvidence) appendReport(lines, "Git status evidence", conflict.statusEvidence);
  if (conflict.stderr) appendReport(lines, "Git evidence", conflict.stderr);
  if (conflict.abortError) lines.push(`    Abort error: ${conflict.abortError}`);
}

function formatDetails(items, { repository = null } = {}) {
  const sections = items.map((item) => {
    const lines = [];
    lines.push(`# Issue #${item.issue}${item.title ? ` — ${item.title}` : ""}`);
    if (repository) lines.push(`Repository: ${repository}`);
    lines.push(`Manifest state: ${valueOrNone(item.manifestStatus)}`);
    if (item.completion) {
      lines.push(`Completion provenance: ${item.completion.source}`);
      lines.push(`Reconciled at: ${valueOrNone(item.completion.reconciledAt)}`);
      lines.push(`GitHub evidence: ${valueOrNone(item.completion.githubState)} / ${valueOrNone(item.completion.githubStateReason)}`);
    }
    if (!item.state) {
      lines.push("Maestro execution history: none");
      return lines.join("\n");
    }
    lines.push(`Resolved run: ${item.runId}`);
    if (item.state.parentRunId) {
      lines.push(`Provenance: ${item.state.mode || "child"} child run of ${item.state.parentRunId}`);
    } else {
      lines.push("Provenance: original/source run");
    }
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

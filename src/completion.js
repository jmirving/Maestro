const { digest } = require("./authorization");
const { effectiveIssueStates } = require("./run-resolver");
const { runChecked } = require("./process");
const { runObservationalIntegrationCommand, remoteBranchSha } = require("./integrator");

const COMPLETION_EVIDENCE_VERSION = 2;

function worksetContract(config, scope) {
  if (scope?.type !== "workset") {
    return {
      source: "authorized-issue-scope",
      version: scope?.revision || "unknown",
      requirements: ["Every authorized issue has current verified completion evidence."],
      commands: [],
      closeParent: false,
      parentIssue: null
    };
  }
  const definition = config.worksets?.[scope.workset];
  if (!definition) return null;
  const acceptance = definition.acceptance || {};
  const requirements = [definition.completionPolicy, ...(acceptance.requirements || [])].filter(Boolean);
  return {
    source: `worksets.${scope.workset}`,
    version: acceptance.version || scope.revision,
    requirements,
    commands: acceptance.commands || [],
    closeParent: acceptance.closeParent === true,
    parentIssue: definition.source?.type === "epic" ? String(definition.source.issue.number) : null
  };
}

function nextActionForState(issue, state) {
  if (state === "integrated-pending-manifest" || state === "bookkeeping-pending") return `maestro resume ${issue}`;
  if (["human_gate", "awaiting-human-decision"].includes(state)) return `maestro details ${issue}`;
  if (["awaiting-rework", "rework-exhausted"].includes(state)) return `maestro rework ${issue}`;
  if (state === "awaiting-human-review") return `maestro approve ${issue}`;
  if (state === "awaiting-integration") return `maestro commit`;
  return `maestro details ${issue}`;
}

function externalVerification(completion, targetSha) {
  const verification = completion?.verification;
  if (!verification || verification.outcome !== "verified" || !verification.targetSha) return null;
  if (targetSha && verification.targetSha !== targetSha) return null;
  if (!Array.isArray(verification.checks) || !verification.checks.length) return null;
  if (verification.checks.some((check) => !["passed", "accepted-baseline-failure"].includes(check.status))) return null;
  return verification;
}

function classifyMembers(config, states, issueIds, { targetSha = null, session = null } = {}) {
  const effective = effectiveIssueStates(config, states, issueIds);
  const members = [];
  const unresolved = [];
  const bookkeeping = [];
  for (const issue of issueIds.map(String)) {
    const item = effective.get(issue) || { issue, state: "unknown" };
    let outcome = "incomplete";
    let source = null;
    let evidence = null;
    let reason = null;

    if (item.consistencyConflict) {
      reason = item.consistencyConflict;
    } else if (item.integration) {
      source = item.integration.noChange === true ? "verified-no-change" : "maestro-integration";
      evidence = item.integration;
      if (config.work?.[issue]?.status !== "complete") {
        outcome = "bookkeeping-pending";
        reason = "code is integrated and verified, but manifest completion is not settled";
        bookkeeping.push(issue);
      } else if (item.integration.closureRequired === true) {
        const run = states.find((entry) => String(entry.runId) === String(item.integrationRunId));
        if (run?.closures?.[issue]?.state !== "confirmed") {
          outcome = "bookkeeping-pending";
          reason = "required GitHub closure is not confirmed";
          bookkeeping.push(issue);
        } else {
          outcome = "verified";
        }
      } else {
        outcome = "verified";
      }
    } else if (item.completion?.source === "external") {
      source = "external";
      evidence = externalVerification(item.completion, targetSha);
      if (evidence) outcome = "verified";
      else reason = "external completion lacks current independent verification evidence for this target";
    } else {
      reason = item.state === "inactive"
        ? "issue closure/cancellation is not an acceptance decision"
        : `required implementation is ${item.state || "unresolved"}`;
    }

    if (session?.progress?.bookkeepingPendingIssueIds?.map(String).includes(issue)) {
      outcome = "bookkeeping-pending";
      reason = "session bookkeeping is pending";
      if (!bookkeeping.includes(issue)) bookkeeping.push(issue);
    }
    const member = { issue, outcome, source, state: item.state || "unknown", evidence, reason };
    members.push(member);
    if (outcome !== "verified") unresolved.push({
      issue,
      category: outcome,
      reason,
      nextAction: nextActionForState(issue, outcome === "bookkeeping-pending" ? outcome : item.state)
    });
  }
  return { members, unresolved, bookkeepingIssueIds: [...new Set(bookkeeping)] };
}

async function targetHead(repoPath, targetBranch, runner = runChecked) {
  const branch = (await runner("git", ["branch", "--show-current"], { cwd: repoPath })).stdout.trim();
  if (branch !== targetBranch) throw new Error(`Completion checks require the target checkout on ${targetBranch}; found ${branch || "detached HEAD"}.`);
  const status = (await runner("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoPath })).stdout.trim();
  if (status) throw new Error(`Completion checks require a clean target checkout:\n${status}`);
  return (await runner("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
}

async function authoritativeTarget(repoPath, targetBranch, runner = runChecked) {
  const localSha = await targetHead(repoPath, targetBranch, runner);
  const remoteSha = await remoteBranchSha(repoPath, "origin", targetBranch, runner);
  if (!remoteSha) throw new Error(`Completion checks require authoritative origin/${targetBranch} to exist.`);
  if (localSha !== remoteSha) {
    throw new Error(`Completion checks require local ${targetBranch} (${localSha}) to match authoritative origin/${targetBranch} (${remoteSha}).`);
  }
  return remoteSha;
}

function stateBelongsToSession(state, session) {
  const lineage = new Set((session?.lineage?.runIds || []).map(String));
  return Boolean(
    session?.id &&
    session?.authorization?.id &&
    lineage.has(String(state.runId)) &&
    state.autonomousSessionId === session.id &&
    state.authorization?.id === session.authorization.id &&
    state.authorization?.policyDigest === session.authorization.policyDigest &&
    state.authorization?.scope?.revision === session.scope?.revision
  );
}

function baselineForChecks(states, commands, session) {
  return [...states]
    .filter((state) => stateBelongsToSession(state, session))
    .sort((left, right) => String(right.runId).localeCompare(String(left.runId)))
    .map((state) => state.baseline)
    .find((baseline) => commands.every((command) => baseline?.results?.some((entry) => entry.command === command))) || null;
}

function commandPolicy(entry) {
  return typeof entry === "string"
    ? { command: entry, required: true }
    : { command: entry.command, required: entry.required !== false };
}

function skippedCheckEvidence(result = {}) {
  if (Array.isArray(result.skippedChecks) && result.skippedChecks.length) {
    return { source: "runner", count: result.skippedChecks.length, checks: result.skippedChecks };
  }
  if (Number(result.skippedCount) > 0) {
    return { source: "runner", count: Number(result.skippedCount) };
  }
  if (result.skipped === true || (result.skipped && typeof result.skipped === "object")) {
    return { source: "runner", count: Number(result.skipped?.count || 1), details: result.skipped };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const tapSkips = output.match(/^\s*ok\s+\d+\b.*#\s*SKIP\b.*$/gim) || [];
  const emptyTapSkip = output.match(/^\s*1\.\.0\s+#\s*SKIP\b.*$/gim) || [];
  const nodeSummary = [...output.matchAll(/^#\s*skipped\s+(\d+)\s*$/gim)]
    .reduce((count, match) => count + Number(match[1]), 0);
  const count = Math.max(tapSkips.length + emptyTapSkip.length, nodeSummary);
  return count ? { source: "command-output", count } : null;
}

async function executeChecks({ repoPath, targetBranch, targetSha, commands, states, session, runner = runChecked, shellRunner }) {
  const checks = [];
  const policies = commands.map(commandPolicy);
  const baseline = baselineForChecks(states, policies.map((entry) => entry.command), session);
  for (const policy of policies) {
    const { command, required } = policy;
    try {
      const result = await runObservationalIntegrationCommand(command, {
        cwd: repoPath,
        baseline,
        checkStage: "workset-acceptance",
        runner,
        ...(shellRunner ? { shellRunner } : {})
      });
      const skipped = skippedCheckEvidence(result);
      checks.push({
        command,
        required,
        status: skipped ? "skipped" : result.acceptedBaselineFailure ? "accepted-baseline-failure" : "passed",
        ...(skipped ? { skipped } : {}),
        code: result.code,
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      });
    } catch (error) {
      checks.push({
        command,
        required,
        status: "failed",
        code: error.result?.code ?? null,
        error: error.message,
        stdout: error.result?.stdout || "",
        stderr: error.result?.stderr || ""
      });
      break;
    }
  }
  let afterSha;
  try {
    afterSha = await authoritativeTarget(repoPath, targetBranch, runner);
  } catch (error) {
    return { checks, targetMoved: true, afterSha: null, error };
  }
  if (afterSha !== targetSha) {
    return { checks, targetMoved: true, afterSha };
  }
  return { checks, targetMoved: false, afterSha };
}

async function reconcileParentClosure({ config, repoPath, session, scopeAssessment, authorization = null, runner = runChecked, now = new Date() }) {
  const contract = worksetContract(config, session.scope);
  if (!contract?.closeParent || !contract.parentIssue) return null;
  if (session.parentClosure?.state === "confirmed") return session.parentClosure;
  const contractDigest = digest({ contract, scopeRevision: session.scope.revision });
  const acceptance = session.acceptance;
  if (scopeAssessment?.current !== true || scopeAssessment.revision !== session.scope.revision) {
    const error = new Error(`Parent epic closure requires a current live scope at authorized revision ${session.scope.revision}.`);
    error.code = "PARENT_CLOSURE_SCOPE_STALE";
    throw error;
  }
  if (acceptance?.version !== COMPLETION_EVIDENCE_VERSION || acceptance.acceptanceReady !== true || acceptance.authorizedSnapshotSatisfied !== true ||
      acceptance.liveScopeComplete !== true || acceptance.scopeRevision !== session.scope.revision ||
      acceptance.contractDigest !== contractDigest || !acceptance.targetSha) {
    const error = new Error("Parent epic closure requires current verified acceptance evidence after bookkeeping.");
    error.code = "PARENT_CLOSURE_ACCEPTANCE_STALE";
    throw error;
  }
  let currentSha;
  try {
    currentSha = await authoritativeTarget(repoPath, config.defaultBranch || "main", runner);
  } catch (cause) {
    const error = new Error(`Parent epic closure target is no longer the accepted authoritative remote target: ${cause.message}`);
    error.code = "PARENT_CLOSURE_TARGET_MOVED";
    error.cause = cause;
    throw error;
  }
  if (currentSha !== acceptance.targetSha) {
    const error = new Error(`Parent epic closure target moved after acceptance (${acceptance.targetSha} -> ${currentSha}); acceptance must be rerun.`);
    error.code = "PARENT_CLOSURE_TARGET_MOVED";
    throw error;
  }
  if (config.integration?.closeIssues !== true || authorization?.allowedActions?.closeIssue !== true) {
    const error = new Error("Parent epic closure was requested by the workset, but delegated issue-closure authorization is unavailable.");
    error.code = "PARENT_CLOSURE_UNAUTHORIZED";
    throw error;
  }
  const observed = await runner("gh", ["issue", "view", contract.parentIssue, "--repo", config.repository, "--json", "state", "--jq", ".state"], { cwd: repoPath });
  if (observed.stdout.trim().toUpperCase() !== "CLOSED") {
    await runner("gh", ["issue", "close", contract.parentIssue, "--repo", config.repository, "--reason", "completed", "--comment", `Maestro verified workset ${session.scope.workset} at ${session.acceptance?.targetSha || "the authorized target"}.`], { cwd: repoPath });
  }
  return {
    version: 1,
    issue: contract.parentIssue,
    repository: config.repository,
    state: "confirmed",
    confirmedAt: now.toISOString(),
    targetSha: acceptance.targetSha,
    scopeRevision: session.scope.revision
  };
}

async function evaluateCompletion({
  config,
  repoPath,
  session,
  states,
  scopeAssessment,
  priorEvidence = session?.acceptance || null,
  runner = runChecked,
  shellRunner,
  now = new Date()
}) {
  const targetBranch = config.defaultBranch || "main";
  const contract = worksetContract(config, session.scope);
  if (!Array.isArray(session.scope?.issueIds) || !session.scope.issueIds.length) {
    return {
      version: COMPLETION_EVIDENCE_VERSION,
      outcome: "human-action-required",
      verifiedComplete: false,
      authorizedSnapshotSatisfied: false,
      liveScopeComplete: false,
      scopeRevision: session.scope?.revision || null,
      contract,
      unresolved: [{ issue: session.scope?.workset || "scope", category: "empty-scope", reason: "authorized scope has no required members", nextAction: "resolve and explicitly authorize a non-empty scope" }]
    };
  }
  if (!scopeAssessment || scopeAssessment.current !== true) {
    return {
      version: COMPLETION_EVIDENCE_VERSION,
      outcome: "scope-changed",
      verifiedComplete: false,
      authorizedSnapshotSatisfied: false,
      liveScopeComplete: false,
      scopeRevision: session.scope.revision,
      unresolved: [{ issue: session.scope.workset || "scope", category: "scope-changed", reason: scopeAssessment?.reason || "live scope is unavailable", nextAction: session.scope.workset ? `maestro draft --workset ${session.scope.workset} --write` : "maestro status" }]
    };
  }
  if (!contract || !contract.requirements.length) {
    return {
      version: COMPLETION_EVIDENCE_VERSION,
      outcome: "human-action-required",
      verifiedComplete: false,
      authorizedSnapshotSatisfied: false,
      liveScopeComplete: true,
      scopeRevision: session.scope.revision,
      contract: contract || null,
      unresolved: [{ issue: contract?.parentIssue || session.scope.workset || "scope", category: "missing-acceptance", reason: "workset acceptance requirements are missing or materially ambiguous", nextAction: `define worksets.${session.scope.workset}.completionPolicy or acceptance.requirements and explicitly renew the scope` }]
    };
  }
  if (contract.closeParent && config.integration?.closeIssues !== true) {
    return {
      version: COMPLETION_EVIDENCE_VERSION,
      outcome: "human-action-required",
      verifiedComplete: false,
      authorizedSnapshotSatisfied: false,
      liveScopeComplete: true,
      scopeRevision: session.scope.revision,
      contract,
      unresolved: [{ issue: contract.parentIssue, category: "parent-closure-unauthorized", reason: "workset acceptance requests parent closure, but integration.closeIssues is not enabled", nextAction: "update repository policy and explicitly renew authorization" }]
    };
  }

  let targetSha;
  try {
    targetSha = await authoritativeTarget(repoPath, targetBranch, runner);
  } catch (error) {
    return {
      version: COMPLETION_EVIDENCE_VERSION,
      outcome: "human-action-required",
      verifiedComplete: false,
      authorizedSnapshotSatisfied: false,
      liveScopeComplete: true,
      scopeRevision: session.scope.revision,
      targetBranch,
      contract,
      unresolved: [{
        issue: contract.parentIssue || session.scope.issueIds[0],
        category: "target-unavailable",
        reason: `integrated target cannot be inspected: ${error.message}`,
        nextAction: `maestro resume --session ${session.id}`
      }]
    };
  }
  const classified = classifyMembers(config, states, session.scope.issueIds, { targetSha, session });
  for (const member of classified.members.filter((entry) => entry.outcome === "verified" && entry.source !== "external")) {
    const integratedSha = member.evidence?.integratedSha;
    if (!integratedSha) {
      member.outcome = "incomplete";
      member.reason = "integration evidence has no target commit";
    } else {
      try {
        await runner("git", ["merge-base", "--is-ancestor", integratedSha, targetSha], { cwd: repoPath });
      } catch {
        member.outcome = "incomplete";
        member.reason = `integrated commit ${integratedSha} is not present on target ${targetSha}`;
      }
    }
    if (member.outcome !== "verified") classified.unresolved.push({
      issue: member.issue,
      category: "stale-integration",
      reason: member.reason,
      nextAction: `maestro details ${member.issue}`
    });
  }
  const nonBookkeeping = classified.unresolved.filter((entry) => entry.category !== "bookkeeping-pending");
  const contractDigest = digest({ contract, scopeRevision: session.scope.revision });
  const base = {
    version: COMPLETION_EVIDENCE_VERSION,
    evaluatedAt: now.toISOString(),
    scopeRevision: session.scope.revision,
    targetBranch,
    targetSha,
    contract,
    contractDigest,
    members: classified.members,
    authorizedSnapshotSatisfied: nonBookkeeping.length === 0,
    liveScopeComplete: true,
    bookkeepingPendingIssueIds: classified.bookkeepingIssueIds
  };
  if (classified.unresolved.length) {
    const onlyBookkeeping = nonBookkeeping.length === 0;
    return {
      ...base,
      outcome: onlyBookkeeping ? "bookkeeping-pending" : "incomplete",
      verifiedComplete: false,
      acceptanceReady: false,
      unresolved: classified.unresolved,
      nextAction: classified.unresolved[0]?.nextAction || "maestro status"
    };
  }

  if (priorEvidence?.version === COMPLETION_EVIDENCE_VERSION && priorEvidence.verifiedComplete === true && priorEvidence.scopeRevision === session.scope.revision &&
      priorEvidence.targetSha === targetSha && priorEvidence.contractDigest === contractDigest) {
    return { ...priorEvidence, reused: true };
  }

  const checked = await executeChecks({
    repoPath,
    targetBranch,
    targetSha,
    commands: contract.commands,
    states,
    session,
    runner,
    shellRunner
  });
  if (checked.targetMoved) {
    return {
      ...base,
      outcome: "scope-changed",
      verifiedComplete: false,
      checks: checked.checks,
      unresolved: [{ issue: contract.parentIssue || "scope", category: "target-moved", reason: checked.error?.message || `target moved during acceptance evaluation (${targetSha} -> ${checked.afterSha})`, nextAction: `maestro resume --session ${session.id}` }]
    };
  }
  const failed = checked.checks.find((check) => check.status === "failed" || (check.status === "skipped" && check.required));
  if (failed) {
    const reason = failed.status === "skipped"
      ? `${failed.command}: mandatory aggregate check skipped ${failed.skipped?.count || 1} check(s)`
      : `${failed.command}: ${failed.error}`;
    return {
      ...base,
      outcome: "failed-validation",
      verifiedComplete: false,
      checks: checked.checks,
      unresolved: [{ issue: contract.parentIssue || "scope", category: "aggregate-check", reason, nextAction: "maestro details " + (contract.parentIssue || session.scope.issueIds[0]) }]
    };
  }
  if (contract.closeParent && session.parentClosure?.state !== "confirmed") {
    return {
      ...base,
      outcome: "bookkeeping-pending",
      verifiedComplete: false,
      acceptanceReady: true,
      authorizedSnapshotSatisfied: true,
      checks: checked.checks,
      parentClosurePending: true,
      unresolved: [{ issue: contract.parentIssue, category: "bookkeeping-pending", reason: "authorized parent epic closure is pending", nextAction: `maestro resume --session ${session.id}` }]
    };
  }
  return {
    ...base,
    outcome: "verified-complete",
    verifiedComplete: true,
    checks: checked.checks,
    unresolved: [],
    nextAction: contract.closeParent ? "close authorized parent epic" : "maestro status --completed"
  };
}

module.exports = {
  COMPLETION_EVIDENCE_VERSION,
  worksetContract,
  classifyMembers,
  externalVerification,
  authoritativeTarget,
  skippedCheckEvidence,
  executeChecks,
  reconcileParentClosure,
  evaluateCompletion
};

const { digest } = require("./authorization");
const { effectiveIssueStates } = require("./run-resolver");
const { runChecked } = require("./process");
const { runObservationalIntegrationCommand } = require("./integrator");

const COMPLETION_EVIDENCE_VERSION = 1;

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

function baselineForChecks(states, commands) {
  return [...states]
    .sort((left, right) => String(right.runId).localeCompare(String(left.runId)))
    .map((state) => state.baseline)
    .find((baseline) => commands.every((command) => baseline?.results?.some((entry) => entry.command === command))) || null;
}

async function executeChecks({ repoPath, targetBranch, targetSha, commands, states, runner = runChecked, shellRunner }) {
  const checks = [];
  const baseline = baselineForChecks(states, commands);
  for (const command of commands) {
    try {
      const result = await runObservationalIntegrationCommand(command, {
        cwd: repoPath,
        baseline,
        checkStage: "workset-acceptance",
        runner,
        ...(shellRunner ? { shellRunner } : {})
      });
      checks.push({
        command,
        status: result.acceptedBaselineFailure ? "accepted-baseline-failure" : "passed",
        code: result.code,
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      });
    } catch (error) {
      checks.push({
        command,
        status: "failed",
        code: error.result?.code ?? null,
        error: error.message,
        stdout: error.result?.stdout || "",
        stderr: error.result?.stderr || ""
      });
      break;
    }
  }
  const afterSha = await targetHead(repoPath, targetBranch, runner);
  if (afterSha !== targetSha) {
    return { checks, targetMoved: true, afterSha };
  }
  return { checks, targetMoved: false, afterSha };
}

async function reconcileParentClosure({ config, repoPath, session, authorization = null, runner = runChecked, now = new Date() }) {
  const contract = worksetContract(config, session.scope);
  if (!contract?.closeParent || !contract.parentIssue) return null;
  if (config.integration?.closeIssues !== true || authorization?.allowedActions?.closeIssue !== true) {
    const error = new Error("Parent epic closure was requested by the workset, but delegated issue-closure authorization is unavailable.");
    error.code = "PARENT_CLOSURE_UNAUTHORIZED";
    throw error;
  }
  if (session.parentClosure?.state === "confirmed") return session.parentClosure;
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
    targetSha: session.acceptance?.targetSha || null,
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
    targetSha = await targetHead(repoPath, targetBranch, runner);
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

  if (priorEvidence?.verifiedComplete === true && priorEvidence.scopeRevision === session.scope.revision &&
      priorEvidence.targetSha === targetSha && priorEvidence.contractDigest === contractDigest) {
    return { ...priorEvidence, reused: true };
  }

  const checked = await executeChecks({
    repoPath,
    targetBranch,
    targetSha,
    commands: contract.commands,
    states,
    runner,
    shellRunner
  });
  if (checked.targetMoved) {
    return {
      ...base,
      outcome: "scope-changed",
      verifiedComplete: false,
      checks: checked.checks,
      unresolved: [{ issue: contract.parentIssue || "scope", category: "target-moved", reason: `target moved during acceptance evaluation (${targetSha} -> ${checked.afterSha})`, nextAction: `maestro resume --session ${session.id}` }]
    };
  }
  const failed = checked.checks.find((check) => check.status === "failed");
  if (failed) {
    return {
      ...base,
      outcome: "failed-validation",
      verifiedComplete: false,
      checks: checked.checks,
      unresolved: [{ issue: contract.parentIssue || "scope", category: "aggregate-check", reason: `${failed.command}: ${failed.error}`, nextAction: "maestro details " + (contract.parentIssue || session.scope.issueIds[0]) }]
    };
  }
  if (contract.closeParent && session.parentClosure?.state !== "confirmed") {
    return {
      ...base,
      outcome: "bookkeeping-pending",
      verifiedComplete: false,
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
  executeChecks,
  reconcileParentClosure,
  evaluateCompletion
};

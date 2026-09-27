#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parseInvocation, resolveHelp } = require("../src/help");
const { computePlan } = require("../src/planner");
const { computeEffectivePlan, loadExecutionStates } = require("../src/work-state");
const { newRunId, dryRun, executeRun, executeAndIntegrate, continuousRun } = require("../src/controller");
const { latestRunBundle, copyToClipboard } = require("../src/reporter");
const { recordReview } = require("../src/reviews");
const { approveIssues, formatApprovalSummary } = require("../src/approval");
const { discardIssues, formatDiscardSummary } = require("../src/discard");
const { integrateExistingRun } = require("../src/existing-run");
const {
  resolveIssueReworkSources,
  resolveReworkParentRunId,
  reserveManualRework,
  executeReworkRun,
  autoRework,
  DEFAULT_AUTO_REWORK_LIMIT,
  DEFAULT_AUTO_REWORK_TIMEOUT_MS
} = require("../src/rework");
const { resolveReconcileSource, executeReconcileRun } = require("../src/reconcile");
const { executeAdoptedResolution } = require("../src/operation-resolution");
const { latestRunId, loadRunState, saveRunState } = require("../src/run-store");
const { evidenceForIssue, resolveCurrentIssueStates } = require("../src/run-resolver");
const { executeValidatorRetry, formatValidatorRetry } = require("../src/validator-retry");
const { isRecoverableValidatorRework } = require("../src/run-lifecycle");
const { statusSnapshot, formatStatus, watchStatus } = require("../src/display");
const { formatRecommendationFooter, appendRecommendationFooter } = require("../src/recommendations");
const { loadIssueDetails, formatDetails } = require("../src/details");
const { discoverGitHubRepository, loadGitHubIssues } = require("../src/github");
const { proposeDraft, formatDraftSummary, formatDraftVerbose, formatDraftJson, readManifestSnapshot, writeManifest } = require("../src/draft");
const { verifyExecutionSelection } = require("../src/execution-selection");
const { createAgentPlanner } = require("../src/agent-planner");
const { runPlanningAnalyzer } = require("../src/planning-analysis");
const { stableWorksetName, epicWorkset, issueWorkset, explicitIssueRevision, resolveWorksetScope, assertExecutableScope, validateWorksetName } = require("../src/worksets");
const { loadScopeSnapshot, readScopeSnapshot } = require("../src/scope-store");
const { persistScopedDraft } = require("../src/scoped-persistence");
const { reserveReadyWork, reserveExplicitWork, runLifecycleBackfill } = require("../src/scheduler");
const { resolveConcurrency } = require("../src/concurrency");
const { runConfigCommand } = require("../src/config-command");
const { createDelegatedAuthorization, saveAuthorization, loadAuthorization, revokeAuthorization, assessCurrentScope, issuePolicy, digest } = require("../src/authorization");
const { createSession, resolveSession, verifySessionContext, driveSession, requestSessionState } = require("../src/autonomous-controller");
const { loadSession, operationAlive } = require("../src/session-store");
const { loadSessionSummaries, formatSessionSummaries } = require("../src/session-view");
const { processIsRunning } = require("../src/recovery-attempts");
const { evaluateCompletion, reconcileParentClosure } = require("../src/completion");
const { validateRepositoryConfig } = require("../src/config-validator");
const { validateDependencyGraph, validateAdvisoryReferences } = require("../src/planning-analysis");
const {
  resolveRepoPath,
  resolveManifestPath,
  resolveDraftManifestPath,
  looksLikeManifest,
  persistManifestCompletionDurably
} = require("../src/cli-context");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function concurrencyOverride(invocation) {
  return invocation.options["-j"] ?? invocation.options["--concurrency"] ?? null;
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function draftModeCommand(args, mode) {
  const retained = args.filter((value) => !["--write", "--verbose", "--json"].includes(value));
  return ["maestro", ...retained, mode].map(shellArgument).join(" ");
}

function explicitManifest(rest) {
  return looksLikeManifest(rest[0]) ? rest[0] : null;
}

function issuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const start = manifest ? 1 : 0;
  const issues = [];
  for (let index = start; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--run", "--renew", "--workset", "--session", "-j", "--concurrency"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (["--override", "--delegate", "--preview", "--auto-rework", "--rerun", "--retry", "--continuous"].includes(value)) continue;
    if (value.startsWith("--")) throw new Error(`Unknown review option: ${value}`);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  return [...new Set(issues)];
}

function draftIssuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const issues = [];
  for (let index = manifest ? 1 : 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--epic", "--workset", "--name", "-j", "--concurrency"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    if (!/^\d+$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  return [...new Set(issues)];
}

async function resolveSavedWorkset(config, repoPath, name, { refresh = false } = {}) {
  validateWorksetName(name);
  const definition = config.worksets?.[name];
  if (!definition) throw new Error(`Unknown workset '${name}'. Define it with \`maestro draft --epic <number> --name ${name} --write\` or add an explicit source to the manifest.`);
  const saved = await loadScopeSnapshot(repoPath, name);
  if (!refresh) {
    assertExecutableScope(saved);
    if (JSON.stringify(saved.definition) !== JSON.stringify(definition)) {
      throw new Error(`Workset '${name}' definition differs from its saved scope. Run \`maestro draft --workset ${name} --write\` first.`);
    }
    return saved;
  }
  const discoveredRepository = await discoverGitHubRepository(repoPath);
  if (discoveredRepository !== config.repository) {
    throw new Error(`The manifest targets ${config.repository}, but the current checkout is ${discoveredRepository}.`);
  }
  const live = await resolveWorksetScope(name, definition, { repository: config.repository, repoPath });
  assertExecutableScope(live);
  if (!saved) throw new Error(`Workset '${name}' has not been drafted for execution. Run \`maestro draft --workset ${name} --write\` first.`);
  if (saved.revision !== live.revision || JSON.stringify(saved.definition) !== JSON.stringify(definition)) {
    throw new Error(`Workset '${name}' changed since its saved scope revision. Run \`maestro draft --workset ${name} --write\`, review the changes, and retry.`);
  }
  return live;
}

function scopedPlanOptions(snapshot) {
  return snapshot ? { issueIds: snapshot.issueIds, workset: snapshot.name, scopeRevision: snapshot.revision } : {};
}

function detailsIssuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const issues = [];
  for (let index = manifest ? 1 : 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--run"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown maestro details option: ${value}`);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  const unique = [...new Set(issues)];
  if (!unique.length) throw new Error("maestro details requires at least one issue number.");
  return unique;
}

function statusIssuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const issues = [];
  for (let index = manifest ? 1 : 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "-j", "--concurrency"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (["--watch", "--all", "--completed"].includes(value)) continue;
    if (value.startsWith("--")) throw new Error(`Unknown maestro status option: ${value}`);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  return [...new Set(issues)];
}

function reworkPositionals(rest, { reconcile = false, resolve = false } = {}) {
  const issues = [];
  const manifests = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--run", "-j", "--concurrency", ...(reconcile ? ["--issue"] : [])].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (["--allow-failing-baseline", ...(resolve ? ["--agent", "--adopt", "--continue"] : [])].includes(value)) continue;
    if (value.startsWith("--")) throw new Error(`Unknown maestro ${reconcile ? "reconcile" : resolve ? "resolve" : "rework"} option: ${value}`);
    if (looksLikeManifest(value)) {
      manifests.push(value);
      continue;
    }
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  if (manifests.length > 1) {
    throw new Error(`maestro ${reconcile ? "reconcile" : resolve ? "resolve" : "rework"} received multiple manifest paths: ${manifests.join(", ")}.`);
  }
  return { manifest: manifests[0] || null, issues: [...new Set(issues)] };
}

function resolveContext(rest, args, { manifest = true } = {}) {
  const repoPath = resolveRepoPath(option(args, "--repo-path"));
  if (!manifest) return { repoPath };
  const manifestPath = resolveManifestPath(explicitManifest(rest), repoPath);
  return { repoPath, manifestPath };
}

function loadConfig(manifestPath, args) {
  const config = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (args.includes("--allow-failing-baseline")) {
    config.baseline = { ...(config.baseline || {}), allowFailing: true };
  }
  return config;
}

function loadValidatedConfig(manifestPath) {
  const config = loadConfig(manifestPath, []);
  validateRepositoryConfig(config);
  const diagnostics = [
    ...validateDependencyGraph(config.work),
    ...validateAdvisoryReferences(config.work, config.planning?.advisoryConflicts || [])
  ];
  if (diagnostics.length) {
    throw new Error(`Unsafe Maestro manifest: ${diagnostics.map((entry) => entry.reason).join(" ")}`);
  }
  return config;
}

function setResultExitCode(result) {
  if (result.status === "failed") process.exitCode = 1;
  if (result.workers?.some((worker) => worker.exitCode !== 0)) process.exitCode = 1;
  if (result.validations?.some((entry) => entry.verdict !== "approve")) process.exitCode = 1;
}

function setAutoReworkExitCode(result) {
  if (result.issues?.some((entry) => entry.outcome !== "approved")) process.exitCode = 1;
}

async function workflowFooter(config, repoPath, { includeIssues = true, concurrency } = {}) {
  const snapshot = await statusSnapshot(config || { work: {} }, repoPath, [], { concurrency });
  return formatRecommendationFooter(snapshot, { includeIssues });
}

async function outputLatest(repoPath, { copy = true, print = true, config = null, recommendations = false } = {}) {
  const sessions = await loadSessionSummaries(repoPath);
  let bundle;
  try {
    bundle = await latestRunBundle(repoPath);
  } catch (error) {
    if (!sessions.length || !/No Maestro reports found/.test(error.message)) throw error;
    bundle = { runId: null, reportRoot: null, state: null, text: "# Maestro autonomous workflow\n" };
  }
  let text = recommendations
    ? appendRecommendationFooter(bundle.text, await workflowFooter(config, repoPath))
    : bundle.text;
  const sessionText = formatSessionSummaries(sessions);
  if (sessionText) text = `${text.trimEnd()}\n\n${sessionText}`;
  if (print) process.stdout.write(text);
  if (copy) {
    const clipboard = copyToClipboard(text);
    console.error(`Copied Maestro ${bundle.runId ? `run ${bundle.runId}` : "session evidence"} to clipboard using ${clipboard}.`);
  }
  return { ...bundle, text };
}

async function approveLatest({ config, repoPath, runId, requestedIssues, override = false }) {
  const result = await approveIssues({ config, repoPath, runId, requestedIssues, override });
  process.stdout.write(formatApprovalSummary(result));
  return result;
}

async function commitLatest({ config, repoPath, manifestPath, runId, closeIssues }) {
  const resolvedRunId = runId || await latestRunId(repoPath);
  const result = await integrateExistingRun(config, {
    repoPath,
    manifestPath,
    runId: resolvedRunId,
    closeIssues
  });
  const integratedIssues = [...new Set((result.integration || []).map((entry) => String(entry.issue)))];
  const newlyIntegratedIssues = [...new Set((result.newlyIntegrated || []).map((entry) => String(entry.issue)))];
  const newlyIntegrated = new Set(newlyIntegratedIssues);
  const alreadyIntegratedIssues = integratedIssues.filter((issue) => !newlyIntegrated.has(issue));
  let bookkeepingState = await loadRunState(repoPath, resolvedRunId);
  const progress = await persistManifestCompletionDurably({
    repoPath,
    manifestPath,
    issueIds: integratedIssues,
    checkpoint: bookkeepingState.manifestPublication || null,
    onCheckpoint: async (checkpoint) => {
      bookkeepingState.manifestPublication = checkpoint;
      await saveRunState(repoPath, resolvedRunId, bookkeepingState);
    }
  });
  const outcome = result.integrationRecovery
    ? `integration check regression for #${result.integrationRecovery.issue}; correction run ${result.integrationRecovery.runId} is ${result.integrationRecovery.status}`
    : result.nothingToDo
    ? `nothing remaining${alreadyIntegratedIssues.length ? `; already integrated ${alreadyIntegratedIssues.map((issue) => `#${issue}`).join(", ")}` : ""}`
    : [
        newlyIntegratedIssues.length ? `newly integrated ${newlyIntegratedIssues.map((issue) => `#${issue}`).join(", ")}` : null,
        alreadyIntegratedIssues.length ? `already integrated ${alreadyIntegratedIssues.map((issue) => `#${issue}`).join(", ")}` : null
      ].filter(Boolean).join("; ") || "nothing remaining";
  console.log(`Committed Maestro run ${resolvedRunId}: ${outcome}`);
  if (progress.changed.length) console.log(`Advanced ${manifestPath}: ${progress.changed.map((issue) => `#${issue}`).join(", ")}`);
  return { ...result, runId: resolvedRunId, manifestProgress: progress };
}

async function backfillAfterIntegration(config, repoPath, sourceState) {
  const authorizedIssueIds = sourceState.authorization?.scope?.issueIds?.map(String) ||
    sourceState.scope?.authorizedIssueIds?.map(String) || Object.keys(config.work || {});
  const scope = sourceState.scope || null;
  const delegated = sourceState.authorization?.kind === "delegated" && sourceState.authorization.allowedActions?.implement === true;
  const extraState = {
    ...(scope ? { scope } : {}),
    ...(delegated ? { authorization: sourceState.authorization, parentRunId: sourceState.runId } : {})
  };
  return runLifecycleBackfill(config, {
    repoPath,
    authorizedIssueIds,
    planOptions: { issueIds: authorizedIssueIds },
    verifySelection: (issueIds) => verifyExecutionSelection(config, repoPath, issueIds),
    runIdFactory: newRunId,
    extraState,
    executeReserved: ({ runId, reservation }) => executeRun(config, {
      repoPath,
      runId,
      plan: reservation.plan,
      scope,
      reservedState: reservation.state
    })
  });
}

function unresolvedSessionWork(plan, authorizedIssueIds) {
  const authorized = new Set(authorizedIssueIds.map(String));
  const entries = [];
  for (const item of plan.humanGates || []) {
    if (authorized.has(String(item.id))) entries.push({ issue: String(item.id), reason: item.humanGate || "human gate", nextAction: `maestro details ${item.id}` });
  }
  for (const item of plan.blocked || []) {
    if (authorized.has(String(item.id))) entries.push({ issue: String(item.id), reason: `blocked by ${(item.blockedBy || []).map((id) => `#${id}`).join(", ") || "dependency"}`, nextAction: "maestro status" });
  }
  for (const item of plan.deferred || []) {
    if (!authorized.has(String(item.id))) continue;
    entries.push({ issue: String(item.id), reason: item.lifecycle?.state || item.reason || "deferred lifecycle work", nextAction: `maestro details ${item.id}` });
  }
  return [...new Map(entries.map((entry) => [entry.issue, entry])).values()];
}

async function driveAutonomous({ config, repoPath, manifestPath, session }, serviceOverrides = {}) {
  const services = {
    assessCurrentScope,
    autoRework,
    computeEffectivePlan,
    driveSession,
    executeReworkRun,
    executeRun,
    evaluateCompletion,
    integrateExistingRun,
    loadAuthorization,
    loadConfig: loadValidatedConfig,
    loadExecutionStates,
    loadRunState,
    loadSession,
    newRunId,
    persistManifestCompletionDurably,
    processIsRunning,
    processIdentityIsLive: operationAlive,
    reconcileParentClosure,
    reserveReadyWork,
    verifyExecutionSelection,
    ...serviceOverrides
  };
  const authorization = await services.loadAuthorization(repoPath, session.authorization.id);
  const concurrency = resolveConcurrency({ override: session.settings.concurrency, savedDefault: config.defaultConcurrency });
  const authorizedIssueIds = session.scope.issueIds.map(String);
  let firstRunAvailable = !session.lineage.runIds.length;

  async function currentContext(stage) {
    const currentConfig = services.loadConfig(manifestPath);
    const liveAuthorization = await services.loadAuthorization(repoPath, session.authorization.id);
    await verifySessionContext({
      session,
      config: currentConfig,
      repoPath,
      manifestPath,
      authorizationLoader: async () => liveAuthorization
    });
    if (liveAuthorization.policyDigest !== digest(issuePolicy(currentConfig, liveAuthorization.scope.issueIds, liveAuthorization.limits))) {
      const error = new Error(`Autonomous protected policy, checks, capabilities, dependencies, human gates, baseline, or operational limits drifted before ${stage}.`);
      error.code = "SESSION_CONTEXT_DRIFT";
      throw error;
    }
    const liveScope = await services.assessCurrentScope({ config: currentConfig, repoPath, authorization: liveAuthorization });
    if (liveScope.current !== true) {
      const error = new Error(`Autonomous live scope drifted before ${stage}: ${liveScope.reason}`);
      error.code = "SESSION_CONTEXT_DRIFT";
      throw error;
    }
    return { config: currentConfig, authorization: liveAuthorization, scopeAssessment: liveScope };
  }

  function correctionDeadline(currentSession, liveAuthorization) {
    const startedAt = Date.parse(currentSession.startedAt || currentSession.createdAt);
    return startedAt + liveAuthorization.limits.correction.deadlineMs;
  }

  async function integrateCurrent(runId, currentSession) {
    const current = await currentContext("integration");
    return services.integrateExistingRun(current.config, {
      repoPath,
      manifestPath,
      runId,
      integrationCorrectionOptions: {
        recoveryDeadlineAt: correctionDeadline(currentSession, current.authorization),
        recoveryAttemptLimit: current.authorization.limits.correction.retryLimit
      },
      configResolver: async () => (await currentContext("serialized integration")).config
    });
  }

  async function correctCurrent(issueIds, currentSession) {
    const current = await currentContext("correction reservation");
    const deadlineAt = correctionDeadline(currentSession, current.authorization);
    return services.autoRework(current.config, {
      repoPath,
      issueIds,
      retryLimit: current.authorization.limits.correction.retryLimit,
      capacity: concurrency.value,
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      deadlineAt,
      configResolver: async () => (await currentContext("correction reservation")).config,
      reworkOptions: { reserveCapacity: true, concurrency }
    });
  }

  async function settleExecution(execution, sourceRunId, currentSession) {
    const runIds = [String(sourceRunId)];
    const recoveryRunIds = [];
    const issueAttempts = {};
    const integratedIssueIds = [];
    const initialIntegration = await integrateCurrent(sourceRunId, currentSession);
    integratedIssueIds.push(...(initialIntegration.integration || []).map((entry) => String(entry.issue)));
    if (initialIntegration.integrationRecovery?.runId) recoveryRunIds.push(String(initialIntegration.integrationRecovery.runId));

    const reworkIssues = (execution.validations || [])
      .filter((entry) => entry.verdict === "rework")
      .map((entry) => String(entry.issue));
    if (reworkIssues.length) {
      const correction = await correctCurrent(reworkIssues, currentSession);
      for (const item of correction.issues) {
        const correctionRuns = (item.runs || []).map((run) => String(run.runId || run));
        runIds.push(...correctionRuns, String(item.finalRunId));
        recoveryRunIds.push(...correctionRuns);
        issueAttempts[item.issue] = Math.max(Number(item.attemptsUsed || 0), correctionRuns.length);
        if (item.outcome === "approved") {
          const integrated = await integrateCurrent(item.finalRunId, currentSession);
          integratedIssueIds.push(...(integrated.integration || []).map((entry) => String(entry.issue)));
          if (integrated.integrationRecovery?.runId) recoveryRunIds.push(String(integrated.integrationRecovery.runId));
        }
      }
    }
    return {
      runIds: [...new Set(runIds)],
      recoveryRunIds: [...new Set(recoveryRunIds)],
      issueAttempts,
      integratedIssueIds: [...new Set(integratedIssueIds)]
    };
  }

  return services.driveSession({
    config,
    repoPath,
    manifestPath,
    session,
    observe: async (currentSession) => {
      let current;
      try {
        current = await currentContext("reservation");
      } catch (error) {
        if (error.code !== "SESSION_CONTEXT_DRIFT") throw error;
        return {
          readyIssueIds: [],
          remainingIssueIds: authorizedIssueIds,
          unresolved: [{ issue: session.scope.workset || "scope", category: "scope-changed", reason: error.message, nextAction: session.scope.workset ? `maestro draft --workset ${session.scope.workset} --write` : "maestro status" }],
          stopReason: "scope-changed",
          verifiedComplete: false,
          acceptance: { outcome: "scope-changed", verifiedComplete: false, reason: error.message }
        };
      }
      const plan = await services.computeEffectivePlan(current.config, repoPath, { issueIds: authorizedIssueIds, concurrency });
      if (plan.selected.length) await services.verifyExecutionSelection(current.config, repoPath, plan.selected.map((item) => String(item.id)));
      const unresolved = unresolvedSessionWork(plan, authorizedIssueIds);
      const states = await services.loadExecutionStates(repoPath);
      const rootRunConsumed = states.some((state) => String(state.runId) === String(authorization.runId));
      const recordedBySession = new Set(currentSession.progress.integratedIssueIds.map(String));
      const childRunIds = new Set(states
        .filter((state) => state.authorization?.id === authorization.id && state.parentRunId)
        .map((state) => String(state.parentRunId)));
      const recoveryStates = states.filter((state) => {
        if (state.authorization?.id !== authorization.id) return false;
        if (state.mode === "integration-correction" && state.autonomousSessionId !== session.id) return false;
        if (state.autonomousSessionId && state.autonomousSessionId !== session.id) return false;
        if (state.status === "running" && ["autonomous", "execute", "rework"].includes(state.mode)) return true;
        const integrated = new Set((state.integration || []).map((entry) => String(entry.issue)));
        const uncheckpointedIntegration = [...integrated].some((issue) => !recordedBySession.has(issue));
        const pendingPublication = Object.values(state.publications || {}).some((entry) => entry.state !== "recorded");
        const validationByIssue = new Map((state.validations || []).map((entry) => [String(entry.issue), entry]));
        const hasCurrentChild = childRunIds.has(String(state.runId));
        const pendingApproved = !hasCurrentChild && (state.workers || []).some((worker) => validationByIssue.get(String(worker.issue))?.verdict === "approve" && !integrated.has(String(worker.issue)));
        const pendingRework = !hasCurrentChild && (state.workers || []).some((worker) => validationByIssue.get(String(worker.issue))?.verdict === "rework" && !integrated.has(String(worker.issue)));
        const pendingIntegrationCorrection = state.mode === "integration-correction" && (
          state.status === "running" || pendingApproved
        );
        return uncheckpointedIntegration || pendingPublication || pendingApproved || pendingRework || pendingIntegrationCorrection;
      });
      const recoveryRunIds = recoveryStates.map((state) => String(state.parentRunId || state.runId));
      let acceptance = null;
      if (!plan.selected.length && !recoveryRunIds.length) {
        acceptance = await services.evaluateCompletion({
          config: current.config,
          repoPath,
          session: currentSession,
          states,
          scopeAssessment: current.scopeAssessment
        });
      }
      return {
        readyIssueIds: plan.selected.map((item) => String(item.id)),
        remainingIssueIds: [...new Set([...plan.selected.map((item) => String(item.id)), ...unresolved.map((entry) => entry.issue)])],
        unresolved,
        nextAction: unresolved.find((entry) => entry.nextAction)?.nextAction || "maestro status",
        recoveryRunIds: [...new Set(recoveryRunIds)],
        recoveryStates: recoveryStates.map((state) => {
          const correction = Object.entries(state.correction?.attempts || {})[0] || null;
          return {
            runId: String(state.runId),
            mode: state.mode,
            status: state.status,
            parentRunId: state.parentRunId ? String(state.parentRunId) : null,
            issue: state.integrationCorrection?.issue
              ? String(state.integrationCorrection.issue)
              : correction ? String(correction[0]) : null,
            attemptsUsed: state.integrationCorrection?.attempts?.length || Number(correction?.[1]?.number || 0),
            deadlineAt: state.integrationCorrection?.deadlineAt || correction?.[1]?.deadlineAt || null
          };
        }),
        rootRunConsumed,
        recoverable: recoveryRunIds.length > 0,
        stopReason: acceptance?.outcome || (unresolved.length ? "unresolved-work" : "no-ready-work"),
        verifiedComplete: acceptance?.verifiedComplete === true,
        ...(acceptance ? {
          acceptance,
          unresolved: acceptance.unresolved || unresolved,
          remainingIssueIds: (acceptance.unresolved || []).map((entry) => String(entry.issue)).filter((issue) => /^\d+$/.test(issue)),
          nextAction: acceptance.nextAction || unresolved.find((entry) => entry.nextAction)?.nextAction || "maestro status"
        } : {})
      };
    },
    advance: async ({ session: currentSession, observation }) => {
      const current = await currentContext("reservation");
      if (observation.rootRunConsumed) firstRunAvailable = false;
      if (observation.recoveryStates?.length) {
        const integratedIssueIds = [];
        const recoveryRunIds = [];
        const runIds = [];
        const issueAttempts = {};
        for (const recoveryState of observation.recoveryStates) {
          if (["integration-correction", "rework"].includes(recoveryState.mode)) {
            recoveryRunIds.push(String(recoveryState.runId));
          }
          if (recoveryState.issue) {
            issueAttempts[recoveryState.issue] = Math.max(
              Number(issueAttempts[recoveryState.issue] || 0),
              Number(recoveryState.attemptsUsed || 0)
            );
          }
          const sourceRunId = recoveryState.mode === "integration-correction" && recoveryState.parentRunId
            ? recoveryState.parentRunId
            : recoveryState.runId;
          let execution = null;
          if (recoveryState.mode === "rework" && recoveryState.status === "running") {
            const running = await services.loadRunState(repoPath, recoveryState.runId);
            execution = await services.executeReworkRun(current.config, {
              repoPath,
              sourceRunId: running.parentRunId,
              runId: running.runId,
              issueIds: running.plan.selected.map((item) => String(item.id)),
              reservedState: running,
              automatic: true,
              retryLimit: current.authorization.limits.correction.retryLimit,
              deadlineAt: correctionDeadline(currentSession, current.authorization)
            });
          } else if (["autonomous", "execute"].includes(recoveryState.mode) && recoveryState.status === "running") {
            const running = await services.loadRunState(repoPath, recoveryState.runId);
            for (const operation of Object.values(running.operations || {})) {
              if (operation.stage === "complete") continue;
              const pidIsLive = services.processIsRunning(operation.processId);
              if (pidIsLive && !operation.processStartTime) {
                const error = new Error(`Run ${running.runId} has a live ${operation.stage} process ${operation.processId} without reliable process identity; resume will not duplicate it.`);
                error.code = "SESSION_OPERATION_IDENTITY_UNAVAILABLE";
                throw error;
              }
              if (pidIsLive && await services.processIdentityIsLive(operation)) {
                const error = new Error(`Run ${running.runId} still has a live ${operation.stage} process ${operation.processId}; resume will not duplicate it.`);
                error.code = "SESSION_OPERATION_RUNNING";
                throw error;
              }
              operation.resumedAt = new Date().toISOString();
            }
            execution = await services.executeRun(current.config, {
              repoPath,
              runId: running.runId,
              plan: running.plan,
              authorization: running.authorization,
              parentRunId: running.parentRunId || null,
              reservedState: running
            });
          } else if (["autonomous", "execute", "rework"].includes(recoveryState.mode)) {
            execution = await services.loadRunState(repoPath, recoveryState.runId);
          }
          if (execution) {
            const settled = await settleExecution(execution, sourceRunId, currentSession);
            runIds.push(...settled.runIds);
            integratedIssueIds.push(...settled.integratedIssueIds);
            recoveryRunIds.push(...settled.recoveryRunIds, ...settled.runIds.filter((id) => id !== String(sourceRunId)));
            for (const [issue, count] of Object.entries(settled.issueAttempts)) issueAttempts[issue] = count;
          } else {
            const integrationRunId = recoveryState.mode === "integration-correction" && recoveryState.status !== "running"
              ? recoveryState.runId
              : sourceRunId;
            const recovered = await integrateCurrent(integrationRunId, currentSession);
            integratedIssueIds.push(...(recovered.integration || []).map((entry) => String(entry.issue)));
            if (recovered.integrationRecovery?.runId) recoveryRunIds.push(String(recovered.integrationRecovery.runId));
          }
        }
        return {
          kind: "integration-recovery",
          runIds: [...new Set([...observation.recoveryStates.map((entry) => entry.runId), ...runIds])],
          recoveryRunIds,
          issueAttempts,
          integratedIssueIds: [...new Set(integratedIssueIds)],
          bookkeepingPendingIssueIds: [...new Set(integratedIssueIds)],
          progressed: integratedIssueIds.length > 0 || recoveryRunIds.length > 0
        };
      }
      const runId = firstRunAvailable ? current.authorization.runId : services.newRunId();
      firstRunAvailable = false;
      const reservation = await services.reserveReadyWork(current.config, {
        repoPath,
        runId,
        mode: "autonomous",
        authorizedIssueIds,
        planOptions: { issueIds: authorizedIssueIds, concurrency },
        extraState: {
          authorization: current.authorization,
          autonomousSessionId: session.id,
          ...(runId !== current.authorization.runId ? { parentRunId: current.authorization.runId } : {})
        }
      });
      if (!reservation.reserved) return { progressed: false, stopReason: reservation.capacity?.idle?.kind || reservation.reason || "capacity-unavailable" };
      const execution = await services.executeRun(current.config, {
        repoPath,
        runId,
        plan: reservation.plan,
        authorization: current.authorization,
        parentRunId: runId !== current.authorization.runId ? current.authorization.runId : null,
        reservedState: reservation.state,
      });
      const settled = await settleExecution(execution, runId, currentSession);
      return {
        kind: "lifecycle-wave",
        runIds: settled.runIds,
        recoveryRunIds: settled.recoveryRunIds,
        issueAttempts: settled.issueAttempts,
        integratedIssueIds: settled.integratedIssueIds,
        bookkeepingPendingIssueIds: settled.integratedIssueIds,
        // A worker/validator/rework gate is durable lifecycle progress even
        // when it is issue-local and integrates nothing. Reconciliation will
        // continue independent authorized work before quiescing on the gate.
        progressed: true
      };
    },
    finalize: async ({ session: currentSession, update }) => {
      const parentClosurePending = currentSession.acceptance?.parentClosurePending === true && currentSession.parentClosure?.state !== "confirmed";
      if (!currentSession.progress.bookkeepingPendingIssueIds.length && !currentSession.progress.integratedIssueIds.length && !parentClosurePending) {
        return currentSession;
      }
      currentSession = await update((state) => {
        state.phase = "bookkeeping";
        state.checkpoints.push({
          kind: "bookkeeping-intent",
          at: new Date().toISOString(),
          issueIds: state.progress.integratedIssueIds.map(String)
        });
        return state;
      });
      try {
        const progress = currentSession.progress.integratedIssueIds.length ? await services.persistManifestCompletionDurably({
          repoPath,
          manifestPath,
          issueIds: currentSession.progress.integratedIssueIds,
          checkpoint: currentSession.progress.manifestPublication || null,
          onCheckpoint: async (publication) => {
            currentSession = await update((state) => {
              state.progress.manifestPublication = publication;
              state.checkpoints.push({
                kind: "bookkeeping-checkpoint",
                at: new Date().toISOString(),
                state: publication.state,
                candidateSha: publication.candidateSha || null
              });
              return state;
            });
          }
        }) : { changed: [], committed: false };
        currentSession = await update((state) => {
          state.progress.bookkeepingPendingIssueIds = [];
          state.checkpoints.push({
            kind: "bookkeeping-settled",
            at: new Date().toISOString(),
            changedIssueIds: progress.changed,
            committed: progress.committed
          });
          return state;
        });
        // Publication may make previously pending members acceptable. Re-evaluate
        // before closure, then persist one final verification after closure.
        {
          const current = await currentContext("parent closure acceptance");
          const states = await services.loadExecutionStates(repoPath);
          const acceptance = await services.evaluateCompletion({
            config: current.config,
            repoPath,
            session: currentSession,
            states,
            scopeAssessment: current.scopeAssessment
          });
          currentSession = await update((state) => {
            state.acceptance = acceptance;
            state.terminal = {
              ...state.terminal,
              verifiedComplete: acceptance.verifiedComplete === true,
              outcome: acceptance.outcome,
              authorizedSnapshotSatisfied: acceptance.authorizedSnapshotSatisfied === true,
              liveScopeComplete: acceptance.liveScopeComplete === true,
              targetSha: acceptance.targetSha || null,
              scopeRevision: acceptance.scopeRevision || null,
              unresolved: acceptance.unresolved || [],
              nextAction: acceptance.nextAction || `maestro resume --session ${state.id}`
            };
            state.checkpoints.push({
              kind: "post-bookkeeping-acceptance",
              at: new Date().toISOString(),
              outcome: acceptance.outcome,
              targetSha: acceptance.targetSha || null
            });
            return state;
          });
          if (acceptance.acceptanceReady === true && acceptance.parentClosurePending === true) {
            const closureCurrent = await currentContext("parent closure");
            const closure = await services.reconcileParentClosure({
              config: closureCurrent.config,
              repoPath,
              session: currentSession,
              scopeAssessment: closureCurrent.scopeAssessment,
              authorization
            });
            currentSession = await update((state) => {
              state.parentClosure = closure;
              state.checkpoints.push({ kind: "parent-closure-confirmed", at: new Date().toISOString(), issue: closure.issue });
              return state;
            });
            const verifiedCurrent = await currentContext("post-closure acceptance");
            const verifiedStates = await services.loadExecutionStates(repoPath);
            const verifiedAcceptance = await services.evaluateCompletion({
              config: verifiedCurrent.config,
              repoPath,
              session: currentSession,
              states: verifiedStates,
              scopeAssessment: verifiedCurrent.scopeAssessment
            });
            currentSession = await update((state) => {
              state.acceptance = verifiedAcceptance;
              state.terminal = {
                ...state.terminal,
                verifiedComplete: verifiedAcceptance.verifiedComplete === true,
                outcome: verifiedAcceptance.outcome,
                authorizedSnapshotSatisfied: verifiedAcceptance.authorizedSnapshotSatisfied === true,
                liveScopeComplete: verifiedAcceptance.liveScopeComplete === true,
                targetSha: verifiedAcceptance.targetSha || null,
                scopeRevision: verifiedAcceptance.scopeRevision || null,
                unresolved: verifiedAcceptance.unresolved || [],
                nextAction: verifiedAcceptance.nextAction || `maestro resume --session ${state.id}`
              };
              state.checkpoints.push({
                kind: "post-closure-acceptance",
                at: new Date().toISOString(),
                outcome: verifiedAcceptance.outcome,
                targetSha: verifiedAcceptance.targetSha || null
              });
              return state;
            });
          }
        }
        return update((state) => {
          state.phase = "bookkeeping-complete";
          state.checkpoints.push({
            kind: "bookkeeping-result",
            at: new Date().toISOString(),
            changedIssueIds: progress.changed,
            committed: progress.committed
          });
          return state;
        });
      } catch (error) {
        error.message = `Autonomous code integration is durable, but manifest bookkeeping remains pending: ${error.message}`;
        throw error;
      }
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const help = resolveHelp(args);
  if (help.requested) {
    process.stdout.write(`${help.text}\n`);
    return;
  }
  const invocation = parseInvocation(args);
  const command = invocation.command;
  const rest = args.slice(1);

  if (command === "revoke") {
    const repoPath = resolveRepoPath(option(args, "--repo-path"));
    const authorization = await revokeAuthorization(repoPath, invocation.positionals[0]);
    process.stdout.write(`${JSON.stringify({ authorizationId: authorization.id, status: authorization.status, revokedAt: authorization.revokedAt }, null, 2)}\n`);
    return;
  }

  if (command === "pause" || command === "stop") {
    const repoPath = resolveRepoPath(option(args, "--repo-path"));
    const session = await loadSession(repoPath, invocation.positionals[0]);
    const updated = await requestSessionState(repoPath, session, command);
    process.stdout.write(`${JSON.stringify({ sessionId: updated.id, status: updated.status, stopReason: updated.stopReason || null, activeOwner: updated.owner?.pid || null }, null, 2)}\n`);
    return;
  }

  if (command === "config") {
    const repoPath = resolveRepoPath(invocation.options["--repo-path"]);
    const positionalManifest = looksLikeManifest(invocation.positionals[0]) ? invocation.positionals[0] : null;
    if (positionalManifest && invocation.options["--manifest"]) {
      throw new Error("maestro config accepts one explicit manifest path, either as the first argument or with --manifest.");
    }
    const manifestPath = resolveManifestPath(invocation.options["--manifest"] || positionalManifest, repoPath);
    const [action, key, value] = positionalManifest ? invocation.positionals.slice(1) : invocation.positionals;
    process.stdout.write(runConfigCommand({ action, key, value, manifestPath }));
    return;
  }

  if (command === "output") {
    const { repoPath } = resolveContext(rest, args, { manifest: false });
    const defaultManifestPath = path.join(repoPath, ".maestro.json");
    const config = fs.existsSync(defaultManifestPath) ? loadConfig(defaultManifestPath, args) : null;
    await outputLatest(repoPath, { copy: true, print: true, config, recommendations: true });
    return;
  }

  if (command === "report") {
    const { repoPath } = resolveContext(rest, args, { manifest: false });
    await outputLatest(repoPath, { copy: args.includes("--copy"), print: true });
    return;
  }

  if (command === "draft") {
    const repoPath = resolveRepoPath(option(args, "--repo-path"));
    const manifestPath = resolveDraftManifestPath(explicitManifest(rest), repoPath);
    const requestedIssues = draftIssuePositionals(rest);
    if (args.includes("--all") && requestedIssues.length) {
      throw new Error("maestro draft accepts either selected issue numbers or --all, not both.");
    }
    const repository = await discoverGitHubRepository(repoPath);
    const manifestSnapshot = readManifestSnapshot(manifestPath);
    const existingConfig = manifestSnapshot.config;
    const concurrency = resolveConcurrency({
      override: concurrencyOverride(invocation),
      savedDefault: existingConfig?.defaultConcurrency
    });
    const epicNumber = option(args, "--epic");
    const selectedWorkset = option(args, "--workset");
    const requestedName = option(args, "--name");
    if (requestedName && !epicNumber && !requestedIssues.length) throw new Error("--name requires --epic or explicit issue numbers.");
    if (selectedWorkset && requestedName) throw new Error("--name cannot be combined with --workset.");
    let worksetProposal = null;
    let scope = null;
    let priorScope = null;
    let priorScopeContents;
    if (epicNumber) {
      const name = validateWorksetName(requestedName || stableWorksetName(epicNumber));
      const definition = epicWorkset(repository, epicNumber);
      const prior = existingConfig?.worksets?.[name];
      if (prior && JSON.stringify(prior.source) !== JSON.stringify(definition.source)) {
        throw new Error(`Workset '${name}' already has a different source; choose a new name instead of replacing its identity.`);
      }
      worksetProposal = { name, definition: prior || definition };
      scope = await resolveWorksetScope(name, worksetProposal.definition, { repository, repoPath });
    } else if (selectedWorkset) {
      const name = validateWorksetName(selectedWorkset);
      const definition = existingConfig?.worksets?.[name];
      if (!definition) throw new Error(`Unknown workset '${name}'.`);
      worksetProposal = { name, definition };
      scope = await resolveWorksetScope(name, definition, { repository, repoPath });
    } else if (requestedName) {
      const name = validateWorksetName(requestedName);
      const definition = issueWorkset(repository, requestedIssues);
      const prior = existingConfig?.worksets?.[name];
      if (prior && JSON.stringify(prior.source) !== JSON.stringify(definition.source)) {
        throw new Error(`Workset '${name}' already has a different source; choose a new name instead of replacing its identity.`);
      }
      worksetProposal = { name, definition: prior || definition };
      scope = await resolveWorksetScope(name, worksetProposal.definition, { repository, repoPath });
    }
    if (scope) {
      const prior = await readScopeSnapshot(repoPath, scope.name);
      priorScope = prior.snapshot;
      priorScopeContents = prior.contents;
    }
    const worksetMemberships = {};
    for (const name of Object.keys(existingConfig?.worksets || {})) {
      if (name === scope?.name) continue;
      const snapshot = await loadScopeSnapshot(repoPath, name);
      if (snapshot?.complete) worksetMemberships[name] = snapshot.issueIds;
    }
    const effectiveIssueIds = scope ? scope.issueIds : requestedIssues;
    let issues = scope ? [...scope.issues, ...scope.supportingIssues] : await loadGitHubIssues(repository, requestedIssues, { repoPath });
    if (scope) {
      const loaded = new Set(issues.map((issue) => String(issue.number)));
      const repositoryContextIds = Object.keys(existingConfig?.work || {}).filter((id) => !loaded.has(String(id)));
      if (repositoryContextIds.length) {
        issues = [...issues, ...await loadGitHubIssues(repository, repositoryContextIds, { repoPath })];
      }
    }
    const executionStates = await loadExecutionStates(repoPath);
    const deterministicResult = proposeDraft({
      repository,
      existingConfig,
      issues,
      selectedIssueIds: effectiveIssueIds,
      supportingIssueIds: scope?.supportingIssueIds || [],
      executionStates,
      worksetProposal,
      analysisScope: worksetProposal?.name || null,
      worksetMemberships,
      concurrency
    });
    if (scope?.diagnostics.length) {
      deterministicResult.diagnostics.push(...scope.diagnostics.map((item) => ({ issue: item.issue?.number || null, reason: item.reason })));
      deterministicResult.writable = false;
    }
    let agentAnalysis = null;
    if (args.includes("--agent") && (!scope || scope.complete)) {
      const contextManifest = JSON.parse(JSON.stringify(deterministicResult.manifest));
      const analyzerOwner = worksetProposal ? `agent:${worksetProposal.name}` : "agent";
      if (worksetProposal && contextManifest.planning?.agentAnalyses) delete contextManifest.planning.agentAnalyses[worksetProposal.name];
      else if (contextManifest.planning?.agentAnalysis) delete contextManifest.planning.agentAnalysis;
      if (contextManifest.planning?.advisoryConflicts) {
        contextManifest.planning.advisoryConflicts = contextManifest.planning.advisoryConflicts.filter((conflict) => conflict.analyzer !== analyzerOwner);
        if (!contextManifest.planning.advisoryConflicts.length) delete contextManifest.planning.advisoryConflicts;
      }
      if (contextManifest.planning && !Object.keys(contextManifest.planning).length) delete contextManifest.planning;
      agentAnalysis = await runPlanningAnalyzer(createAgentPlanner(), {
        repoPath,
        repository,
        issues,
        manifest: contextManifest,
        deterministicFindings: {
          dependencies: deterministicResult.dependencySources,
          conflicts: deterministicResult.inferredConflicts.filter((conflict) => conflict.analyzer !== analyzerOwner),
          activeWork: deterministicResult.activeWork,
          unresolved: deterministicResult.unresolved,
          expectedWaves: deterministicResult.planning.waves
        },
        scope: scope ? { name: scope.name, membership: scope.membership, parent: scope.parent, revision: scope.revision } : null
      });
    }
    const result = agentAnalysis ? proposeDraft({
      repository,
      existingConfig,
      issues,
      selectedIssueIds: effectiveIssueIds,
      supportingIssueIds: scope?.supportingIssueIds || [],
      agentAnalysis,
      executionStates,
      worksetProposal,
      analysisScope: worksetProposal?.name || null,
      worksetMemberships,
      concurrency
    }) : deterministicResult;
    if (scope?.diagnostics.length && result !== deterministicResult) {
      result.diagnostics.push(...scope.diagnostics.map((item) => ({ issue: item.issue?.number || null, reason: item.reason })));
      result.writable = false;
    }
    if (scope) {
      const missingGraphMembers = scope.issueIds.filter((id) => !result.manifest.work?.[id]);
      if (missingGraphMembers.length) {
        result.diagnostics.push(...missingGraphMembers.map((id) => ({ issue: id, reason: "Resolved workset member is absent from the shared work graph." })));
        result.writable = false;
      }
      const priorIds = new Set(priorScope?.issueIds || []);
      const currentIds = new Set(scope.issueIds);
      result.workset.scopeChanges = {
        added: scope.issueIds.filter((id) => !priorIds.has(id)),
        removed: [...priorIds].filter((id) => !currentIds.has(id)),
        factsChanged: Boolean(priorScope && priorScope.revision !== scope.revision && scope.issueIds.every((id) => priorIds.has(id)) && priorIds.size === scope.issueIds.length)
      };
      result.scopeChanged = !priorScope || priorScope.revision !== scope.revision;
    }
    const write = args.includes("--write");
    const formatter = args.includes("--json") ? formatDraftJson : args.includes("--verbose") ? formatDraftVerbose : formatDraftSummary;
    const format = (outcome) => formatter({
      repository,
      manifestPath,
      result,
      write,
      outcome,
      width: process.stdout.columns || 80,
      writeCommand: draftModeCommand(args, "--write"),
      verboseCommand: draftModeCommand(args, "--verbose"),
      jsonCommand: draftModeCommand(args, "--json")
    });
    if (write && !result.writable) {
      process.stdout.write(format({ requested: true, status: "blocked" }));
      process.exitCode = 1;
      return;
    }
    if (!write) {
      process.stdout.write(format({ requested: false, status: "preview" }));
      return;
    }
    try {
      const written = scope
        ? persistScopedDraft({
            repoPath,
            manifestPath,
            manifest: result.manifest,
            persistManifest: result.changed,
            expectedManifestContents: manifestSnapshot.contents,
            expectedSnapshotContents: priorScopeContents,
            name: scope.name,
            snapshot: scope
          }).manifestWritten
        : result.changed && writeManifest(manifestPath, result.manifest, { expectedContents: manifestSnapshot.contents });
      process.stdout.write(format({ requested: true, status: written ? "written" : scope && result.scopeChanged ? "scope-refreshed" : "no-op" }));
    } catch (error) {
      process.stdout.write(format({ requested: true, status: "failed", error: error.message }));
      process.exitCode = 1;
    }
    return;
  }

  const reworkArgs = command === "rework" ? reworkPositionals(rest) : null;
  const reconcileArgs = command === "reconcile" ? reworkPositionals(rest, { reconcile: true }) : null;
  const resolutionArgs = command === "resolve" ? reworkPositionals(rest, { resolve: true }) : null;
  let context;
  if (reworkArgs || reconcileArgs || resolutionArgs) {
    const repoPath = resolveRepoPath(option(args, "--repo-path"));
    context = { repoPath, manifestPath: resolveManifestPath((reworkArgs || reconcileArgs || resolutionArgs).manifest, repoPath) };
  } else {
    context = resolveContext(rest, args);
  }
  const { repoPath, manifestPath } = context;
  const config = loadConfig(manifestPath, args);
  const concurrency = resolveConcurrency({ override: concurrencyOverride(invocation), savedDefault: config.defaultConcurrency });

  if (command === "plan") {
    const worksetName = option(args, "--workset");
    const scope = worksetName ? await resolveSavedWorkset(config, repoPath, worksetName) : null;
    process.stdout.write(`${JSON.stringify(computePlan(config, { ...scopedPlanOptions(scope), concurrency }), null, 2)}\n`);
    return;
  }

  if (command === "status") {
    const requestedIssues = statusIssuePositionals(rest);
    const view = args.includes("--all") ? "all" : args.includes("--completed") ? "completed" : "default";
    const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
    if (args.includes("--watch")) await watchStatus(config, repoPath, requestedIssues, { concurrency, view, columns });
    else process.stdout.write(formatStatus(await statusSnapshot(config, repoPath, requestedIssues, { concurrency, view }), { columns }));
    return;
  }

  if (command === "details") {
    const requestedIssues = detailsIssuePositionals(rest);
    const details = await loadIssueDetails(repoPath, requestedIssues, {
      runId: option(args, "--run"),
      config
    });
    process.stdout.write(formatDetails(details, { repository: config.repository }));
    return;
  }

  if (command === "resume") {
    const issues = issuePositionals(rest);
    if (issues.length > 1) throw new Error("maestro resume accepts at most one issue number.");
    const selected = await resolveSession(repoPath, {
      sessionId: option(args, "--session"),
      workset: option(args, "--workset"),
      issue: issues[0] || null
    });
    const result = await driveAutonomous({ config, repoPath, manifestPath, session: selected });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "complete") process.exitCode = 1;
    return;
  }

  if (command === "start" || command === "next") {
    const delegated = args.includes("--delegate");
    const delegatedIssues = command === "start" ? issuePositionals(rest) : [];
    if (delegatedIssues.length && !delegated) throw new Error("Explicit issue selection on maestro start requires --delegate; ordinary start remains supervised.");
    if (option(args, "--renew") && !delegated) throw new Error("--renew requires --delegate and a newly resolved scope.");
    if (args.includes("--preview") && !delegated) throw new Error("--preview requires --delegate.");
    if (args.includes("--continuous") && (!delegated || command !== "start")) {
      throw new Error("--continuous is available only with an explicit delegated start.");
    }
    const worksetName = option(args, "--workset");
    if (delegated && !delegatedIssues.length && !worksetName) throw new Error("--delegate requires explicit issue numbers or --workset so authorization scope is bounded.");
    const scope = worksetName ? await resolveSavedWorkset(config, repoPath, worksetName, { refresh: true }) : null;
    if (delegatedIssues.length && worksetName) throw new Error("Delegated start accepts either explicit issues or --workset, not both.");
    const planOptions = { ...(delegatedIssues.length ? { issueIds: delegatedIssues } : scopedPlanOptions(scope)), concurrency };
    const candidatePlan = args.includes("--rerun") ? computePlan(config, planOptions) : await computeEffectivePlan(config, repoPath, planOptions);
    const selectedIssueIds = candidatePlan.selected.map((item) => item.id);
    const authorizedScopeIds = delegatedIssues.length ? delegatedIssues : scope?.issueIds || candidatePlan.selected.map((item) => String(item.id));
    const verifiedIssues = await verifyExecutionSelection(config, repoPath, delegatedIssues.length ? authorizedScopeIds : selectedIssueIds);
    const authorization = scope ? {
      workset: scope.name,
      revision: scope.revision,
      membership: scope.membership,
      authorizedIssueIds: scope.issueIds,
      authorizedAt: new Date().toISOString(),
      source: "explicit-workset-launch"
    } : null;
    const requestedRunId = newRunId();
    let delegatedAuthorization = null;
    if (delegated) {
      const renewalId = option(args, "--renew");
      if (renewalId) await loadAuthorization(repoPath, renewalId);
      delegatedAuthorization = createDelegatedAuthorization({
        config, repoPath, runId: requestedRunId, issueIds: authorizedScopeIds,
        scope: scope
          ? { workset: scope.name, revision: scope.revision }
          : { revision: explicitIssueRevision(config.repository, authorizedScopeIds, verifiedIssues) },
        limits: {
          concurrency: candidatePlan.concurrency,
          correction: {
            enabled: args.includes("--auto-rework") || args.includes("--continuous"),
            retryLimit: args.includes("--auto-rework") || args.includes("--continuous") ? DEFAULT_AUTO_REWORK_LIMIT : 0,
            deadlineMs: args.includes("--auto-rework") || args.includes("--continuous") ? DEFAULT_AUTO_REWORK_TIMEOUT_MS : 0
          }
        },
        renews: renewalId
      });
      if (args.includes("--preview")) {
        process.stdout.write(`${JSON.stringify({ preview: true, persisted: false, authorization: delegatedAuthorization }, null, 2)}\n`);
        return;
      }
      await saveAuthorization(repoPath, delegatedAuthorization);
    }
    if (args.includes("--continuous")) {
      const autonomousScope = scope
        ? { type: "workset", workset: scope.name, issueIds: authorizedScopeIds.map(String), revision: scope.revision }
        : { type: "issues", issueIds: authorizedScopeIds.map(String), revision: delegatedAuthorization.scope.revision };
      const session = await createSession({
        config,
        repoPath,
        manifestPath,
        scope: autonomousScope,
        authorization: delegatedAuthorization,
        settings: {
          concurrency: candidatePlan.concurrency,
          correction: delegatedAuthorization.limits.correction
        }
      });
      const result = await driveAutonomous({ config, repoPath, manifestPath, session });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== "complete") process.exitCode = 1;
      return;
    }
    const authorizationState = {
      ...(authorization ? { scope: authorization } : {}),
      ...(delegatedAuthorization ? { authorization: delegatedAuthorization } : {})
    };
    const reservation = args.includes("--rerun")
      ? await reserveExplicitWork(config, {
          repoPath,
          runId: requestedRunId,
          mode: "rerun",
          items: candidatePlan.selected,
          planOptions,
          extraState: authorizationState
        })
      : await reserveReadyWork(config, {
          repoPath,
          runId: requestedRunId,
          mode: "execute",
          authorizedIssueIds: selectedIssueIds,
          planOptions,
          extraState: authorizationState
        });
    if (args.includes("--rerun") && !reservation.reserved && selectedIssueIds.length) {
      throw new Error(`Cannot reserve worker capacity for rerun: ${reservation.reason}.`);
    }
    const plan = reservation.plan || { ...candidatePlan, selected: [] };
    const authorizedIssueIds = delegatedIssues.length ? delegatedIssues : scope?.issueIds?.map(String) || Object.keys(config.work || {});
    const lifecycleOutcomes = [];
    const automaticRework = args.includes("--auto-rework");
    const automaticTimeoutMs = DEFAULT_AUTO_REWORK_TIMEOUT_MS;
    const automaticDeadlineAt = Date.now() + automaticTimeoutMs;
    const resumableCorrections = automaticRework
      ? candidatePlan.deferred
        ?.filter((item) => item.lifecycle?.state === "awaiting-rework")
        .map((item) => ({ issue: String(item.id) })) || []
      : [];

    const correctionTasksForResult = (settledResult, onlyIssue = null) => {
      const reviewed = settledResult.reviews || {};
      return (settledResult.validations || [])
        .filter((entry) => (
          entry.verdict === "rework" &&
          !reviewed[String(entry.issue)] &&
          (!onlyIssue || String(entry.issue) === String(onlyIssue))
        ))
        .map((entry) => ({ issue: String(entry.issue) }));
    };

    const driveLifecycle = async (initialTasks = []) => {
      const outcomes = await runLifecycleBackfill(config, {
        repoPath,
        authorizedIssueIds,
        planOptions,
        initialTasks,
        ...(automaticRework ? {
          reserveInitial: async (task) => {
            const [resolved] = await resolveCurrentIssueStates(repoPath, [task.issue]);
            const runId = newRunId();
            const correctionReservation = await reserveExplicitWork(config, {
              repoPath,
              runId,
              mode: "rework",
              items: [{ id: task.issue, ...(config.work?.[task.issue] || {}), mode: "rework" }],
              expectedCurrent: [{ issue: task.issue, runId: resolved.runId }],
              currentEligibility: (current) => (
                current.evidence?.state === "awaiting-rework" &&
                isRecoverableValidatorRework(current.evidence)
              ),
              planOptions,
              extraState: {
                ...authorizationState,
                parentRunId: resolved.runId
              }
            });
            return {
              ...correctionReservation,
              runId,
              resolved: correctionReservation.current?.[0] || resolved,
              terminal: correctionReservation.reason === "changed-evidence"
            };
          },
          executeInitial: (task, prepared) => autoRework(config, {
            repoPath,
            issueIds: [task.issue],
            capacity: 1,
            timeoutMs: Math.max(1, automaticDeadlineAt - Date.now()),
            initialReservations: {
              [task.issue]: { runId: prepared.runId, reservedState: prepared.state, resolved: prepared.resolved }
            },
            reworkOptions: { reserveCapacity: true, concurrency }
          }),
          tasksAfterOutcome: (settledResult) => correctionTasksForResult(settledResult)
        } : {}),
        verifySelection: (issueIds) => verifyExecutionSelection(config, repoPath, issueIds),
        runIdFactory: newRunId,
        extraState: {
          ...authorizationState,
          ...(delegatedAuthorization ? { parentRunId: requestedRunId } : {})
        },
        executeReserved: ({ runId, reservation: backfillReservation }) => executeRun(config, {
          repoPath,
          runId,
          plan: backfillReservation.plan,
          scope: authorization,
          reservedState: backfillReservation.state
        })
      });
      lifecycleOutcomes.push(...outcomes);
    };

    const backfillOnOriginalSettlement = !args.includes("--rerun")
      ? async (settlement) => {
          const initialTasks = automaticRework
            ? [
                ...resumableCorrections.splice(0),
                ...correctionTasksForResult(settlement.result, settlement.issue)
              ]
            : [];
          await driveLifecycle(initialTasks);
        }
      : undefined;
    const result = await executeRun(config, {
      repoPath,
      plan,
      runId: requestedRunId,
      scope: authorization,
      ...(backfillOnOriginalSettlement ? { onIssueSettled: backfillOnOriginalSettlement } : {}),
      ...(reservation.reserved ? { reservedState: reservation.state } : {})
    });
    let automatic = null;
    if (automaticRework) {
      await driveLifecycle(resumableCorrections.splice(0));
      const corrections = lifecycleOutcomes.filter((entry) => entry?.mode === "auto-rework");
      automatic = {
        mode: "auto-rework",
        retryLimit: corrections[0]?.retryLimit || DEFAULT_AUTO_REWORK_LIMIT,
        capacity: reservation.capacity?.limit ?? candidatePlan.concurrency,
        timeoutMs: automaticTimeoutMs,
        issues: corrections.flatMap((entry) => entry.issues || [])
      };
    }
    const backfill = lifecycleOutcomes.filter((entry) => entry?.mode !== "auto-rework");
    const output = automatic
      ? { ...result, autoRework: automatic, backfill }
      : backfill.length ? { ...result, backfill } : result;
    let delegatedIntegration = [];
    if (delegatedAuthorization) {
      const runIds = [...new Set([
        requestedRunId,
        ...lifecycleOutcomes.map((entry) => entry?.runId).filter(Boolean),
        ...lifecycleOutcomes.flatMap((entry) => (entry?.issues || []).flatMap((issue) => [issue.finalRunId, ...(issue.runs || [])])).filter(Boolean)
      ])];
      for (const delegatedRunId of runIds) {
        const integrated = await integrateExistingRun(config, { repoPath, manifestPath, runId: delegatedRunId });
        delegatedIntegration.push({
          runId: delegatedRunId,
          integration: integrated.newlyIntegrated || [],
          rework: integrated.rework || [],
          gated: integrated.gated || [],
          failed: integrated.failed || []
        });
      }
    }
    process.stdout.write(`${JSON.stringify({ ...output, ...(delegatedAuthorization ? { delegatedAuthorization, delegatedIntegration } : {}) }, null, 2)}\n`);
    process.stdout.write(await workflowFooter(config, repoPath, { concurrency }));
    if (automatic) setAutoReworkExitCode(automatic);
    else setResultExitCode(result);
    return;
  }

  if (command === "approve") {
    await approveLatest({
      config,
      repoPath,
      runId: option(args, "--run"),
      requestedIssues: issuePositionals(rest),
      override: args.includes("--override")
    });
    process.stdout.write(await workflowFooter(config, repoPath));
    return;
  }

  if (command === "validate") {
    const requestedIssues = issuePositionals(rest);
    if (requestedIssues.length !== 1) throw new Error("maestro validate --retry requires exactly one issue number.");
    const result = await executeValidatorRetry(config, { repoPath, issue: requestedIssues[0] });
    process.stdout.write(formatValidatorRetry(result));
    process.stdout.write(await workflowFooter(config, repoPath));
    if (result.validation.verdict === "failed") process.exitCode = 1;
    return;
  }

  if (command === "discard") {
    const result = await discardIssues({
      repoPath,
      runId: option(args, "--run"),
      requestedIssues: issuePositionals(rest)
    });
    process.stdout.write(formatDiscardSummary(result));
    process.stdout.write(await workflowFooter(config, repoPath));
    return;
  }

  if (command === "commit") {
    const committed = await commitLatest({
      config,
      repoPath,
      manifestPath,
      runId: option(args, "--run"),
      closeIssues: args.includes("--close-issues")
    });
    const advancedConfig = loadConfig(manifestPath, args);
    if (committed.manifestProgress.changed.length) {
      const sourceState = await loadRunState(repoPath, committed.runId);
      const backfill = await backfillAfterIntegration(advancedConfig, repoPath, sourceState);
      if (backfill.length) console.log(`Backfilled ${backfill.length} newly eligible worker run(s) after integration.`);
    }
    process.stdout.write(await workflowFooter(advancedConfig, repoPath));
    return;
  }

  if (command === "rework") {
    const sourceRunId = option(args, "--run");
    const requestedIssues = reworkArgs.issues;
    let sources;
    if (sourceRunId) {
      const sourceState = await loadRunState(repoPath, sourceRunId);
      let issueIds = requestedIssues.length ? requestedIssues : null;
      if (!issueIds) {
        issueIds = (sourceState.workers || [])
          .map((worker) => String(worker.issue))
          .filter((issue) => isRecoverableValidatorRework(evidenceForIssue(sourceState, issue)));
        if (!issueIds.length) throw new Error(`Run ${sourceRunId} has no eligible REWORK issues.`);
      } else {
        const ineligible = issueIds.filter((issue) => !isRecoverableValidatorRework(evidenceForIssue(sourceState, issue)));
        if (ineligible.length) {
          throw new Error(
            `Run ${sourceRunId} has no eligible REWORK evidence for ${ineligible.map((issue) => `issue #${issue}`).join(", ")}.`
          );
        }
      }
      const parentRunId = await resolveReworkParentRunId(repoPath, sourceRunId, issueIds);
      sources = [{ sourceRunId, parentRunId, issueIds }];
    } else {
      sources = await resolveIssueReworkSources(repoPath, requestedIssues);
    }
    const correctionTasks = [];
    const sourceStates = [];
    for (const source of sources) {
      const sourceState = await loadRunState(repoPath, source.sourceRunId);
      sourceStates.push(sourceState);
      let issueIds = source.issueIds;
      correctionTasks.push(...issueIds.map((issue) => ({ ...source, issueIds: [String(issue)], authorization: sourceState.authorization || null })));
    }
    const inheritedScope = sourceStates.flatMap((state) => state.scope?.authorizedIssueIds || []);
    const authorizedIssueIds = requestedIssues.length
      ? requestedIssues.map(String)
      : inheritedScope.length ? [...new Set(inheritedScope.map(String))] : Object.keys(config.work || {});
    const planOptions = { issueIds: authorizedIssueIds, concurrency };
    const outcomes = await runLifecycleBackfill(config, {
      repoPath,
      authorizedIssueIds,
      planOptions,
      initialTasks: correctionTasks,
      reserveInitial: async (source) => {
        const runId = source.resumeRunId || newRunId();
        return reserveManualRework(config, {
          repoPath,
          source,
          runId,
          planOptions
        });
      },
      executeInitial: (source, prepared) => executeReworkRun(config, {
        repoPath,
        ...source,
        runId: prepared.runId,
        reservedState: prepared.state,
        concurrency
      }),
      verifySelection: (issueIds) => verifyExecutionSelection(config, repoPath, issueIds),
      runIdFactory: newRunId,
      executeReserved: ({ runId, reservation }) => executeRun(config, {
        repoPath,
        runId,
        plan: reservation.plan,
        reservedState: reservation.state
      })
    });
    const results = outcomes.filter((entry) => entry?.mode === "rework");
    const backfill = outcomes.filter((entry) => entry?.mode !== "rework");
    if (backfill.length) {
      for (const result of results) result.backfillRunIds = backfill.filter((entry) => entry.runId).map((entry) => entry.runId);
    }
    process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
    process.stdout.write(await workflowFooter(config, repoPath, { concurrency }));
    for (const result of results) setResultExitCode(result);
    return;
  }

  if (command === "reconcile") {
    const positionalIssues = reconcileArgs.issues;
    const optionIssue = option(args, "--issue");
    if (positionalIssues.length > 1) throw new Error("maestro reconcile accepts one issue number.");
    if (optionIssue && positionalIssues.length && optionIssue !== positionalIssues[0]) {
      throw new Error("maestro reconcile received different positional and --issue values.");
    }
    const issue = positionalIssues[0] || optionIssue;
    const source = await resolveReconcileSource(repoPath, issue, option(args, "--run"));
    const result = await executeReconcileRun(config, {
      repoPath,
      ...source,
      ...(source.resumeRunId ? { runId: source.resumeRunId } : {}),
      reserveCapacity: true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    setResultExitCode(result);
    return;
  }

  if (command === "resolve") {
    if (resolutionArgs.issues.length > 1) throw new Error("maestro resolve accepts at most one issue number.");
    const issue = resolutionArgs.issues[0] || null;
    if (args.includes("--adopt") || args.includes("--continue")) {
      const result = await executeAdoptedResolution(config, {
        repoPath,
        worktreePath: repoPath,
        issue,
        continueExisting: args.includes("--continue")
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== "validated") process.exitCode = 1;
      return;
    }
    if (!issue) throw new Error("maestro resolve requires an issue number unless --adopt or --continue is used.");
    const [current] = await resolveCurrentIssueStates(repoPath, [issue]);
    if (current.evidence?.conflict?.interruptedStage === "rework-refresh") {
      const [source] = await resolveIssueReworkSources(repoPath, [issue]);
      const result = await executeReworkRun(config, {
        repoPath,
        ...source,
        runId: source.resumeRunId,
        reserveCapacity: true,
        concurrency
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      setResultExitCode(result);
      return;
    }
    const source = await resolveReconcileSource(repoPath, issue);
    const result = await executeReconcileRun(config, {
      repoPath,
      ...source,
      ...(source.resumeRunId ? { runId: source.resumeRunId } : {}),
      reserveCapacity: true
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    setResultExitCode(result);
    return;
  }

  if (command === "review") {
    const runId = option(args, "--run");
    const issue = option(args, "--issue");
    const disposition = option(args, "--disposition");
    const result = await recordReview({
      config,
      repoPath,
      runId,
      issue,
      disposition,
      title: option(args, "--title"),
      notes: option(args, "--notes")
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "integrate-run") {
    const runId = option(args, "--run");
    const result = await integrateExistingRun(config, { repoPath, manifestPath, runId, closeIssues: args.includes("--close-issues") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  let result;
  if (args.includes("--continuous")) {
    throw new Error("maestro run --continuous has migrated to the durable scoped lifecycle. Use `maestro start <issue...> --delegate --continuous` or `maestro start --workset <name> --delegate --continuous`.");
  }
  else if (args.includes("--integrate")) result = await executeAndIntegrate(config, { repoPath, manifestPath, concurrency, delegate: args.includes("--delegate") });
  else if (args.includes("--execute")) result = await executeRun(config, { repoPath, concurrency });
  else result = await dryRun(config, { repoPath, concurrency });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  setResultExitCode(result);
}

if (require.main === module) main().catch((error) => {
  console.error(error.code === "CLI_USAGE" ? error.message : error.stack || error.message);
  if (error.baselineComparison) console.error(`Baseline comparison:\n${JSON.stringify(error.baselineComparison, null, 2)}`);
  if (error.result) {
    const combined = `${error.result.stdout || ""}\n${error.result.stderr || ""}`.trim();
    if (combined) console.error(`Command output (tail):\n${combined.split("\n").slice(-80).join("\n")}`);
  }
  if (error.results) console.error(JSON.stringify(error.results, null, 2));
  process.exitCode = 1;
});

module.exports = { driveAutonomous, loadConfig, loadValidatedConfig };

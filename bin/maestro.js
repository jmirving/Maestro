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
  executeReworkRun,
  autoRework
} = require("../src/rework");
const { executeReconcileRun } = require("../src/reconcile");
const { latestRunId, loadRunState } = require("../src/run-store");
const { resolveCurrentIssueStates } = require("../src/run-resolver");
const { isRecoverableValidatorRework } = require("../src/run-lifecycle");
const { statusSnapshot, formatStatus, watchStatus } = require("../src/display");
const { formatRecommendationFooter, appendRecommendationFooter } = require("../src/recommendations");
const { loadIssueDetails, formatDetails } = require("../src/details");
const { discoverGitHubRepository, loadGitHubIssues } = require("../src/github");
const { proposeDraft, formatDraftSummary, formatDraftVerbose, formatDraftJson, readManifestSnapshot, writeManifest, detectExecutionDrift } = require("../src/draft");
const { createAgentPlanner } = require("../src/agent-planner");
const { runPlanningAnalyzer } = require("../src/planning-analysis");
const { stableWorksetName, epicWorkset, issueWorkset, resolveWorksetScope, assertExecutableScope, validateWorksetName } = require("../src/worksets");
const { loadScopeSnapshot, readScopeSnapshot } = require("../src/scope-store");
const { persistScopedDraft } = require("../src/scoped-persistence");
const { reserveReadyWork, reserveExplicitWork, runLifecycleBackfill } = require("../src/scheduler");
const { resolveConcurrency } = require("../src/concurrency");
const { runConfigCommand } = require("../src/config-command");
const {
  resolveRepoPath,
  resolveManifestPath,
  resolveDraftManifestPath,
  looksLikeManifest,
  persistManifestCompletion
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
    if (["--repo-path", "--run", "-j", "--concurrency"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (value === "--override") continue;
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
    if (value === "--watch") continue;
    if (value.startsWith("--")) throw new Error(`Unknown maestro status option: ${value}`);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  return [...new Set(issues)];
}

function reworkPositionals(rest) {
  const issues = [];
  const manifests = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--run", "-j", "--concurrency"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (value === "--allow-failing-baseline") continue;
    if (value.startsWith("--")) throw new Error(`Unknown maestro rework option: ${value}`);
    if (looksLikeManifest(value)) {
      manifests.push(value);
      continue;
    }
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  if (manifests.length > 1) {
    throw new Error(`maestro rework received multiple manifest paths: ${manifests.join(", ")}.`);
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

async function verifyExecutionSelection(config, repoPath, issueIds) {
  if (!issueIds.length) return;
  const repository = await discoverGitHubRepository(repoPath);
  if (repository !== config.repository) throw new Error(`The manifest targets ${config.repository}, but the current checkout is ${repository}.`);
  const issues = await loadGitHubIssues(repository, issueIds, { repoPath });
  const findings = detectExecutionDrift(config, issues, issueIds);
  if (findings.length) {
    throw new Error(`GitHub/manifest drift blocks execution: ${findings.map((item) => `#${item.issue} ${item.reason}`).join(" ")} Run \`maestro draft --write\` and review any conflicts before retrying.`);
  }
}

async function outputLatest(repoPath, { copy = true, print = true, config = null, recommendations = false } = {}) {
  const bundle = await latestRunBundle(repoPath);
  const text = recommendations
    ? appendRecommendationFooter(bundle.text, await workflowFooter(config, repoPath))
    : bundle.text;
  if (print) process.stdout.write(text);
  if (copy) {
    const clipboard = copyToClipboard(text);
    console.error(`Copied Maestro run ${bundle.runId} to clipboard using ${clipboard}.`);
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
  const progress = persistManifestCompletion({ repoPath, manifestPath, issueIds: integratedIssues });
  const outcome = result.nothingToDo
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
  const authorizedIssueIds = sourceState.scope?.authorizedIssueIds?.map(String) || Object.keys(config.work || {});
  const scope = sourceState.scope || null;
  return runLifecycleBackfill(config, {
    repoPath,
    authorizedIssueIds,
    planOptions: { issueIds: authorizedIssueIds },
    verifySelection: (issueIds) => verifyExecutionSelection(config, repoPath, issueIds),
    runIdFactory: newRunId,
    extraState: scope ? { scope } : {},
    executeReserved: ({ runId, reservation }) => executeRun(config, {
      repoPath,
      runId,
      plan: reservation.plan,
      scope,
      reservedState: reservation.state
    })
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
  let context;
  if (reworkArgs) {
    const repoPath = resolveRepoPath(option(args, "--repo-path"));
    context = { repoPath, manifestPath: resolveManifestPath(reworkArgs.manifest, repoPath) };
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
    if (args.includes("--watch")) await watchStatus(config, repoPath, requestedIssues, { concurrency });
    else process.stdout.write(formatStatus(await statusSnapshot(config, repoPath, requestedIssues, { concurrency })));
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

  if (command === "start" || command === "next") {
    const worksetName = option(args, "--workset");
    const scope = worksetName ? await resolveSavedWorkset(config, repoPath, worksetName, { refresh: true }) : null;
    const planOptions = { ...scopedPlanOptions(scope), concurrency };
    const candidatePlan = args.includes("--rerun") ? computePlan(config, planOptions) : await computeEffectivePlan(config, repoPath, planOptions);
    const selectedIssueIds = candidatePlan.selected.map((item) => item.id);
    await verifyExecutionSelection(config, repoPath, selectedIssueIds);
    const authorization = scope ? {
      workset: scope.name,
      revision: scope.revision,
      membership: scope.membership,
      authorizedIssueIds: scope.issueIds,
      authorizedAt: new Date().toISOString(),
      source: "explicit-workset-launch"
    } : null;
    const requestedRunId = newRunId();
    const reservation = args.includes("--rerun")
      ? await reserveExplicitWork(config, {
          repoPath,
          runId: requestedRunId,
          mode: "rerun",
          items: candidatePlan.selected,
          planOptions,
          extraState: authorization ? { scope: authorization } : {}
        })
      : await reserveReadyWork(config, {
          repoPath,
          runId: requestedRunId,
          mode: "execute",
          authorizedIssueIds: selectedIssueIds,
          planOptions,
          extraState: authorization ? { scope: authorization } : {}
        });
    if (args.includes("--rerun") && !reservation.reserved && selectedIssueIds.length) {
      throw new Error(`Cannot reserve worker capacity for rerun: ${reservation.reason}.`);
    }
    const plan = reservation.plan || { ...candidatePlan, selected: [] };
    const authorizedIssueIds = scope?.issueIds?.map(String) || Object.keys(config.work || {});
    const lifecycleOutcomes = [];
    const automaticRework = args.includes("--auto-rework");
    const automaticTimeoutMs = 30 * 60 * 1000;
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
              planOptions
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
            reworkOptions: { reserveCapacity: true }
          }),
          tasksAfterOutcome: (settledResult) => correctionTasksForResult(settledResult)
        } : {}),
        verifySelection: (issueIds) => verifyExecutionSelection(config, repoPath, issueIds),
        runIdFactory: newRunId,
        extraState: authorization ? { scope: authorization } : {},
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
        retryLimit: corrections[0]?.retryLimit || 3,
        capacity: reservation.capacity?.limit ?? candidatePlan.concurrency,
        timeoutMs: automaticTimeoutMs,
        issues: corrections.flatMap((entry) => entry.issues || [])
      };
    }
    const backfill = lifecycleOutcomes.filter((entry) => entry?.mode !== "auto-rework");
    const output = automatic
      ? { ...result, autoRework: automatic, backfill }
      : backfill.length ? { ...result, backfill } : result;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
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
      const issueIds = requestedIssues.length ? requestedIssues : null;
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
      if (!issueIds) {
        const validationByIssue = new Map((sourceState.validations || []).map((entry) => [String(entry.issue), entry]));
        issueIds = (sourceState.workers || [])
          .map((worker) => String(worker.issue))
          .filter((issue) => validationByIssue.get(issue)?.verdict === "rework" || sourceState.reviews?.[issue]?.disposition === "rework-original");
      }
      correctionTasks.push(...issueIds.map((issue) => ({ ...source, issueIds: [String(issue)] })));
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
        const runId = newRunId();
        const items = source.issueIds.map((id) => ({ id, ...(config.work?.[id] || {}), mode: "rework" }));
        const reservation = await reserveExplicitWork(config, {
          repoPath,
          runId,
          mode: "rework",
          items,
          planOptions,
          extraState: { parentRunId: source.parentRunId }
        });
        return { ...reservation, runId };
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
    const sourceRunId = option(args, "--run");
    const issue = option(args, "--issue");
    const result = await executeReconcileRun(config, { repoPath, sourceRunId, issueIds: issue ? [issue] : null, reserveCapacity: true });
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
  if (args.includes("--continuous")) result = await continuousRun(config, { repoPath, concurrency });
  else if (args.includes("--integrate")) result = await executeAndIntegrate(config, { repoPath, concurrency });
  else if (args.includes("--execute")) result = await executeRun(config, { repoPath, concurrency });
  else result = await dryRun(config, { repoPath, concurrency });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  setResultExitCode(result);
}

main().catch((error) => {
  console.error(error.code === "CLI_USAGE" ? error.message : error.stack || error.message);
  if (error.baselineComparison) console.error(`Baseline comparison:\n${JSON.stringify(error.baselineComparison, null, 2)}`);
  if (error.result) {
    const combined = `${error.result.stdout || ""}\n${error.result.stderr || ""}`.trim();
    if (combined) console.error(`Command output (tail):\n${combined.split("\n").slice(-80).join("\n")}`);
  }
  if (error.results) console.error(JSON.stringify(error.results, null, 2));
  process.exitCode = 1;
});

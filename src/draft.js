const fs = require("node:fs");
const crypto = require("node:crypto");
const { validateRepositoryConfig } = require("./config-validator");
const { unresolvedWork } = require("./work-state");
const { currentIssueEvidenceFromStates, effectiveIssueStates } = require("./run-resolver");
const { validateAgentOutput } = require("./agent-planner");
const {
  configuredAnalyzers,
  runAdvisoryAnalyzers,
  validateDependencyGraph,
  validateAdvisoryReferences,
  computeExpectedWaves,
  issueOrder
} = require("./planning-analysis");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function issueId(issue) {
  return Number.isSafeInteger(issue?.number) && issue.number > 0 ? String(issue.number) : null;
}

function explicitDependencies(issue, repository = null) {
  const dependencies = [];
  const body = typeof issue?.body === "string" ? issue.body : "";
  const pattern = /^\s*(blocked\s+by|depends\s+on)\s*:?\s*(.+)$/gim;
  for (const match of body.matchAll(pattern)) {
    for (const reference of match[2].matchAll(/(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g)) {
      const referencedRepository = reference[1] || repository;
      const id = String(Number(reference[2]));
      const unsupported = Boolean(repository && referencedRepository && referencedRepository.toLowerCase() !== repository.toLowerCase());
      const key = `${referencedRepository || ""}#${id}`.toLowerCase();
      if (!dependencies.some((entry) => entry.key === key)) {
        dependencies.push({ id, repository: referencedRepository, key, unsupported, source: `GitHub issue #${issue.number} body: ${match[1].toLowerCase()}` });
      }
    }
  }
  return dependencies;
}

function issueLabels(issue) {
  return [...new Set((issue?.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean))].sort();
}

function mappedMetadata(config, labels) {
  const mappings = config?.github?.labelMappings || {};
  const mapped = {};
  for (const label of labels) {
    if (mappings.priority?.[label] != null) mapped.priority = mappings.priority[label];
    if (mappings.mode?.[label] != null) mapped.mode = mappings.mode[label];
    if (mappings.humanGate?.[label] != null) mapped.humanGate = mappings.humanGate[label];
  }
  const requirements = labels.flatMap((label) => mappings.requires?.[label] || []);
  if (requirements.length) mapped.requires = [...new Set(requirements)].sort();
  return mapped;
}

function manualMetadata(item, mapped) {
  if (!item) return {};
  const priorMapped = item.github?.mapped || {};
  const manual = { ...(item.github?.manual || {}) };
  for (const field of ["priority", "mode", "humanGate"]) {
    if (mapped[field] == null) continue;
    if (priorMapped[field] == null && item[field] != null) manual[field] = item[field];
    else if (priorMapped[field] != null && item[field] !== priorMapped[field] && item[field] != null) manual[field] = item[field];
  }
  for (const [field, priorOwned] of [["blockedBy", item.github?.blockedBy || []], ["requires", priorMapped.requires || []]]) {
    const values = (item[field] || []).map(String);
    const recorded = (item.github?.manual?.[field] || []).map(String).filter((entry) => values.includes(entry));
    const inferred = values.filter((entry) => !priorOwned.map(String).includes(entry));
    const entries = [...new Set([...recorded, ...inferred])];
    if (entries.length) manual[field] = entries;
    else delete manual[field];
  }
  return manual;
}

function githubSnapshot(issue, dependencies, mapped, manual = {}) {
  return {
    state: String(issue.state).toUpperCase(),
    stateReason: issue.stateReason || null,
    closedAt: issue.closedAt || null,
    updatedAt: issue.updatedAt || null,
    title: typeof issue.title === "string" ? issue.title : "",
    labels: issueLabels(issue),
    blockedBy: dependencies.map((entry) => entry.id),
    ...(Object.keys(mapped).length ? { mapped } : {}),
    ...(Object.keys(manual).length ? { manual } : {})
  };
}

function same(value, other) {
  return JSON.stringify(value) === JSON.stringify(other);
}

function recordTransition(item, from, to, reason) {
  if (from === to) return;
  item.reconciliationHistory = [...(item.reconciliationHistory || []), { from, to, reason }];
}

function closureOutcome(stateReason) {
  const reason = String(stateReason || "").toUpperCase().replace(/[ -]+/g, "_");
  if (reason === "COMPLETED") return "completed";
  if (["NOT_PLANNED", "DUPLICATE", "CANCELLED", "CANCELED"].includes(reason)) return "inactive";
  return "unverified";
}

function hasCurrentLifecycle(entry) {
  if (!entry?.state?.status) return false;
  return new Set([
    "running",
    "rework-running",
    "awaiting-validation-or-review",
    "awaiting-review",
    "awaiting-human-review",
    "awaiting-human-decision",
    "awaiting-rework",
    "awaiting-integration",
    "integrating"
  ]).has(entry.evidence?.state || entry.state.status);
}

function externalCompletion(snapshot, executionStates, issue) {
  const hasHistory = executionStates.some((state) => (
    (state.plan?.selected || []).some((entry) => String(entry.id) === issue) ||
    (state.workers || []).some((entry) => String(entry.issue) === issue) ||
    (state.validations || []).some((entry) => String(entry.issue) === issue) ||
    Object.hasOwn(state.reviews || {}, issue) ||
    (state.integration || []).some((entry) => String(entry.issue) === issue)
  ));
  return {
    source: "external",
    ...(snapshot.closedAt || snapshot.updatedAt ? { reconciledAt: snapshot.closedAt || snapshot.updatedAt } : {}),
    githubState: "CLOSED",
    githubStateReason: String(snapshot.stateReason).toLowerCase(),
    evidence: {
      manifestStatus: "complete",
      maestroHistory: hasHistory
    }
  };
}

function applyMappedMetadata(item, priorGitHub = {}, mapped = {}, manual = {}) {
  const priorMapped = priorGitHub.mapped || {};
  for (const field of ["priority", "mode", "humanGate"]) {
    if (mapped[field] != null) item[field] = mapped[field];
    else if (priorMapped[field] != null && item[field] === priorMapped[field]) {
      if (priorGitHub.manual?.[field] != null) item[field] = priorGitHub.manual[field];
      else delete item[field];
    }
  }
  if (mapped.requires || priorMapped.requires) {
    item.requires = [...new Set([...(manual.requires || []), ...(mapped.requires || [])])];
    if (!item.requires.length) delete item.requires;
  }
  if (mapped.humanGate && item.status === "ready") item.status = "human_gate";
  if (!mapped.humanGate && priorMapped.humanGate && item.status === "human_gate" && item.humanGate == null) item.status = "ready";
}

function detectExecutionDrift(config, issues, issueIds) {
  const byId = new Map(issues.map((issue) => [issueId(issue), issue]));
  const findings = [];
  for (const id of issueIds.map(String)) {
    const item = config.work?.[id];
    const issue = byId.get(id);
    if (!issue) {
      findings.push({ issue: id, reason: "GitHub issue no longer resolves." });
      continue;
    }
    const references = explicitDependencies(issue, config.repository);
    const crossRepository = references.filter((entry) => entry.unsupported);
    const dependencies = references.filter((entry) => !entry.unsupported);
    const mapped = mappedMetadata(config, issueLabels(issue));
    const snapshot = githubSnapshot(issue, dependencies, mapped);
    if (snapshot.state !== "OPEN") findings.push({ issue: id, reason: `GitHub issue is ${snapshot.state.toLowerCase()}.` });
    if (crossRepository.length) findings.push({ issue: id, reason: `GitHub dependency metadata contains unsupported cross-repository references: ${crossRepository.map((entry) => `${entry.repository}#${entry.id}`).join(", ")}.` });
    if (!item?.github) {
      findings.push({ issue: id, reason: "Manifest entry has no GitHub reconciliation provenance." });
      continue;
    }
    if (snapshot.state !== item.github.state) findings.push({ issue: id, reason: `GitHub state changed from ${item.github.state.toLowerCase()} to ${snapshot.state.toLowerCase()}.` });
    if (!same(snapshot.blockedBy, item.github.blockedBy || [])) findings.push({ issue: id, reason: "GitHub dependency metadata changed." });
    if (!same(snapshot.mapped || {}, item.github.mapped || {})) findings.push({ issue: id, reason: "GitHub label mappings changed." });
  }
  return findings;
}

function conflictKey(conflict) {
  return [...conflict.issues].map(String).sort(issueOrder).join(":") + `:${conflict.analyzer}:${conflict.source}`;
}

function agentSource(agentAnalysis, recommendation) {
  return `agent:${agentAnalysis.metadata.provider} context:${agentAnalysis.metadata.contextDigest.slice(0, 12)}; evidence: ${recommendation.evidence.join(" | ")}`;
}

function proposeDraft({ repository, existingConfig = null, issues = [], selectedIssueIds = [], supportingIssueIds = [], analyzers = null, agentAnalysis = null, executionStates = [], worksetProposal = null, analysisScope = null, worksetMemberships = {}, concurrency = null }) {
  if (existingConfig?.repository && existingConfig.repository !== repository) {
    throw new Error(`The existing manifest targets ${existingConfig.repository}, but the current checkout is ${repository}.`);
  }

  if (existingConfig) validateRepositoryConfig(existingConfig);

  const manifest = existingConfig ? clone(existingConfig) : { repository, work: {} };
  if (worksetProposal) {
    manifest.worksets = { ...(manifest.worksets || {}), [worksetProposal.name]: clone(worksetProposal.definition) };
  }
  const existingWorkIds = new Set(Object.keys(existingConfig?.work || {}));
  const selected = new Set(selectedIssueIds.map(String));
  const supporting = new Set(supportingIssueIds.map(String));
  const seen = new Set();
  const ambiguous = new Set();
  const normalized = [];
  const unresolved = [];
  const referenceDiagnostics = [];
  const drift = [];
  const conflicts = [];
  const preserved = [];
  const lifecycle = unresolvedWork(executionStates, manifest);
  const currentLifecycle = new Map(currentIssueEvidenceFromStates(executionStates).map((entry) => [entry.issue, entry]));
  const effectiveBeforeDraft = effectiveIssueStates(manifest, executionStates);

  for (const issue of issues) {
    const id = issueId(issue);
    if (!id) {
      unresolved.push({ issue: null, reason: "GitHub issue record has no positive integer number." });
      continue;
    }
    if (selected.size && !selected.has(id) && !supporting.has(id)) continue;
    if (seen.has(id)) {
      ambiguous.add(id);
      unresolved.push({ issue: id, reason: "GitHub returned duplicate records for this issue." });
      continue;
    }
    seen.add(id);
    normalized.push({ id, issue });
  }

  const added = [];
  const changedIssues = new Set();
  const dependencySources = [];
  for (const { id, issue } of normalized) {
    if (ambiguous.has(id)) continue;
    const state = String(issue.state).toUpperCase();
    const references = explicitDependencies(issue, repository);
    const crossRepository = references.filter((entry) => entry.unsupported);
    const dependencies = references.filter((entry) => !entry.unsupported);
    for (const reference of crossRepository) {
      unresolved.push({ issue: id, reason: `Cross-repository dependency ${reference.repository}#${reference.id} is unsupported and was not mapped to local issue #${reference.id}.` });
      referenceDiagnostics.push({ issue: id, reason: `Cross-repository dependency ${reference.repository}#${reference.id} cannot be represented by this single-repository execution graph.` });
    }
    const mapped = mappedMetadata(manifest, issueLabels(issue));
    const original = manifest.work[id] ? clone(manifest.work[id]) : null;
    const manual = manualMetadata(original, mapped);
    const snapshot = githubSnapshot(issue, dependencies, mapped, manual);

    if (!original) {
      if (state !== "OPEN") {
        if (worksetProposal && (selected.has(id) || supporting.has(id)) && state === "CLOSED") {
          const item = { status: "inactive", github: snapshot };
          applyMappedMetadata(item, {}, mapped, manual);
          item.status = "inactive";
          manifest.work[id] = item;
          added.push(id);
          changedIssues.add(id);
          drift.push({ issue: id, type: "missing-closed-member", classification: "safe", before: null, after: clone(item), reason: "Closed workset member is retained as inactive history." });
        } else if (selected.has(id)) unresolved.push({ issue: id, reason: `Issue is ${state.toLowerCase()}, not open, and has no manifest history to reconcile.` });
        continue;
      }
      if (lifecycle.has(id)) {
        conflicts.push({ issue: id, type: "lifecycle", reason: `GitHub issue is open and absent from the manifest, but Maestro run ${lifecycle.get(id).runId} is ${lifecycle.get(id).state}.` });
        continue;
      }
      const item = {
        status: "ready",
        ...(dependencies.length ? { blockedBy: dependencies.map((entry) => entry.id) } : {}),
        github: snapshot
      };
      applyMappedMetadata(item, {}, mapped, manual);
      manifest.work[id] = item;
      added.push(id);
      changedIssues.add(id);
      drift.push({ issue: id, type: "missing-open", classification: "safe", before: null, after: clone(item), reason: "Open GitHub issue is missing from the manifest." });
      continue;
    }

    const proposed = clone(original);
    const manualDependencies = manual.blockedBy || [];
    const nextDependencies = [...new Set([...manualDependencies, ...dependencies.map((entry) => entry.id)])];
    if (nextDependencies.length) proposed.blockedBy = nextDependencies;
    else delete proposed.blockedBy;
    applyMappedMetadata(proposed, original.github || {}, mapped, manual);

    const outcome = state === "CLOSED" ? closureOutcome(snapshot.stateReason) : null;
    const hasMaestroIntegration = Boolean(effectiveBeforeDraft.get(id)?.integration);
    let adoptingExternalCompletion = false;

    if (state === "CLOSED" && outcome === "completed" && proposed.status === "complete" && !hasMaestroIntegration) {
      adoptingExternalCompletion = true;
      proposed.completion = externalCompletion(snapshot, executionStates, id);
    } else if (state === "CLOSED" && outcome !== "completed" && proposed.status === "complete" && !hasMaestroIntegration) {
      recordTransition(proposed, "complete", "inactive", `GitHub closure is no longer verified as completed${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}.`);
      proposed.status = "inactive";
      delete proposed.completion;
    } else if (state === "CLOSED" && ["ready", "blocked", "human_gate"].includes(proposed.status)) {
      recordTransition(proposed, proposed.status, "inactive", `GitHub issue closed${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}.`);
      proposed.status = "inactive";
    } else if (state === "OPEN" && proposed.status === "complete" && proposed.completion?.source === "external") {
      recordTransition(proposed, proposed.status, mapped.humanGate ? "human_gate" : "ready", "GitHub issue reopened after externally reconciled completion.");
      proposed.status = mapped.humanGate ? "human_gate" : "ready";
      delete proposed.completion;
    } else if (state === "OPEN" && proposed.status === "inactive" && original.github?.state === "CLOSED") {
      recordTransition(proposed, proposed.status, "ready", "GitHub issue reopened.");
      proposed.status = mapped.humanGate ? "human_gate" : "ready";
    } else if (state === "OPEN" && proposed.status === "complete") {
      preserved.push({ issue: id, reason: "Manifest completion is preserved; an open issue alone does not invalidate verified Maestro history." });
    }
    proposed.github = snapshot;

    if (!same(original, proposed)) {
      const unchangedCuratedFields = Object.keys(original).filter((field) => !["status", "github", "reconciliationHistory", "blockedBy"].includes(field) && same(original[field], proposed[field]));
      const preservedDetails = [
        ...(unchangedCuratedFields.length ? [`curated fields: ${unchangedCuratedFields.join(", ")}`] : []),
        ...(manualDependencies.length ? [`manual dependencies: ${manualDependencies.map((dependency) => `#${dependency}`).join(", ")}`] : []),
        ...(Object.keys(manual).length ? ["manual values retained beneath GitHub label mappings"] : [])
      ];
      if (preservedDetails.length) preserved.push({ issue: id, reason: `Preserved ${preservedDetails.join("; ")}.` });
      const material = original.status !== proposed.status
        || (original.github?.state != null && original.github.state !== proposed.github.state)
        || !same(original.blockedBy || [], proposed.blockedBy || [])
        || !same(original.github?.mapped || {}, proposed.github?.mapped || {})
        || !same(original.completion || null, proposed.completion || null);
      const activeExternalLifecycle = hasCurrentLifecycle(currentLifecycle.get(id));
      if (material && ((adoptingExternalCompletion && activeExternalLifecycle) || (!adoptingExternalCompletion && lifecycle.has(id)))) {
        const active = adoptingExternalCompletion ? currentLifecycle.get(id) : lifecycle.get(id);
        const options = adoptingExternalCompletion
          ? "Choose whether to adopt external completion and supersede the Maestro implementation, or preserve Maestro ownership and investigate/reopen the issue."
          : "The manifest entry was preserved.";
        conflicts.push({ issue: id, type: "lifecycle", before: original, proposed, reason: `GitHub changed while Maestro run ${active.runId} is ${active.evidence?.state || active.state}; ${options}` });
      } else {
        manifest.work[id] = proposed;
        changedIssues.add(id);
        drift.push({ issue: id, type: original.status !== proposed.status ? `${String(original.github?.state || "unknown").toLowerCase()}-to-${state.toLowerCase()}` : "metadata", classification: "safe", before: original, after: clone(proposed), reason: original.status !== proposed.status ? `GitHub state requires ${proposed.status} manifest work.` : "GitHub-owned metadata changed." });
      }
    }
  }

  for (const [id, item] of Object.entries(manifest.work)) {
    for (const dependency of item.blockedBy || []) {
      const githubOwned = (item.github?.blockedBy || []).includes(String(dependency));
      const manualOwned = (item.github?.manual?.blockedBy || []).includes(String(dependency));
      const source = [manualOwned ? "existing manifest blockedBy" : null, githubOwned ? `GitHub issue #${id} body` : null].filter(Boolean).join("; ");
      dependencySources.push({ issue: id, dependency: String(dependency), source: source || "existing manifest blockedBy", added: changedIssues.has(id) && githubOwned });
    }
  }

  if (!selected.size && existingConfig) {
    for (const id of Object.keys(existingConfig.work || {})) {
      if (!seen.has(id)) {
        conflicts.push({ issue: id, type: "missing-github", reason: "Manifest entry references an issue that no longer resolves in the full GitHub issue set." });
      }
    }
  }

  const agentUnresolved = [];
  const agentDiagnostics = [];
  const acceptedAgentDependencies = [];
  const acceptedAgentWork = [];
  const agentChangedIssues = new Set();
  const acceptedAgentConflicts = [];
  if (agentAnalysis) {
    validateAgentOutput(agentAnalysis.output);
    const known = new Set(Object.keys(manifest.work));
    const analyzed = new Set(normalized.filter(({ id, issue }) => !ambiguous.has(id) && String(issue.state).toUpperCase() === "OPEN" && (!analysisScope || selected.has(id))).map(({ id }) => id));
    const checkKnown = (id, description) => {
      if (known.has(String(id))) return true;
      agentDiagnostics.push({ issue: String(id), reason: `Agent ${description} references work not present in the manifest.` });
      return false;
    };
    const checkTarget = (id, description) => {
      if (analyzed.has(String(id))) return true;
      agentDiagnostics.push({ issue: String(id), reason: `Agent ${description} targets an issue outside the bounded candidate set.` });
      return false;
    };

    for (const recommendation of agentAnalysis.output.dependencies) {
      const validTarget = checkTarget(recommendation.issue, "dependency");
      const validDependency = checkKnown(recommendation.blockedBy, "dependency");
      const valid = validTarget && validDependency;
      if (recommendation.issue === recommendation.blockedBy) {
        agentDiagnostics.push({ issue: recommendation.issue, reason: "Agent dependency cannot make an issue depend on itself." });
        continue;
      }
      if (!valid) continue;
      if (recommendation.confidence !== "high") {
        agentUnresolved.push({ issue: recommendation.issue, reason: `Agent suggested #${recommendation.issue} depend on #${recommendation.blockedBy} at ${recommendation.confidence} confidence: ${recommendation.reason}` });
        continue;
      }
      const blockedBy = (manifest.work[recommendation.issue].blockedBy || []).map(String);
      const addedDependency = !blockedBy.includes(recommendation.blockedBy);
      if (addedDependency) {
        blockedBy.push(recommendation.blockedBy);
        manifest.work[recommendation.issue].blockedBy = blockedBy;
        agentChangedIssues.add(recommendation.issue);
      }
      const source = agentSource(agentAnalysis, recommendation);
      const existingSource = dependencySources.find((entry) => entry.issue === recommendation.issue && entry.dependency === recommendation.blockedBy);
      if (existingSource) existingSource.source = `${existingSource.source}; ${source}`;
      else dependencySources.push({ issue: recommendation.issue, dependency: recommendation.blockedBy, source, added: addedDependency });
      acceptedAgentDependencies.push(recommendation);
    }

    for (const recommendation of agentAnalysis.output.work) {
      if (!checkTarget(recommendation.issue, "work recommendation")) continue;
      if (recommendation.confidence === "low") {
        agentUnresolved.push({ issue: recommendation.issue, reason: `Low-confidence agent work recommendation: ${recommendation.reason}` });
        continue;
      }
      const item = manifest.work[recommendation.issue];
      const before = clone(item);
      if (recommendation.mode && item.mode == null) item.mode = recommendation.mode;
      if (recommendation.priority != null && item.priority == null) item.priority = recommendation.priority;
      if (recommendation.requires?.length) item.requires = [...new Set([...(item.requires || []), ...recommendation.requires])];
      if (recommendation.humanGate && !existingWorkIds.has(recommendation.issue) && item.humanGate == null) {
        item.status = "human_gate";
        item.humanGate = recommendation.humanGate;
      } else if (recommendation.humanGate && item.humanGate !== recommendation.humanGate) {
        agentUnresolved.push({ issue: recommendation.issue, reason: `Agent recommends human gate "${recommendation.humanGate}", but existing manifest state takes precedence.` });
      }
      if (!same(before, item)) {
        agentChangedIssues.add(recommendation.issue);
        acceptedAgentWork.push(recommendation);
      }
    }

    for (const recommendation of agentAnalysis.output.conflicts) {
      const valid = recommendation.issues.map((id) => checkKnown(id, "conflict")).every(Boolean);
      if (recommendation.issues[0] === recommendation.issues[1]) {
        agentDiagnostics.push({ issue: recommendation.issues[0], reason: "Agent conflict must reference two different issues." });
        continue;
      }
      if (!valid) continue;
      if (analysisScope && !recommendation.issues.some((id) => analyzed.has(String(id)))) {
        agentDiagnostics.push({ issue: recommendation.issues[0], reason: "Agent conflict does not involve a selected workset member." });
        continue;
      }
      if (recommendation.confidence === "low") {
        agentUnresolved.push({ issue: recommendation.issues[0], reason: `Low-confidence conflict with #${recommendation.issues[1]}: ${recommendation.reason}` });
        continue;
      }
      acceptedAgentConflicts.push({
        issues: [...recommendation.issues].map(String).sort(issueOrder),
        confidence: recommendation.confidence,
        source: agentSource(agentAnalysis, recommendation),
        reason: recommendation.reason,
        analyzer: analysisScope ? `agent:${analysisScope}` : "agent"
      });
    }
    for (const recommendation of agentAnalysis.output.waves) {
      recommendation.issues.forEach((id) => checkKnown(id, "wave recommendation"));
      if (recommendation.confidence === "low") agentUnresolved.push({ issue: recommendation.issues[0], reason: `Low-confidence execution-wave recommendation: ${recommendation.reason}` });
    }
    for (const item of agentAnalysis.output.unresolved) {
      if (item.issue != null) checkKnown(item.issue, "unresolved question");
      agentUnresolved.push({ issue: item.issue, reason: `${item.question} ${item.reason}` });
    }
    manifest.planning = { ...(manifest.planning || {}) };
    const evidence = { ...agentAnalysis.metadata, recommendations: agentAnalysis.output };
    if (analysisScope) {
      manifest.planning.agentAnalyses = { ...(manifest.planning.agentAnalyses || {}), [analysisScope]: evidence };
    } else {
      manifest.planning.agentAnalysis = evidence;
    }
  }

  const activeAnalyzers = analyzers == null ? configuredAnalyzers(manifest) : analyzers;
  const analyzerContext = new Map();
  if (worksetProposal) {
    for (const issue of issues) {
      const id = issueId(issue);
      if (id && manifest.work[id] && !analyzerContext.has(id)) analyzerContext.set(id, { id, issue });
    }
    for (const [id, item] of Object.entries(manifest.work)) {
      if (analyzerContext.has(id) || !item.github) continue;
      analyzerContext.set(id, {
        id,
        issue: {
          number: Number(id),
          state: item.github.state,
          title: item.github.title,
          body: "",
          labels: item.github.labels || [],
          updatedAt: item.github.updatedAt,
          closedAt: item.github.closedAt
        }
      });
    }
  }
  const analyzerIssues = worksetProposal
    ? [...analyzerContext.values()].sort((a, b) => issueOrder(a.id, b.id))
    : normalized;
  const inferredConflicts = [...runAdvisoryAnalyzers({ analyzers: activeAnalyzers, issues: analyzerIssues, manifest }), ...acceptedAgentConflicts];
  const existingConflicts = manifest.planning?.advisoryConflicts || [];
  const activeAnalyzerNames = new Set(activeAnalyzers.map((analyzer) => analyzer.name || "custom"));
  if (agentAnalysis) activeAnalyzerNames.add(analysisScope ? `agent:${analysisScope}` : "agent");
  const analyzedIssueIds = new Set(analyzerIssues.map(({ id }) => id));
  const retainedConflicts = existingConflicts.filter((conflict) => {
    if (analysisScope && conflict.analyzer === `agent:${analysisScope}`) return false;
    if (!activeAnalyzerNames.has(conflict.analyzer)) return true;
    if (worksetProposal) return false;
    if (!selected.size) return false;
    return !conflict.issues.every((id) => analyzedIssueIds.has(String(id)));
  });
  const conflictsByKey = new Map(retainedConflicts.map((conflict) => [conflictKey(conflict), conflict]));
  for (const conflict of inferredConflicts) conflictsByKey.set(conflictKey(conflict), conflict);
  const advisoryConflicts = activeAnalyzers.length || agentAnalysis
    ? [...conflictsByKey.values()].sort((a, b) => conflictKey(a).localeCompare(conflictKey(b)))
    : existingConflicts;
  if (advisoryConflicts.length) {
    manifest.planning = { ...(manifest.planning || {}), advisoryConflicts };
  } else if (manifest.planning?.advisoryConflicts) {
    delete manifest.planning.advisoryConflicts;
    if (!Object.keys(manifest.planning).length) delete manifest.planning;
  }

  for (const id of selected) {
    if (!seen.has(id)) unresolved.push({ issue: id, reason: "GitHub did not return the selected issue." });
  }

  unresolved.push(...agentUnresolved);

  validateRepositoryConfig(manifest);
  const diagnostics = [
    ...validateDependencyGraph(manifest.work),
    ...validateAdvisoryReferences(manifest.work, advisoryConflicts),
    ...referenceDiagnostics,
    ...agentDiagnostics
  ];
  const planning = computeExpectedWaves(manifest, {
    ...(worksetProposal ? { issueIds: selectedIssueIds } : {}),
    concurrency
  });
  added.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  unresolved.sort((a, b) => String(a.issue || "").localeCompare(String(b.issue || "")) || a.reason.localeCompare(b.reason));
  drift.sort((a, b) => issueOrder(a.issue, b.issue) || a.type.localeCompare(b.type));
  conflicts.sort((a, b) => issueOrder(a.issue, b.issue) || a.type.localeCompare(b.type));
  preserved.sort((a, b) => issueOrder(a.issue, b.issue) || a.reason.localeCompare(b.reason));
  dependencySources.sort((a, b) => issueOrder(a.issue, b.issue) || issueOrder(a.dependency, b.dependency) || a.source.localeCompare(b.source));
  const addedSet = new Set(added);
  const examined = [...new Set(normalized.filter(({ id }) => !ambiguous.has(id)).map(({ id }) => id))].sort(issueOrder);
  const updated = [...new Set([...changedIssues, ...agentChangedIssues])]
    .filter((id) => !addedSet.has(id))
    .sort(issueOrder);
  const updatedSet = new Set(updated);
  const unchanged = examined.filter((id) => !addedSet.has(id) && !updatedSet.has(id));
  const otherWorksets = worksetProposal
    ? Object.entries(manifest.worksets || {}).filter(([name]) => name !== worksetProposal.name)
    : [];
  const sharedIssueEffects = worksetProposal
    ? [...new Set([...changedIssues, ...agentChangedIssues])].filter((id) => otherWorksets.some(([name, definition]) => {
      if ((worksetMemberships[name] || []).map(String).includes(id)) return true;
      if (definition.source?.type !== "issues") return false;
      return definition.source.issues.some((ref) => ref.repository === repository && String(ref.number) === id);
    })).sort(issueOrder)
    : [];
  return {
    manifest,
    added,
    drift,
    conflicts,
    preserved,
    unresolved,
    diagnostics,
    dependencySources,
    activeWork: [...lifecycle.values()].sort((a, b) => issueOrder(a.issue, b.issue)),
    inferredConflicts,
    agentRecommendations: agentAnalysis?.output || null,
    acceptedAgentDependencies,
    acceptedAgentWork,
    agentChangedIssues: [...agentChangedIssues].sort(issueOrder),
    changes: { added: [...added], updated, unchanged },
    ...(worksetProposal ? { workset: { name: worksetProposal.name, definition: clone(worksetProposal.definition), issueIds: [...selectedIssueIds].map(String).sort(issueOrder), sharedIssueEffects } } : {}),
    planning,
    created: !existingConfig,
    changed: !existingConfig || JSON.stringify(existingConfig) !== JSON.stringify(manifest),
    writable: diagnostics.length === 0
  };
}

function normalizedOutcome({ result, write = false, outcome = null }) {
  if (outcome) return outcome;
  if (!write) return { requested: false, status: "preview" };
  if (!result.writable) return { requested: true, status: "blocked" };
  return { requested: true, status: result.changed ? "pending" : "no-op" };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shorten(value, length) {
  const text = cleanText(value);
  if (text.length <= length) return text;
  if (length <= 3) return text.slice(0, Math.max(0, length));
  return `${text.slice(0, length - 3).trimEnd()}...`;
}

function terminalWidth(width) {
  const parsed = Number(width);
  return Number.isFinite(parsed) ? Math.max(40, Math.floor(parsed)) : 80;
}

function fitLine(prefix, value, width) {
  return `${prefix}${shorten(value, Math.max(8, width - prefix.length))}`;
}

function issueTitle(result, id) {
  const title = cleanText(result.manifest.work?.[String(id)]?.github?.title);
  return title || null;
}

function issueLabel(result, id, maxLength = 50) {
  const number = `#${id}`;
  const title = issueTitle(result, id);
  return title ? `${number} ${shorten(title, Math.max(8, maxLength - number.length - 1))}` : number;
}

function joinedIssueLabels(result, ids, maxLength) {
  const labels = ids.map((id) => issueLabel(result, id, Math.max(12, Math.floor(maxLength / Math.max(1, ids.length)))));
  if (labels.length < 2) return labels[0] || "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function appendBounded(lines, entries, { limit = 5, command = "maestro draft --verbose" } = {}) {
  lines.push(...entries.slice(0, limit));
  if (entries.length > limit) lines.push(`  ... ${entries.length - limit} more; inspect with ${command}.`);
}

function currentPrerequisites(result, width) {
  const work = result.manifest.work || {};
  const worksetIssues = result.workset ? new Set(result.workset.issueIds || []) : null;
  const activeStatuses = new Set(["ready", "blocked", "human_gate"]);
  return Object.entries(work)
    .filter(([, item]) => activeStatuses.has(item.status))
    .map(([id, item]) => ({
      id,
      dependencies: (item.blockedBy || []).map(String).filter((dependency) => work[dependency]?.status !== "complete")
    }))
    .filter((entry) => entry.dependencies.length)
    .sort((left, right) => issueOrder(left.id, right.id))
    .map(({ id, dependencies }) => {
      const visible = dependencies.slice(0, 2);
      const omitted = dependencies.length - visible.length;
      const suffix = omitted ? `, plus ${omitted} more` : "";
      const outside = worksetIssues && visible.some((dependency) => !worksetIssues.has(dependency)) ? " [outside workset]" : "";
      let description = `${issueLabel(result, id, 32)} - waits for ${joinedIssueLabels(result, visible, 60)}${suffix}${outside}.`;
      if (description.length + 4 > width) {
        description = `${issueLabel(result, id, 20)} - waits for ${visible.map((dependency) => `#${dependency}`).join(" and ")}${suffix}${outside}.`;
      }
      if (description.length + 4 > width) description = `#${id} - waits for ${visible.map((dependency) => `#${dependency}`).join(" and ")}${suffix}${outside}.`;
      return fitLine("  - ", description, width);
    });
}

function formatDraftSummary({
  repository,
  manifestPath,
  result,
  write = false,
  outcome = null,
  width = 80,
  writeCommand = "maestro draft --write",
  verboseCommand = "maestro draft --verbose",
  jsonCommand = "maestro draft --json"
}) {
  const columns = terminalWidth(width);
  const finalOutcome = normalizedOutcome({ result, write, outcome });
  const changeCounts = result.changes || {
    added: result.added || [],
    updated: [...new Set((result.drift || []).filter((entry) => entry.type !== "missing-open").map((entry) => entry.issue))],
    unchanged: []
  };
  const lines = [
    `Maestro draft for ${repository}`,
    ...(result.workset ? [`Workset: ${result.workset.name} (saved configuration only; execution authorization is separate)`] : []),
    "",
    "What changed?",
    `  Added ${changeCounts.added.length}, updated ${changeCounts.updated.length}, unchanged ${changeCounts.unchanged.length}.`
  ];
  if (result.workset?.scopeChanges) {
    const scope = result.workset.scopeChanges;
    lines.push(`  Scope: ${scope.added.length} added, ${scope.removed.length} removed${scope.factsChanged ? ", member facts changed" : ""}.`);
  }

  const changeLines = [];
  for (const id of changeCounts.added) {
    changeLines.push(fitLine("  + ", `${issueLabel(result, id, 44)} - added as ${result.manifest.work[id].status}.`, columns));
  }
  for (const change of result.drift.filter((entry) => entry.type !== "missing-open")) {
    changeLines.push(fitLine("  ~ ", `${issueLabel(result, change.issue, 34)} - ${change.reason}`, columns));
  }
  for (const id of result.agentChangedIssues || []) {
    if (!changeCounts.added.includes(id) && !result.drift.some((entry) => entry.issue === id && entry.type !== "missing-open")) {
      changeLines.push(fitLine("  ~ ", `${issueLabel(result, id, 42)} - agent-proposed planning metadata.`, columns));
    }
  }
  appendBounded(lines, changeLines, { limit: 6, command: verboseCommand });
  if (!changeLines.length && !result.changed) lines.push("  (no changes)");
  else if (!changeLines.length && result.changed) lines.push("  ~ Planning metadata updated.");
  if (result.agentRecommendations) {
    const addedAgentDependencies = (result.dependencySources || []).filter((entry) => entry.added && cleanText(entry.source).includes("agent:")).length;
    const agentWork = (result.acceptedAgentWork || []).length;
    const advisory = (result.inferredConflicts || []).filter((entry) => entry.analyzer === "agent" || entry.analyzer?.startsWith("agent:")).length;
    lines.push(`  Agent proposal: ${addedAgentDependencies} dependencies, ${agentWork} work items, ${advisory} advisory overlaps changed.`);
  }

  lines.push("", "What would run next?", "  Draft projection (manifest only; execution reconciles live lifecycle state).");
  const nextWave = result.planning.waves[0] || [];
  if (nextWave.length) {
    const visible = nextWave.slice(0, 6);
    const omitted = nextWave.length - visible.length;
    const suffix = omitted ? `, plus ${omitted} more` : "";
    let description = `${visible.map((id) => issueLabel(result, id, 24)).join(", ")}${suffix}.`;
    if (description.length + 13 > columns) description = `${visible.map((id) => `#${id}`).join(", ")}${suffix}.`;
    lines.push(fitLine("  Next wave: ", description, columns));
  } else {
    lines.push("  Next wave: none schedulable.");
  }
  lines.push(`  Effective concurrency limit: ${result.planning.concurrency}.`);

  lines.push("", "What needs attention?");
  const attention = [];
  attention.push(...currentPrerequisites(result, columns));
  const active = new Set(Object.entries(result.manifest.work || {})
    .filter(([, item]) => ["ready", "blocked", "human_gate"].includes(item.status))
    .map(([id]) => id));
  const advisoryLines = (result.manifest.planning?.advisoryConflicts || [])
    .filter((conflict) => conflict.issues.every((id) => active.has(String(id))))
    .map((conflict) => fitLine("  - ", `${conflict.issues.map((id) => issueLabel(result, id, 24)).join(" / ")} - scheduled separately: ${conflict.reason}`, columns));
  attention.push(...advisoryLines);
  for (const item of result.unresolved) {
    attention.push(fitLine("  ! ", `${item.issue ? `${issueLabel(result, item.issue, 30)} - ` : ""}${item.reason}`, columns));
  }
  for (const item of result.conflicts) {
    attention.push(fitLine("  ! ", `${issueLabel(result, item.issue, 30)} - ${item.reason}`, columns));
  }
  for (const [id, item] of Object.entries(result.manifest.work || {}).sort(([left], [right]) => issueOrder(left, right))) {
    if (item.status === "human_gate") attention.push(fitLine("  ! ", `${issueLabel(result, id, 30)} - human gate: ${item.humanGate || "approval required"}.`, columns));
    else if (item.status === "blocked" && !(item.blockedBy || []).length) attention.push(fitLine("  ! ", `${issueLabel(result, id, 30)} - blocked in the manifest.`, columns));
  }
  appendBounded(lines, attention, { limit: 8, command: verboseCommand });
  if (!attention.length && !result.diagnostics.length) lines.push("  (none)");
  if (result.diagnostics.length) {
    lines.push("  Write-blocking errors:");
    for (const diagnostic of result.diagnostics) {
      lines.push(fitLine("  ! ", `${diagnostic.issue ? `${issueLabel(result, diagnostic.issue, 28)} - ` : ""}${diagnostic.reason}`, columns));
    }
  }

  lines.push("", "What happens next?");
  if (finalOutcome.status === "preview") {
    if (result.changed) lines.push(`  Preview only; no files written. Next: ${writeCommand}`);
    else lines.push("  Preview only; manifest is already current. Next: maestro plan");
  } else if (finalOutcome.status === "written") {
    lines.push(`  Manifest written successfully: ${manifestPath}`);
    lines.push("  Next: maestro plan");
  } else if (finalOutcome.status === "no-op") {
    lines.push("  No-op; manifest is already current and nothing was written.", "  Next: maestro plan");
  } else if (finalOutcome.status === "scope-refreshed") {
    lines.push("  Manifest already current; workset scope snapshot refreshed.", `  Next: maestro plan --workset ${result.workset.name}`);
  } else if (finalOutcome.status === "blocked") {
    lines.push(`  Write blocked; no files written. Resolve the errors above, then run: ${writeCommand}`);
  } else if (finalOutcome.status === "failed") {
    lines.push(fitLine("  Write failed; no update was reported: ", finalOutcome.error || "unknown persistence error", columns));
    lines.push(`  Next: resolve the persistence error, then run: ${writeCommand}`);
  } else {
    lines.push("  Write requested; persistence has not been confirmed.");
  }
  lines.push(`  Full evidence: ${verboseCommand}; structured result: ${jsonCommand}`);
  return `${lines.join("\n")}\n`;
}

function formatDraftVerbose({ repository, manifestPath, result, write = false, outcome = null }) {
  const finalOutcome = normalizedOutcome({ result, write, outcome });
  const lines = [
    `Maestro draft for ${repository}`,
    ...(result.workset ? [`Workset: ${result.workset.name}`, `Shared-issue effects: ${result.workset.sharedIssueEffects.length ? result.workset.sharedIssueEffects.map((id) => `#${id}`).join(", ") : "none"}`] : []),
    `Manifest: ${manifestPath}`,
    "Changes:"
  ];
  if (result.created) lines.push("  + create manifest");
  if (result.workset?.scopeChanges) {
    const scope = result.workset.scopeChanges;
    lines.push(`  scope +${scope.added.length} -${scope.removed.length}${scope.factsChanged ? "; member facts changed" : ""}`);
  }
  if (result.added.length) {
    for (const id of result.added) lines.push(`  + #${id} ${result.manifest.work[id].status}`);
  }
  for (const change of result.drift.filter((entry) => entry.type !== "missing-open")) lines.push(`  ~ #${change.issue} ${change.reason}`);
  if (!result.drift.length && !result.created) lines.push("  (no changes)");
  if (result.preserved.length) {
    lines.push("Preserved Maestro-owned state:");
    for (const item of result.preserved) lines.push(`  = #${item.issue}: ${item.reason}`);
  }
  if (result.conflicts.length) {
    lines.push("Reconciliation conflicts (human action required):");
    for (const item of result.conflicts) lines.push(`  ! #${item.issue}: ${item.reason}`);
  }
  if (result.unresolved.length) {
    lines.push("Unresolved:");
    for (const item of result.unresolved) lines.push(`  ! ${item.issue ? `#${item.issue}: ` : ""}${item.reason}`);
  }
  if (result.dependencySources.length) {
    lines.push("Hard dependencies:");
    for (const dependency of result.dependencySources) lines.push(`  ${dependency.added ? "+ " : "  "}#${dependency.issue} blocked by #${dependency.dependency} (${dependency.source})`);
  }
  if (result.inferredConflicts.length) {
    lines.push("Advisory conflict risk:");
    for (const conflict of result.inferredConflicts) lines.push(`  ~ #${conflict.issues[0]} / #${conflict.issues[1]}: ${conflict.reason} (${conflict.confidence}; ${conflict.source})`);
  }
  if (result.agentRecommendations) {
    lines.push("Agent-assisted recommendations:");
    lines.push(`  ${result.acceptedAgentDependencies.length} high-confidence hard dependencies accepted into the proposal.`);
    for (const recommendation of result.agentRecommendations.work) lines.push(`  ~ #${recommendation.issue}: ${recommendation.reason} (${recommendation.confidence}; ${recommendation.evidence.join(" | ")})`);
    for (const recommendation of result.agentRecommendations.waves) lines.push(`  ~ suggested wave ${recommendation.issues.map((id) => `#${id}`).join(", ")}: ${recommendation.reason} (${recommendation.confidence})`);
  }
  lines.push("Expected execution waves:");
  if (result.planning.waves.length) {
    result.planning.waves.forEach((wave, index) => lines.push(`  Wave ${index + 1}: ${wave.map((id) => `#${id}`).join(", ")}`));
  } else {
    lines.push("  (no schedulable work)");
  }
  const saved = result.planning.savedDefaultConcurrency == null ? "built-in fallback: 2" : `saved default: ${result.planning.savedDefaultConcurrency}`;
  if (result.planning.concurrencySource === "this invocation") {
    lines.push(`  ${result.planning.available}-way dependency independence available; projected concurrency is ${result.planning.concurrency} (this invocation; ${saved}).`);
  } else {
    lines.push(`  ${result.planning.available}-way dependency independence available; repository limit is ${result.planning.concurrency} (${result.planning.concurrencySource}).`);
  }
  for (const decision of result.planning.decisions.filter((entry) => entry.state === "serialized")) {
    lines.push(`  #${decision.issue} serialized conservatively: ${decision.reason} (${decision.confidence}; ${decision.source})`);
  }
  for (const decision of result.planning.unresolved) lines.push(`  #${decision.issue} unresolved: ${decision.reason}`);
  if (result.diagnostics.length) {
    lines.push("Blocking diagnostics:");
    for (const diagnostic of result.diagnostics) lines.push(`  ! ${diagnostic.issue ? `#${diagnostic.issue}: ` : ""}${diagnostic.reason}`);
  }
  lines.push("Proposed manifest:", JSON.stringify(result.manifest, null, 2));
  if (finalOutcome.status === "preview") lines.push("Dry run; use --write to persist this manifest.");
  else if (finalOutcome.status === "blocked") lines.push("Write blocked; resolve dependency diagnostics and draft again.");
  else if (finalOutcome.status === "written") lines.push("Schema-valid manifest written successfully.");
  else if (finalOutcome.status === "no-op") lines.push("Schema-valid manifest is already current; nothing written.");
  else if (finalOutcome.status === "scope-refreshed") lines.push("Schema-valid manifest is current; workset scope snapshot refreshed.");
  else if (finalOutcome.status === "failed") lines.push(`Write failed: ${finalOutcome.error}`);
  else lines.push("Write requested; persistence has not been confirmed.");
  return `${lines.join("\n")}\n`;
}

function formatDraftJson({ repository, manifestPath, result, write = false, outcome = null }) {
  return `${JSON.stringify({
    version: 1,
    command: "draft",
    repository,
    manifestPath,
    outcome: normalizedOutcome({ result, write, outcome }),
    result
  }, null, 2)}\n`;
}

function readExistingManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function readManifestSnapshot(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { config: null, contents: null };
  const contents = fs.readFileSync(manifestPath, "utf8");
  return { config: JSON.parse(contents), contents };
}

function manifestContents(manifest) {
  validateRepositoryConfig(manifest);
  const diagnostics = [
    ...validateDependencyGraph(manifest.work),
    ...validateAdvisoryReferences(manifest.work, manifest.planning?.advisoryConflicts || [])
  ];
  if (diagnostics.length) throw new Error(`Cannot write unsafe Maestro manifest: ${diagnostics.map((entry) => entry.reason).join(" ")}`);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function writeManifest(manifestPath, manifest, { expectedContents } = {}) {
  const contents = manifestContents(manifest);
  const lockPath = `${manifestPath}.lock`;
  const temporaryPath = `${manifestPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let lock;
  try {
    lock = fs.openSync(lockPath, "wx");
    const currentContents = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : null;
    if (expectedContents !== undefined && currentContents !== expectedContents) {
      throw new Error("The manifest changed after reconciliation was proposed; no changes were written. Draft again against the current file.");
    }
    if (currentContents === contents) return false;
    fs.writeFileSync(temporaryPath, contents, "utf8");
    fs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  } finally {
    if (lock != null) {
      fs.closeSync(lock);
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  return true;
}

module.exports = { proposeDraft, formatDraftSummary, formatDraftVerbose, formatDraftJson, readExistingManifest, readManifestSnapshot, manifestContents, writeManifest, explicitDependencies, detectExecutionDrift };

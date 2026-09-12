const fs = require("node:fs");
const crypto = require("node:crypto");
const { validateRepositoryConfig } = require("./config-validator");
const { unresolvedWork } = require("./work-state");
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

function explicitDependencies(issue) {
  const dependencies = [];
  const body = typeof issue?.body === "string" ? issue.body : "";
  const pattern = /^\s*(blocked\s+by|depends\s+on)\s*:?\s*(.+)$/gim;
  for (const match of body.matchAll(pattern)) {
    for (const reference of match[2].matchAll(/#(\d+)/g)) {
      const id = String(Number(reference[1]));
      if (!dependencies.some((entry) => entry.id === id)) {
        dependencies.push({ id, source: `GitHub issue #${issue.number} body: ${match[1].toLowerCase()}` });
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

function applyMappedMetadata(item, priorGitHub = {}, mapped = {}, manual = {}) {
  const priorMapped = priorGitHub.mapped || {};
  for (const field of ["priority", "mode", "humanGate"]) {
    if (mapped[field] != null) item[field] = mapped[field];
    else if (priorMapped[field] != null && item[field] === priorMapped[field]) {
      if (priorGitHub.manual?.[field] != null) item[field] = priorGitHub.manual[field];
      else delete item[field];
    }
  }
  if (mapped.requires) {
    const manualRequirements = (item.requires || []).filter((entry) => !(priorMapped.requires || []).includes(entry));
    item.requires = [...new Set([...manualRequirements, ...mapped.requires])];
  } else if (priorMapped.requires) {
    item.requires = (item.requires || []).filter((entry) => !priorMapped.requires.includes(entry));
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
    if (!item?.github) continue;
    const issue = byId.get(id);
    if (!issue) {
      findings.push({ issue: id, reason: "GitHub issue no longer resolves." });
      continue;
    }
    const dependencies = explicitDependencies(issue);
    const mapped = mappedMetadata(config, issueLabels(issue));
    const snapshot = githubSnapshot(issue, dependencies, mapped);
    if (snapshot.state !== "OPEN") findings.push({ issue: id, reason: `GitHub issue is ${snapshot.state.toLowerCase()}.` });
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

function proposeDraft({ repository, existingConfig = null, issues = [], selectedIssueIds = [], analyzers = null, agentAnalysis = null, executionStates = [] }) {
  if (existingConfig?.repository && existingConfig.repository !== repository) {
    throw new Error(`The existing manifest targets ${existingConfig.repository}, but the current checkout is ${repository}.`);
  }

  if (existingConfig) validateRepositoryConfig(existingConfig);

  const manifest = existingConfig ? clone(existingConfig) : { repository, work: {} };
  const existingWorkIds = new Set(Object.keys(existingConfig?.work || {}));
  const selected = new Set(selectedIssueIds.map(String));
  const seen = new Set();
  const ambiguous = new Set();
  const normalized = [];
  const unresolved = [];
  const drift = [];
  const conflicts = [];
  const preserved = [];
  const lifecycle = unresolvedWork(executionStates);

  for (const issue of issues) {
    const id = issueId(issue);
    if (!id) {
      unresolved.push({ issue: null, reason: "GitHub issue record has no positive integer number." });
      continue;
    }
    if (selected.size && !selected.has(id)) continue;
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
    const dependencies = explicitDependencies(issue);
    const mapped = mappedMetadata(manifest, issueLabels(issue));
    const original = manifest.work[id] ? clone(manifest.work[id]) : null;
    const manual = manualMetadata(original, mapped);
    const snapshot = githubSnapshot(issue, dependencies, mapped, manual);

    if (!original) {
      if (state !== "OPEN") {
        if (selected.has(id)) unresolved.push({ issue: id, reason: `Issue is ${state.toLowerCase()}, not open, and has no manifest history to reconcile.` });
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
    const priorGitHubDependencies = (original.github?.blockedBy || []).map(String);
    const manualDependencies = (original.blockedBy || []).map(String).filter((dependency) => !priorGitHubDependencies.includes(dependency));
    const nextDependencies = [...new Set([...manualDependencies, ...dependencies.map((entry) => entry.id)])];
    if (nextDependencies.length) proposed.blockedBy = nextDependencies;
    else delete proposed.blockedBy;
    applyMappedMetadata(proposed, original.github || {}, mapped, manual);

    if (state === "CLOSED" && ["ready", "blocked", "human_gate"].includes(proposed.status)) {
      recordTransition(proposed, proposed.status, "inactive", `GitHub issue closed${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}.`);
      proposed.status = "inactive";
    } else if (state === "OPEN" && ["inactive", "complete"].includes(proposed.status) && original.github?.state === "CLOSED") {
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
        || !same(original.github?.mapped || {}, proposed.github?.mapped || {});
      if (material && lifecycle.has(id)) {
        conflicts.push({ issue: id, type: "lifecycle", before: original, proposed, reason: `GitHub changed while Maestro run ${lifecycle.get(id).runId} is ${lifecycle.get(id).state}; the manifest entry was preserved.` });
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
      dependencySources.push({ issue: id, dependency: String(dependency), source: githubOwned ? `GitHub issue #${id} body` : "existing manifest blockedBy", added: changedIssues.has(id) && githubOwned });
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
  const acceptedAgentConflicts = [];
  if (agentAnalysis) {
    validateAgentOutput(agentAnalysis.output);
    const known = new Set(Object.keys(manifest.work));
    const analyzed = new Set(normalized.filter(({ id, issue }) => !ambiguous.has(id) && String(issue.state).toUpperCase() === "OPEN").map(({ id }) => id));
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
      if (recommendation.mode && item.mode == null) item.mode = recommendation.mode;
      if (recommendation.priority != null && item.priority == null) item.priority = recommendation.priority;
      if (recommendation.requires?.length) item.requires = [...new Set([...(item.requires || []), ...recommendation.requires])];
      if (recommendation.humanGate && !existingWorkIds.has(recommendation.issue) && item.humanGate == null) {
        item.status = "human_gate";
        item.humanGate = recommendation.humanGate;
      } else if (recommendation.humanGate && item.humanGate !== recommendation.humanGate) {
        agentUnresolved.push({ issue: recommendation.issue, reason: `Agent recommends human gate "${recommendation.humanGate}", but existing manifest state takes precedence.` });
      }
    }

    for (const recommendation of agentAnalysis.output.conflicts) {
      const valid = recommendation.issues.map((id) => checkKnown(id, "conflict")).every(Boolean);
      if (recommendation.issues[0] === recommendation.issues[1]) {
        agentDiagnostics.push({ issue: recommendation.issues[0], reason: "Agent conflict must reference two different issues." });
        continue;
      }
      if (!valid) continue;
      if (recommendation.confidence === "low") {
        agentUnresolved.push({ issue: recommendation.issues[0], reason: `Low-confidence conflict with #${recommendation.issues[1]}: ${recommendation.reason}` });
        continue;
      }
      acceptedAgentConflicts.push({
        issues: [...recommendation.issues].map(String).sort(issueOrder),
        confidence: recommendation.confidence,
        source: agentSource(agentAnalysis, recommendation),
        reason: recommendation.reason,
        analyzer: "agent"
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
    manifest.planning = {
      ...(manifest.planning || {}),
      agentAnalysis: { ...agentAnalysis.metadata, recommendations: agentAnalysis.output }
    };
  }

  const activeAnalyzers = analyzers == null ? configuredAnalyzers(manifest) : analyzers;
  const inferredConflicts = [...runAdvisoryAnalyzers({ analyzers: activeAnalyzers, issues: normalized, manifest }), ...acceptedAgentConflicts];
  const existingConflicts = manifest.planning?.advisoryConflicts || [];
  const activeAnalyzerNames = new Set(activeAnalyzers.map((analyzer) => analyzer.name || "custom"));
  if (agentAnalysis) activeAnalyzerNames.add("agent");
  const analyzedIssueIds = new Set(normalized.map(({ id }) => id));
  const retainedConflicts = existingConflicts.filter((conflict) => {
    if (!activeAnalyzerNames.has(conflict.analyzer)) return true;
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
    ...agentDiagnostics
  ];
  const planning = computeExpectedWaves(manifest);
  added.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  unresolved.sort((a, b) => String(a.issue || "").localeCompare(String(b.issue || "")) || a.reason.localeCompare(b.reason));
  drift.sort((a, b) => issueOrder(a.issue, b.issue) || a.type.localeCompare(b.type));
  conflicts.sort((a, b) => issueOrder(a.issue, b.issue) || a.type.localeCompare(b.type));
  preserved.sort((a, b) => issueOrder(a.issue, b.issue) || a.reason.localeCompare(b.reason));
  dependencySources.sort((a, b) => issueOrder(a.issue, b.issue) || issueOrder(a.dependency, b.dependency) || a.source.localeCompare(b.source));
  return {
    manifest,
    added,
    drift,
    conflicts,
    preserved,
    unresolved,
    diagnostics,
    dependencySources,
    inferredConflicts,
    agentRecommendations: agentAnalysis?.output || null,
    acceptedAgentDependencies,
    planning,
    created: !existingConfig,
    changed: !existingConfig || JSON.stringify(existingConfig) !== JSON.stringify(manifest),
    writable: diagnostics.length === 0
  };
}

function formatDraftSummary({ repository, manifestPath, result, write }) {
  const lines = [
    `Maestro draft for ${repository}`,
    `Manifest: ${manifestPath}`,
    "Changes:"
  ];
  if (result.created) lines.push("  + create manifest");
  if (result.added.length) {
    for (const id of result.added) lines.push(`  + #${id} ${result.manifest.work[id].status}`);
  }
  for (const change of result.drift.filter((entry) => entry.type !== "missing-open")) {
    lines.push(`  ~ #${change.issue} ${change.reason}`);
  }
  if (!result.drift.length && !result.created) {
    lines.push("  (no changes)");
  }
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
    for (const dependency of result.dependencySources) {
      lines.push(`  ${dependency.added ? "+ " : "  "}#${dependency.issue} blocked by #${dependency.dependency} (${dependency.source})`);
    }
  }
  if (result.inferredConflicts.length) {
    lines.push("Advisory conflict risk:");
    for (const conflict of result.inferredConflicts) {
      lines.push(`  ~ #${conflict.issues[0]} / #${conflict.issues[1]}: ${conflict.reason} (${conflict.confidence}; ${conflict.source})`);
    }
  }
  if (result.agentRecommendations) {
    lines.push("Agent-assisted recommendations:");
    lines.push(`  ${result.acceptedAgentDependencies.length} high-confidence hard dependencies accepted into the proposal.`);
    for (const recommendation of result.agentRecommendations.work) {
      lines.push(`  ~ #${recommendation.issue}: ${recommendation.reason} (${recommendation.confidence}; ${recommendation.evidence.join(" | ")})`);
    }
    for (const recommendation of result.agentRecommendations.waves) {
      lines.push(`  ~ suggested wave ${recommendation.issues.map((id) => `#${id}`).join(", ")}: ${recommendation.reason} (${recommendation.confidence})`);
    }
  }
  lines.push("Expected execution waves:");
  if (result.planning.waves.length) {
    result.planning.waves.forEach((wave, index) => lines.push(`  Wave ${index + 1}: ${wave.map((id) => `#${id}`).join(", ")}`));
  } else {
    lines.push("  (no schedulable work)");
  }
  lines.push(`  ${result.planning.available}-way dependency independence available; repository limit is ${result.planning.concurrency}.`);
  for (const decision of result.planning.decisions.filter((entry) => entry.state === "serialized")) {
    lines.push(`  #${decision.issue} serialized conservatively: ${decision.reason} (${decision.confidence}; ${decision.source})`);
  }
  for (const decision of result.planning.unresolved) lines.push(`  #${decision.issue} unresolved: ${decision.reason}`);
  if (result.diagnostics.length) {
    lines.push("Blocking diagnostics:");
    for (const diagnostic of result.diagnostics) lines.push(`  ! ${diagnostic.issue ? `#${diagnostic.issue}: ` : ""}${diagnostic.reason}`);
  }
  lines.push("Proposed manifest:", JSON.stringify(result.manifest, null, 2));
  if (!write) lines.push("Dry run; use --write to persist this manifest.");
  else if (!result.writable) lines.push("Write blocked; resolve dependency diagnostics and draft again.");
  else if (result.changed) lines.push("Writing schema-valid manifest.");
  else lines.push("Schema-valid manifest is already current; nothing written.");
  return `${lines.join("\n")}\n`;
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

function writeManifest(manifestPath, manifest, { expectedContents } = {}) {
  validateRepositoryConfig(manifest);
  const diagnostics = [
    ...validateDependencyGraph(manifest.work),
    ...validateAdvisoryReferences(manifest.work, manifest.planning?.advisoryConflicts || [])
  ];
  if (diagnostics.length) throw new Error(`Cannot write unsafe Maestro manifest: ${diagnostics.map((entry) => entry.reason).join(" ")}`);
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
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

module.exports = { proposeDraft, formatDraftSummary, readExistingManifest, readManifestSnapshot, writeManifest, explicitDependencies, detectExecutionDrift };

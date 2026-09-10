const fs = require("node:fs");
const { validateRepositoryConfig } = require("./config-validator");
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

function conflictKey(conflict) {
  return [...conflict.issues].map(String).sort(issueOrder).join(":") + `:${conflict.analyzer}:${conflict.source}`;
}

function agentSource(agentAnalysis, recommendation) {
  return `agent:${agentAnalysis.metadata.provider} context:${agentAnalysis.metadata.contextDigest.slice(0, 12)}; evidence: ${recommendation.evidence.join(" | ")}`;
}

function proposeDraft({ repository, existingConfig = null, issues = [], selectedIssueIds = [], analyzers = null, agentAnalysis = null }) {
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
  for (const { id, issue } of normalized) {
    if (ambiguous.has(id)) continue;
    if (String(issue.state).toUpperCase() !== "OPEN") {
      unresolved.push({ issue: id, reason: `Issue is ${String(issue.state || "in an unknown state").toLowerCase()}, not open.` });
      continue;
    }
    if (manifest.work[id]) continue;
    manifest.work[id] = { status: "ready" };
    added.push(id);
  }

  const dependencySources = [];
  for (const [id, item] of Object.entries(manifest.work)) {
    for (const dependency of item.blockedBy || []) {
      dependencySources.push({ issue: id, dependency: String(dependency), source: "existing manifest blockedBy", added: false });
    }
  }
  for (const { id, issue } of normalized) {
    if (ambiguous.has(id) || !manifest.work[id] || String(issue.state).toUpperCase() !== "OPEN") continue;
    const currentDependencies = (manifest.work[id].blockedBy || []).map(String);
    const current = new Set(currentDependencies);
    let dependenciesChanged = false;
    for (const dependency of explicitDependencies(issue)) {
      const addedDependency = !current.has(dependency.id);
      current.add(dependency.id);
      if (addedDependency) {
        currentDependencies.push(dependency.id);
        dependenciesChanged = true;
      }
      const existingSource = dependencySources.find((entry) => entry.issue === id && entry.dependency === dependency.id);
      if (existingSource) existingSource.source = `${existingSource.source}; ${dependency.source}`;
      else dependencySources.push({ issue: id, dependency: dependency.id, source: dependency.source, added: addedDependency });
    }
    if (dependenciesChanged) manifest.work[id].blockedBy = currentDependencies;
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
  dependencySources.sort((a, b) => issueOrder(a.issue, b.issue) || issueOrder(a.dependency, b.dependency) || a.source.localeCompare(b.source));
  return {
    manifest,
    added,
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
  } else if (!result.created) {
    lines.push("  (no changes)");
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

function writeManifest(manifestPath, manifest) {
  validateRepositoryConfig(manifest);
  const diagnostics = [
    ...validateDependencyGraph(manifest.work),
    ...validateAdvisoryReferences(manifest.work, manifest.planning?.advisoryConflicts || [])
  ];
  if (diagnostics.length) throw new Error(`Cannot write unsafe Maestro manifest: ${diagnostics.map((entry) => entry.reason).join(" ")}`);
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, "utf8") === contents) return false;
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, "utf8");
    fs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  return true;
}

module.exports = { proposeDraft, formatDraftSummary, readExistingManifest, writeManifest, explicitDependencies };

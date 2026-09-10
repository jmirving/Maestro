function issueOrder(a, b) {
  return Number(a) - Number(b) || String(a).localeCompare(String(b));
}

function orderedPair(left, right) {
  return [String(left), String(right)].sort(issueOrder);
}

function relationshipKey(relationship) {
  return orderedPair(...relationship.issues).join(":");
}

function normalizeLabel(label) {
  if (typeof label === "string") return label;
  return typeof label?.name === "string" ? label.name : null;
}

function createSharedLabelAnalyzer(config = {}) {
  const configuredLabels = new Set((config.labels || []).map((label) => String(label).toLowerCase()));
  return {
    name: "shared-label",
    analyze({ issues }) {
      const records = issues.map(({ id, issue }) => ({
        id,
        labels: new Set((issue.labels || [])
          .map(normalizeLabel)
          .filter(Boolean)
          .filter((label) => configuredLabels.has(label.toLowerCase())))
      }));
      const relationships = [];
      for (let left = 0; left < records.length; left += 1) {
        for (let right = left + 1; right < records.length; right += 1) {
          const shared = [...records[left].labels].filter((label) => records[right].labels.has(label)).sort();
          if (!shared.length) continue;
          relationships.push({
            issues: orderedPair(records[left].id, records[right].id),
            confidence: config.confidence || "medium",
            source: `GitHub labels: ${shared.join(", ")}`,
            reason: `Both issues are mapped to ${shared.join(", ")}.`,
            analyzer: "shared-label"
          });
        }
      }
      return relationships;
    }
  };
}

function configuredAnalyzers(config = {}) {
  return (config.planning?.analyzers || []).map((analyzer) => {
    if (analyzer.type === "shared-label") return createSharedLabelAnalyzer(analyzer);
    throw new Error(`Unsupported planning analyzer type: ${analyzer.type}`);
  });
}

function runAdvisoryAnalyzers({ analyzers = [], issues = [], manifest }) {
  const relationships = [];
  for (const analyzer of analyzers) {
    if (!analyzer || typeof analyzer.analyze !== "function") {
      throw new Error("Planning analyzers must expose an analyze({ issues, manifest }) function.");
    }
    const output = analyzer.analyze({ issues, manifest });
    if (!Array.isArray(output)) throw new Error(`Planning analyzer ${analyzer.name || "unnamed"} did not return an array.`);
    for (const relationship of output) {
      if (!Array.isArray(relationship?.issues) || relationship.issues.length !== 2) {
        throw new Error(`Planning analyzer ${analyzer.name || "unnamed"} returned a relationship without exactly two issues.`);
      }
      const pair = orderedPair(...relationship.issues);
      if (pair[0] === pair[1]) continue;
      relationships.push({
        issues: pair,
        confidence: relationship.confidence || "medium",
        source: relationship.source || `analyzer:${analyzer.name || "unnamed"}`,
        reason: relationship.reason || "Analyzer reported likely implementation overlap.",
        analyzer: relationship.analyzer || analyzer.name || "custom"
      });
    }
  }
  const unique = new Map();
  for (const relationship of relationships) {
    const key = `${relationshipKey(relationship)}:${relationship.analyzer}:${relationship.source}`;
    unique.set(key, relationship);
  }
  return [...unique.values()].sort((a, b) => relationshipKey(a).localeCompare(relationshipKey(b)) || a.source.localeCompare(b.source));
}

async function runPlanningAnalyzer(analyzer, input) {
  if (!analyzer || typeof analyzer.analyze !== "function") {
    throw new Error("Planning analyzers must expose an analyze(input) function.");
  }
  return analyzer.analyze(input);
}

function validateDependencyGraph(work = {}) {
  const ids = new Set(Object.keys(work).map(String));
  const diagnostics = [];
  for (const [id, item] of Object.entries(work)) {
    for (const dependency of item.blockedBy || []) {
      const target = String(dependency);
      if (!ids.has(target)) diagnostics.push({ issue: String(id), reason: `Hard dependency #${target} is not present in manifest work.` });
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const reported = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const key = cycle.join("->");
      if (!reported.has(key)) {
        diagnostics.push({ issue: id, reason: `Hard dependency cycle detected: ${cycle.map((entry) => `#${entry}`).join(" -> ")}.` });
        reported.add(key);
      }
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of work[id]?.blockedBy || []) {
      const target = String(dependency);
      if (ids.has(target)) visit(target);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of [...ids].sort(issueOrder)) visit(id);
  return diagnostics;
}

function validateAdvisoryReferences(work = {}, conflicts = []) {
  const ids = new Set(Object.keys(work).map(String));
  const diagnostics = [];
  for (const relationship of conflicts) {
    for (const issue of relationship.issues || []) {
      if (!ids.has(String(issue))) {
        diagnostics.push({ issue: String(issue), reason: `Advisory conflict from ${relationship.source || "an unknown source"} references work not present in the manifest.` });
      }
    }
  }
  return diagnostics;
}

function conflictFor(left, right, conflicts) {
  const key = orderedPair(left, right).join(":");
  return conflicts.find((relationship) => relationshipKey(relationship) === key);
}

function compareWorkIds(work, left, right) {
  const leftPriority = Number.isFinite(Number(work[left]?.priority)) ? Number(work[left].priority) : Number.POSITIVE_INFINITY;
  const rightPriority = Number.isFinite(Number(work[right]?.priority)) ? Number(work[right].priority) : Number.POSITIVE_INFINITY;
  return leftPriority - rightPriority || issueOrder(left, right);
}

function computeExpectedWaves(config) {
  const work = config.work || {};
  const concurrency = Math.max(1, Number(config.defaultConcurrency || 2));
  const complete = new Set(Object.entries(work).filter(([, item]) => item.status === "complete").map(([id]) => String(id)));
  const remaining = new Set(Object.entries(work).filter(([, item]) => item.status === "ready").map(([id]) => String(id)));
  const conflicts = config.planning?.advisoryConflicts || [];
  const waves = [];
  const decisions = [];
  let available = 0;

  while (remaining.size) {
    const candidates = [...remaining]
      .filter((id) => (work[id].blockedBy || []).every((dependency) => complete.has(String(dependency))))
      .sort((left, right) => compareWorkIds(work, left, right));
    if (!candidates.length) break;
    available = Math.max(available, candidates.length);
    const selected = [];
    for (const id of candidates) {
      if (selected.length >= concurrency) break;
      const conflict = selected.map((other) => conflictFor(id, other, conflicts)).find(Boolean);
      if (conflict) {
        decisions.push({ issue: id, state: "serialized", reason: `Deferred from #${conflict.issues.find((entry) => String(entry) !== id)} due to ${conflict.reason}`, source: conflict.source, confidence: conflict.confidence });
        continue;
      }
      selected.push(id);
    }
    // A fully connected advisory set must still make progress, one item at a time.
    if (!selected.length) selected.push(candidates[0]);
    waves.push(selected);
    for (const id of selected) {
      remaining.delete(id);
      complete.add(id);
      const dependencies = (work[id].blockedBy || []).map(String);
      decisions.push({
        issue: id,
        state: "wave",
        wave: waves.length,
        reason: dependencies.length ? `Hard dependencies satisfied: ${dependencies.map((entry) => `#${entry}`).join(", ")}.` : "No unresolved hard dependencies.",
        source: dependencies.length ? "manifest blockedBy" : "manifest work status"
      });
    }
  }

  const unresolved = [...remaining].sort(issueOrder).map((id) => ({
    issue: id,
    state: "unresolved",
    reason: `Waiting on ${work[id].blockedBy.filter((dependency) => !complete.has(String(dependency))).map((entry) => `#${entry}`).join(", ") || "non-ready work"}.`,
    source: "manifest blockedBy"
  }));
  for (const [id, item] of Object.entries(work).sort(([left], [right]) => issueOrder(left, right))) {
    if (item.status === "blocked") {
      const waiting = (item.blockedBy || []).filter((dependency) => !complete.has(String(dependency))).map((entry) => `#${entry}`);
      unresolved.push({ issue: id, state: "blocked", reason: `Manifest status is blocked${waiting.length ? `; waiting on ${waiting.join(", ")}` : ""}.`, source: "manifest work status" });
    } else if (item.status === "human_gate") {
      unresolved.push({ issue: id, state: "unresolved", reason: `Human gate: ${item.humanGate || "approval required"}.`, source: "manifest work status" });
    }
  }
  return { concurrency, available, waves, decisions, unresolved };
}

module.exports = {
  configuredAnalyzers,
  createSharedLabelAnalyzer,
  runAdvisoryAnalyzers,
  runPlanningAnalyzer,
  validateDependencyGraph,
  validateAdvisoryReferences,
  computeExpectedWaves,
  conflictFor,
  issueOrder
};

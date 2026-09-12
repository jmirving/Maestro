const { conflictFor } = require("./planning-analysis");
const { resolveConcurrency } = require("./concurrency");

function normalizeWork(work = {}) {
  return Object.entries(work).map(([id, item]) => ({
    id: String(id),
    status: item.status,
    mode: item.mode || "execute",
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : null,
    blockedBy: (item.blockedBy || []).map(String),
    requires: [...new Set(item.requires || [])],
    humanGate: item.humanGate || null
  }));
}

function compareReady(a, b) {
  const aPriority = a.priority == null ? Number.POSITIVE_INFINITY : a.priority;
  const bPriority = b.priority == null ? Number.POSITIVE_INFINITY : b.priority;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);
}

function selectReady(ready, capacity, conflicts = [], activeIssues = []) {
  const selected = [];
  const advisoryDeferred = [];
  const active = activeIssues.map(String);
  for (const item of ready) {
    if (selected.length >= capacity) break;
    const against = [...active, ...selected.map((other) => other.id)];
    const conflict = against.map((other) => conflictFor(item.id, other, conflicts)).find(Boolean);
    if (conflict) {
      advisoryDeferred.push({
        ...item,
        conflictsWith: conflict.issues.find((id) => String(id) !== item.id),
        reason: conflict.reason,
        source: conflict.source,
        confidence: conflict.confidence
      });
      continue;
    }
    selected.push(item);
  }
  return { selected, advisoryDeferred };
}

function computePlan(config, { issueIds = null, workset = null, scopeRevision = null, concurrency: suppliedConcurrency } = {}) {
  const work = normalizeWork(config.work);
  const selectedScope = issueIds == null ? null : new Set(issueIds.map(String));
  if (workset && !selectedScope) throw new Error(`Planning workset '${workset}' requires a resolved issue scope.`);
  if (workset) {
    const configured = new Set(Object.keys(config.work || {}).map(String));
    const missing = [...selectedScope].filter((id) => !configured.has(id)).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    if (missing.length) {
      throw new Error(`Workset '${workset}' cannot be planned because authorized ${missing.map((id) => `issue #${id}`).join(", ")} ${missing.length === 1 ? "is" : "are"} absent from the shared work graph. Refresh the workset draft before planning or launch.`);
    }
  }
  const complete = new Set(work.filter((item) => item.status === "complete").map((item) => item.id));
  const ready = [];
  const blocked = [];
  const humanGates = [];

  for (const item of work) {
    if (selectedScope && !selectedScope.has(item.id)) continue;
    if (item.status === "complete") continue;
    if (item.status === "human_gate") {
      humanGates.push(item);
      continue;
    }
    const unresolved = item.blockedBy.filter((id) => !complete.has(id));
    if (item.status === "blocked" || unresolved.length) {
      blocked.push({
        ...item,
        unresolved,
        ...(selectedScope ? { outsideScope: unresolved.filter((id) => !selectedScope.has(id)) } : {})
      });
      continue;
    }
    if (item.status === "ready") ready.push(item);
  }

  ready.sort(compareReady);
  const concurrencySetting = suppliedConcurrency?.value
    ? suppliedConcurrency
    : resolveConcurrency({ override: suppliedConcurrency, savedDefault: config.defaultConcurrency });
  const concurrency = concurrencySetting.value;
  const conflicts = config.planning?.advisoryConflicts || [];
  const { selected, advisoryDeferred } = selectReady(ready, concurrency, conflicts);
  return {
    repository: config.repository,
    ...(workset ? { workset, scopeRevision, authorizedIssueIds: [...selectedScope].sort((a, b) => Number(a) - Number(b)) } : {}),
    concurrency,
    concurrencySource: concurrencySetting.source,
    savedDefaultConcurrency: concurrencySetting.savedDefault,
    ready,
    selected,
    advisoryDeferred,
    blocked,
    humanGates
  };
}

module.exports = { computePlan, normalizeWork, compareReady, selectReady };

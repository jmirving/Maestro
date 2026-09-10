const { conflictFor } = require("./planning-analysis");

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

function computePlan(config) {
  const work = normalizeWork(config.work);
  const complete = new Set(work.filter((item) => item.status === "complete").map((item) => item.id));
  const ready = [];
  const blocked = [];
  const humanGates = [];

  for (const item of work) {
    if (item.status === "complete") continue;
    if (item.status === "human_gate") {
      humanGates.push(item);
      continue;
    }
    const unresolved = item.blockedBy.filter((id) => !complete.has(id));
    if (item.status === "blocked" || unresolved.length) {
      blocked.push({ ...item, unresolved });
      continue;
    }
    if (item.status === "ready") ready.push(item);
  }

  ready.sort(compareReady);
  const concurrency = Math.max(1, Number(config.defaultConcurrency || 2));
  const selected = [];
  const advisoryDeferred = [];
  const conflicts = config.planning?.advisoryConflicts || [];
  for (const item of ready) {
    if (selected.length >= concurrency) break;
    const conflict = selected.map((other) => conflictFor(item.id, other.id, conflicts)).find(Boolean);
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
  return {
    repository: config.repository,
    concurrency,
    ready,
    selected,
    advisoryDeferred,
    blocked,
    humanGates
  };
}

module.exports = { computePlan, normalizeWork, compareReady };

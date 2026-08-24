function normalizeWork(work = {}) {
  return Object.entries(work).map(([id, item]) => ({
    id: String(id),
    status: item.status,
    mode: item.mode || "execute",
    blockedBy: (item.blockedBy || []).map(String),
    requires: [...new Set(item.requires || [])],
    humanGate: item.humanGate || null
  }));
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

  const concurrency = Math.max(1, Number(config.defaultConcurrency || 2));
  return {
    repository: config.repository,
    concurrency,
    ready,
    selected: ready.slice(0, concurrency),
    blocked,
    humanGates
  };
}

module.exports = { computePlan, normalizeWork };

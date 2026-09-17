const fs = require("node:fs/promises");
const path = require("node:path");
const { loadExecutionStates, reconcilePlan } = require("./work-state");
const { reportRootForRepo } = require("./reporter");
const { saveRunState } = require("./run-store");
const { conflictFor } = require("./planning-analysis");
const { selectReady } = require("./planner");

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withCapacityLock(repoPath, operation, {
  retryMs = LOCK_RETRY_MS,
  timeoutMs = LOCK_TIMEOUT_MS
} = {}) {
  const root = reportRootForRepo(repoPath);
  const lock = path.join(root, ".capacity.lock");
  await fs.mkdir(root, { recursive: true });
  const started = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await fs.open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number((await fs.readFile(lock, "utf8")).trim());
        if (Number.isInteger(owner) && owner > 0) process.kill(owner, 0);
      } catch (ownerError) {
        if (ownerError.code === "ESRCH") {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for Maestro's repository capacity lock at ${lock}.`);
      }
      await sleep(retryMs);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lock).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function activeRunIds(plan) {
  return [...new Set((plan.active || []).map((entry) => String(entry.runId)))];
}

function aggregateLimit(config, states, plan) {
  const requested = Math.max(1, Number(config.defaultConcurrency || 2));
  const activeIds = new Set(activeRunIds(plan));
  const owner = states
    .filter((state) => activeIds.has(String(state.runId)) && Number.isInteger(state.capacity?.limit))
    .sort((a, b) => String(a.capacity?.sessionStartedAt || a.runId).localeCompare(String(b.capacity?.sessionStartedAt || b.runId)))[0];
  return {
    limit: owner?.capacity.limit || requested,
    requestedLimit: requested,
    sessionId: owner?.capacity.sessionId || owner?.runId || null,
    inherited: Boolean(owner)
  };
}

function capacitySnapshot(config, states, planOptions = {}) {
  const initial = reconcilePlan(config, states, planOptions);
  const aggregate = aggregateLimit(config, states, initial);
  const effectiveConfig = { ...config, defaultConcurrency: aggregate.limit };
  const plan = reconcilePlan(effectiveConfig, states, planOptions);
  const used = plan.active.length;
  const available = Math.max(0, aggregate.limit - used);
  const lifecycleGates = plan.deferred.filter((item) => !["running", "rework-running"].includes(item.lifecycle?.state));
  return {
    ...aggregate,
    used,
    available,
    active: plan.active,
    plan,
    idle: available === 0
      ? { kind: "exhausted", reason: `all ${aggregate.limit} worker slots are reserved` }
      : plan.selected.length
        ? null
        : plan.ready.length === 0
          ? plan.humanGates.length || lifecycleGates.length
            ? { kind: "human-gate", reason: "authorized work is waiting for review, rework, integration, or another human decision" }
            : plan.blocked.length
              ? { kind: "dependency", reason: "authorized work is waiting on hard dependencies" }
              : { kind: "no-authorized-work", reason: "no authorized runnable work is available" }
          : { kind: "conflict", reason: "ready work is constrained by active advisory conflicts" }
  };
}

function reservedRunState({ repoPath, runId, mode, plan, capacity, extraState = {} }) {
  const now = new Date().toISOString();
  return {
    runId,
    mode,
    status: "running",
    repoPath,
    plan,
    baseline: null,
    preflights: [],
    workers: [],
    validations: [],
    reviews: {},
    ...extraState,
    capacity: {
      scope: "repository",
      limit: capacity.limit,
      requestedLimit: capacity.requestedLimit,
      sessionId: capacity.sessionId || runId,
      sessionStartedAt: capacity.sessionId ? undefined : now,
      reservedAt: now,
      issues: plan.selected.map((item) => String(item.id))
    }
  };
}

async function reserveReadyWork(config, {
  repoPath,
  runId,
  mode = "execute",
  authorizedIssueIds = null,
  stateLoader = loadExecutionStates,
  stateSaver = saveRunState,
  planOptions = {},
  extraState = {}
} = {}) {
  return withCapacityLock(repoPath, async () => {
    const states = await stateLoader(repoPath);
    const capacity = capacitySnapshot(config, states, planOptions);
    const authorized = authorizedIssueIds && new Set(authorizedIssueIds.map(String));
    const selected = capacity.plan.selected.filter((item) => !authorized || authorized.has(String(item.id)));
    const plan = { ...capacity.plan, selected };
    if (!selected.length) return { reserved: false, capacity, plan, state: null };
    const state = reservedRunState({ repoPath, runId, mode, plan, capacity, extraState });
    await stateSaver(repoPath, runId, state);
    return { reserved: true, capacity, plan, state };
  });
}

async function reserveExplicitWork(config, {
  repoPath,
  runId,
  mode,
  items,
  stateLoader = loadExecutionStates,
  stateSaver = saveRunState,
  extraState = {}
} = {}) {
  const requested = items.map((item) => ({ ...item, id: String(item.id) }));
  if (!requested.length) {
    const states = await stateLoader(repoPath);
    const capacity = capacitySnapshot(config, states);
    return { reserved: false, reason: "no-work", capacity, plan: capacity.plan, state: null };
  }
  return withCapacityLock(repoPath, async () => {
    const states = await stateLoader(repoPath);
    const capacity = capacitySnapshot(config, states);
    const activeIssues = new Set(capacity.active.map((entry) => String(entry.issue)));
    const duplicate = requested.find((item) => activeIssues.has(item.id));
    if (duplicate) {
      return { reserved: false, reason: "duplicate", issue: duplicate.id, capacity, state: null };
    }
    if (requested.length > capacity.available) {
      return { reserved: false, reason: "exhausted", capacity, state: null };
    }
    const conflicts = config.planning?.advisoryConflicts || [];
    const internalConflict = requested.flatMap((item, index) => requested.slice(index + 1).map((other) => ({
      item,
      other,
      relationship: conflictFor(item.id, other.id, conflicts)
    }))).find((entry) => entry.relationship);
    if (internalConflict) {
      return {
        reserved: false,
        reason: "conflict",
        issue: internalConflict.item.id,
        conflictsWith: internalConflict.other.id,
        capacity,
        state: null
      };
    }
    const conflict = requested.flatMap((item) => capacity.active.map((active) => ({
      item,
      active,
      relationship: conflictFor(item.id, active.issue, conflicts)
    }))).find((entry) => entry.relationship);
    if (conflict) {
      return {
        reserved: false,
        reason: "conflict",
        issue: conflict.item.id,
        conflictsWith: conflict.active.issue,
        capacity,
        state: null
      };
    }
    const plan = { ...capacity.plan, selected: requested };
    const state = reservedRunState({ repoPath, runId, mode, plan, capacity, extraState });
    await stateSaver(repoPath, runId, state);
    return { reserved: true, capacity, plan, state };
  });
}

function capacityBatches(items, capacity, conflicts = []) {
  const pending = items.map((item) => ({ ...item, id: String(item.id) }));
  const batches = [];
  while (pending.length) {
    const { selected } = selectReady(pending, capacity, conflicts);
    if (!selected.length) selected.push(pending[0]);
    const selectedIds = new Set(selected.map((item) => item.id));
    batches.push(selected);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (selectedIds.has(pending[index].id)) pending.splice(index, 1);
    }
  }
  return batches;
}

async function runCapacityPool(tasks, capacity, executor) {
  if (!Number.isInteger(capacity) || capacity < 0) throw new Error("Capacity pool size must be a non-negative integer.");
  if (!tasks.length || capacity === 0) return [];
  const results = new Array(tasks.length);
  let cursor = 0;
  let used = 0;
  let firstError = null;
  await new Promise((resolve) => {
    function schedule() {
      if (firstError) {
        if (used === 0) resolve();
        return;
      }
      while (cursor < tasks.length) {
        const index = cursor;
        const weight = Math.max(1, Number(tasks[index]?.weight || 1));
        if (!Number.isInteger(weight) || weight > capacity) {
          firstError = new Error(`Task ${index} requires ${weight} worker slots but pool capacity is ${capacity}.`);
          if (used === 0) resolve();
          return;
        }
        if (used + weight > capacity) break;
        cursor += 1;
        used += weight;
        Promise.resolve(executor(tasks[index], index)).then((result) => {
          results[index] = result;
        }, (error) => {
          firstError ||= error;
        }).finally(() => {
          used -= weight;
          if ((cursor >= tasks.length || firstError) && used === 0) resolve();
          else schedule();
        });
      }
    }
    schedule();
  });
  if (firstError) throw firstError;
  return results;
}

// Drive a workflow from effective repository state, rather than from a list
// captured before any work starts. Reservations remain the authority for both
// issue ownership and aggregate capacity; this loop only decides what the
// current caller is allowed to ask for next.
async function runLifecycleBackfill(config, {
  repoPath,
  authorizedIssueIds,
  planOptions = {},
  initialTasks = [],
  reserveInitial = null,
  executeInitial,
  executeReserved,
  verifySelection = async () => {},
  runIdFactory,
  extraState = {}
} = {}) {
  const authorized = [...new Set((authorizedIssueIds || Object.keys(config.work || {})).map(String))];
  const scopedPlanOptions = { ...planOptions, issueIds: authorized };
  const pending = [...initialTasks];
  const running = new Set();
  const outcomes = [];
  let firstError = null;

  const launch = (promise) => {
    let tracked;
    tracked = Promise.resolve(promise).then((result) => {
      outcomes.push(result);
    }, (error) => {
      firstError ||= error;
    }).finally(() => running.delete(tracked));
    running.add(tracked);
  };

  for (;;) {
    let launched = false;
    while (!firstError) {
      const states = await loadExecutionStates(repoPath);
      const capacity = capacitySnapshot(config, states, scopedPlanOptions);
      if (capacity.available === 0) break;

      if (pending.length) {
        const task = pending[0];
        const prepared = reserveInitial ? await reserveInitial(task) : null;
        if (prepared && !prepared.reserved) break;
        pending.shift();
        launch(executeInitial(task, prepared));
        launched = true;
        continue;
      }

      const candidate = capacity.plan.selected[0];
      if (!candidate) break;
      await verifySelection([candidate.id]);
      const runId = runIdFactory();
      const reservation = await reserveReadyWork(config, {
        repoPath,
        runId,
        mode: "backfill",
        authorizedIssueIds: [candidate.id],
        planOptions: scopedPlanOptions,
        extraState
      });
      if (!reservation.reserved) continue;
      launch(executeReserved({ candidate, runId, reservation }));
      launched = true;
    }

    if (running.size) {
      await Promise.race(running);
      continue;
    }
    if (firstError) throw firstError;
    if (pending.length) {
      const error = new Error("Cannot start authorized work because the repository worker capacity is exhausted.");
      error.code = "CAPACITY_UNAVAILABLE";
      throw error;
    }
    if (!launched) break;
  }
  return outcomes;
}

module.exports = {
  withCapacityLock,
  aggregateLimit,
  capacitySnapshot,
  reservedRunState,
  reserveReadyWork,
  reserveExplicitWork,
  capacityBatches,
  runCapacityPool,
  runLifecycleBackfill
};

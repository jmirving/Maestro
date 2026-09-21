const { loadExecutionStates, reconcilePlan } = require("./work-state");
const { saveRunState } = require("./run-store");
const { conflictFor } = require("./planning-analysis");
const { selectReady } = require("./planner");
const { currentIssueEvidenceFromStates } = require("./run-resolver");
const { withRepositoryCoordination } = require("./repository-coordination");

const withCapacityLock = withRepositoryCoordination;

function activeRunIds(plan) {
  return [...new Set((plan.active || []).map((entry) => String(entry.runId)))];
}

function aggregateLimit(config, states, plan) {
  const requested = plan.concurrency;
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
  const concurrency = aggregate.inherited
    ? {
        value: aggregate.limit,
        source: "captured session",
        savedDefault: initial.savedDefaultConcurrency
      }
    : {
        value: initial.concurrency,
        source: initial.concurrencySource,
        savedDefault: initial.savedDefaultConcurrency
      };
  const plan = reconcilePlan(config, states, { ...planOptions, concurrency });
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
    const authorized = authorizedIssueIds && new Set(authorizedIssueIds.map(String));
    const scopedIssueIds = authorized
      ? planOptions.issueIds
        ? planOptions.issueIds.map(String).filter((id) => authorized.has(id))
        : [...authorized]
      : planOptions.issueIds;
    const scopedPlanOptions = scopedIssueIds ? { ...planOptions, issueIds: scopedIssueIds } : planOptions;
    const capacity = capacitySnapshot(config, states, scopedPlanOptions);
    const plan = capacity.plan;
    if (!plan.selected.length) return { reserved: false, capacity, plan, state: null };
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
  expectedCurrent = [],
  currentEligibility = null,
  planOptions = {},
  extraState = {},
  existingState = null,
  beforePersist = async () => {}
} = {}) {
  const requested = items.map((item) => ({ ...item, id: String(item.id) }));
  if (!requested.length) {
    const states = await stateLoader(repoPath);
    const capacity = capacitySnapshot(config, states, planOptions);
    return { reserved: false, reason: "no-work", capacity, plan: capacity.plan, state: null };
  }
  return withCapacityLock(repoPath, async () => {
    const states = await stateLoader(repoPath);
    const expectedByIssue = new Map(expectedCurrent.map((entry) => [String(entry.issue), entry]));
    const current = expectedByIssue.size
      ? currentIssueEvidenceFromStates(states)
        .filter((entry) => expectedByIssue.has(String(entry.issue)))
      : [];
    const currentByIssue = new Map(current.map((entry) => [String(entry.issue), entry]));
    const changed = requested.find((item) => {
      const expected = expectedByIssue.get(item.id);
      if (!expected) return false;
      const actual = currentByIssue.get(item.id);
      if (expected.runId == null) return Boolean(actual);
      return !actual || String(actual.runId) !== String(expected.runId) ||
        (currentEligibility && !currentEligibility(actual));
    });
    if (changed) {
      return {
        reserved: false,
        reason: "changed-evidence",
        issue: changed.id,
        expected: expectedByIssue.get(changed.id),
        current: currentByIssue.get(changed.id) || null,
        state: null
      };
    }
    const capacity = capacitySnapshot(config, states, planOptions);
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
    const reserved = reservedRunState({ repoPath, runId, mode, plan, capacity, extraState });
    const state = existingState ? Object.assign(existingState, reserved) : reserved;
    await beforePersist({ state, states, current });
    await stateSaver(repoPath, runId, state);
    return {
      reserved: true,
      capacity,
      plan,
      state,
      ...(expectedByIssue.size ? { current } : {})
    };
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
  tasksAfterOutcome = async () => [],
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
    tracked = Promise.resolve(promise).then(async (result) => {
      outcomes.push(result);
      const followUps = await tasksAfterOutcome(result);
      pending.push(...(followUps || []));
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
        let admitted = false;
        for (let index = 0; index < pending.length; index += 1) {
          const task = pending[index];
          const prepared = reserveInitial ? await reserveInitial(task) : null;
          if (prepared && !prepared.reserved) {
            if (prepared.terminal) {
              pending.splice(index, 1);
              admitted = true;
              break;
            }
            continue;
          }
          pending.splice(index, 1);
          launch(executeInitial(task, prepared));
          launched = true;
          admitted = true;
          break;
        }
        if (admitted) continue;
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

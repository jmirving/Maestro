const fs = require("node:fs/promises");
const path = require("node:path");
const { computePlan, selectReady } = require("./planner");
const { loadPersistedRunStates } = require("./run-store");
const { reportRootForRepo } = require("./reporter");
const { classifyRunIssue } = require("./run-lifecycle");
const { effectiveIssueStates } = require("./run-resolver");

async function loadExecutionStates(repoPath) {
  const states = await loadPersistedRunStates(repoPath);
  const persistedRunIds = new Set(states.map((state) => String(state.runId)));
  const activeByRun = new Map();
  let entries = [];
  try {
    entries = await fs.readdir(path.dirname(reportRootForRepo(repoPath)), { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(.+)-(\d{14}-[a-f0-9]+)$/);
    if (!match || persistedRunIds.has(match[2])) continue;
    if (!activeByRun.has(match[2])) {
      activeByRun.set(match[2], {
        runId: match[2],
        mode: "execute",
        status: "running",
        plan: { selected: [] },
        workers: [],
        validations: [],
        reviews: {}
      });
    }
    activeByRun.get(match[2]).plan.selected.push({ id: match[1] });
  }
  return [...states, ...activeByRun.values()];
}

function unresolvedWork(states, config = null) {
  const byIssue = new Map();
  for (const effective of effectiveIssueStates(config, states).values()) {
    const { issue } = effective;
    if (effective.integration) {
      if (config?.work?.[issue]?.status !== "complete") {
        byIssue.set(issue, {
          issue,
          runId: effective.integrationRunId,
          mode: null,
          state: "integrated-pending-manifest",
          action: `maestro commit --run ${effective.integrationRunId}`
        });
      }
      continue;
    }
    if (effective.consistencyConflict || !effective.current) continue;
    const { runId, state, evidence } = effective.current;
    if (evidence.state === "technical-conflict" && evidence.conflict) {
      byIssue.set(issue, {
        issue,
        runId,
        mode: state.mode,
        state: "technical-conflict",
        action: evidence.conflict.continuationAction || `maestro details ${issue}`
      });
      continue;
    }
    if (evidence.worker) {
      const worker = evidence.worker;
      const lifecycle = classifyRunIssue(state, worker);
      if (lifecycle.state !== "discarded") {
        byIssue.set(issue, { issue, runId, mode: state.mode, ...lifecycle });
      }
      continue;
    }

    const capacityIssues = state.capacity?.issues?.map(String);
    const hasActiveReservation = !capacityIssues || capacityIssues.includes(issue);
    if (evidence.selected && ((state.status === "running" && hasActiveReservation) || state.status === "failed")) {
      byIssue.set(issue, {
        issue,
        runId,
        mode: state.mode,
        state: state.status === "failed"
          ? "failed-awaiting-retry"
          : state.mode === "rework" ? "rework-running" : "running",
        action: state.status === "failed" ? "maestro start --rerun" : "maestro status"
      });
    }
  }
  return byIssue;
}

function reconcilePlan(config, states = [], planOptions = {}) {
  const plan = computePlan(config, planOptions);
  const unresolved = unresolvedWork(states, config);
  const deferred = [];
  const ready = [];

  for (const item of plan.ready) {
    const lifecycle = unresolved.get(item.id);
    if (lifecycle) deferred.push({ ...item, lifecycle });
    else ready.push(item);
  }

  const active = [...unresolved.values()].filter((item) => ["running", "rework-running"].includes(item.state));
  const availableConcurrency = Math.max(0, plan.concurrency - active.length);
  const selection = selectReady(
    ready,
    availableConcurrency,
    config.planning?.advisoryConflicts || [],
    active.map((item) => item.issue)
  );
  const activeIds = new Set(active.map((item) => String(item.issue)));
  const activeConflicts = selection.advisoryDeferred
    .filter((item) => activeIds.has(String(item.conflictsWith)))
    .map((item) => ({ ...item, lifecycle: { state: "active-conflict", action: "maestro status" } }));
  deferred.push(...activeConflicts);
  const recommendations = [...new Set(deferred.map((item) => item.lifecycle.action))];
  return {
    ...plan,
    ready,
    selected: selection.selected,
    advisoryDeferred: selection.advisoryDeferred,
    active,
    availableConcurrency,
    deferred,
    recommendations
  };
}

async function computeEffectivePlan(config, repoPath, { stateLoader = loadExecutionStates, ...planOptions } = {}) {
  return reconcilePlan(config, await stateLoader(repoPath), planOptions);
}

module.exports = { loadExecutionStates, classifyRunIssue, unresolvedWork, reconcilePlan, computeEffectivePlan };

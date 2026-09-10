const fs = require("node:fs/promises");
const path = require("node:path");
const { computePlan } = require("./planner");
const { loadPersistedRunStates } = require("./run-store");
const { reportRootForRepo } = require("./reporter");

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

function classifyRunIssue(state, worker) {
  const issue = String(worker.issue);
  const validation = (state.validations || []).find((entry) => String(entry.issue) === issue);
  const review = state.reviews?.[issue];
  const integrated = (state.integration || []).some((entry) => String(entry.issue) === issue);

  if (integrated) return { state: "integrated-pending-manifest", action: `maestro commit --run ${state.runId}` };
  if (state.status === "running") {
    return {
      state: state.mode === "rework" ? "rework-running" : "running",
      action: "maestro status"
    };
  }
  if (review?.disposition === "rework-original") {
    return { state: "awaiting-rework", action: `maestro rework --run ${state.runId}` };
  }
  if (review && validation?.verdict === "approve") {
    return { state: "awaiting-integration", action: `maestro commit --run ${state.runId}` };
  }
  if (validation?.verdict === "rework") {
    return { state: "awaiting-rework", action: `maestro rework --run ${state.runId}` };
  }
  if (validation?.verdict === "human_gate") {
    return { state: "awaiting-human-review", action: `maestro review --run ${state.runId} --issue ${issue}` };
  }
  if (validation?.verdict === "approve") {
    return { state: "awaiting-human-review", action: `maestro approve ${issue} --run ${state.runId}` };
  }
  if (worker.exitCode !== 0 || state.status === "failed") {
    return { state: "failed-awaiting-retry", action: "maestro start --rerun" };
  }
  return { state: "awaiting-validation-or-review", action: "maestro status" };
}

function unresolvedWork(states) {
  const byIssue = new Map();
  for (const state of [...states].sort((a, b) => String(a.runId).localeCompare(String(b.runId)))) {
    for (const worker of state.workers || []) {
      const issue = String(worker.issue);
      byIssue.set(issue, { issue, runId: state.runId, mode: state.mode, ...classifyRunIssue(state, worker) });
    }
    if (["running", "failed"].includes(state.status)) {
      for (const item of state.plan?.selected || []) {
        const issue = String(item.id);
        if (!(state.workers || []).some((worker) => String(worker.issue) === issue)) {
          byIssue.set(issue, {
            issue,
            runId: state.runId,
            mode: state.mode,
            state: state.status === "failed"
              ? "failed-awaiting-retry"
              : state.mode === "rework" ? "rework-running" : "running",
            action: state.status === "failed" ? "maestro start --rerun" : "maestro status"
          });
        }
      }
    }
  }
  return byIssue;
}

function reconcilePlan(config, states = []) {
  const plan = computePlan(config);
  const unresolved = unresolvedWork(states);
  const deferred = [];
  const ready = [];

  for (const item of plan.ready) {
    const lifecycle = unresolved.get(item.id);
    if (lifecycle) deferred.push({ ...item, lifecycle });
    else ready.push(item);
  }

  const active = [...unresolved.values()].filter((item) => ["running", "rework-running"].includes(item.state));
  const availableConcurrency = Math.max(0, plan.concurrency - active.length);
  const recommendations = [...new Set(deferred.map((item) => item.lifecycle.action))];
  return {
    ...plan,
    ready,
    selected: ready.slice(0, availableConcurrency),
    active,
    availableConcurrency,
    deferred,
    recommendations
  };
}

async function computeEffectivePlan(config, repoPath, { stateLoader = loadExecutionStates } = {}) {
  return reconcilePlan(config, await stateLoader(repoPath));
}

module.exports = { loadExecutionStates, classifyRunIssue, unresolvedWork, reconcilePlan, computeEffectivePlan };

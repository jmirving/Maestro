const fs = require("node:fs/promises");
const path = require("node:path");
const { computePlan } = require("./planner");
const { loadPersistedRunStates } = require("./run-store");
const { reportRootForRepo } = require("./reporter");
const { classifyRunIssue } = require("./run-lifecycle");
const { currentIssueEvidenceFromStates } = require("./run-resolver");

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
  for (const { issue, runId, state, evidence } of currentIssueEvidenceFromStates(states)) {
    if (evidence.worker) {
      const worker = evidence.worker;
      const lifecycle = classifyRunIssue(state, worker);
      if (lifecycle.state === "integrated-pending-manifest" && config?.work?.[issue]?.status === "complete") {
        byIssue.delete(issue);
        continue;
      }
      if (lifecycle.state !== "discarded") {
        byIssue.set(issue, { issue, runId, mode: state.mode, ...lifecycle });
      }
      continue;
    }

    if (evidence.selected && ["running", "failed"].includes(state.status)) {
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

function reconcilePlan(config, states = []) {
  const plan = computePlan(config);
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

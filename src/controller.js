const crypto = require("node:crypto");
const { computePlan } = require("./planner");
const { describePreflights, runPreflights } = require("./preflight");
const { prepareWorktree } = require("./worktrees");
const { executeWorker } = require("./worker");

function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

async function dryRun(config, { repoPath }) {
  const plan = computePlan(config);
  return {
    runId: newRunId(),
    mode: "dry-run",
    repoPath,
    plan,
    preflights: describePreflights(config, plan.selected)
  };
}

async function executeRun(config, { repoPath, runId = newRunId(), workerExecutor = executeWorker, worktreeFactory = prepareWorktree, preflightRunner } = {}) {
  const plan = computePlan(config);
  if (!plan.selected.length) return { runId, mode: "execute", plan, preflights: [], workers: [] };
  const preflights = await runPreflights(config, plan.selected, { cwd: repoPath, runner: preflightRunner });
  const prepared = [];
  for (const item of plan.selected) {
    prepared.push({
      item,
      worktree: await worktreeFactory({
        repoPath,
        item,
        runId,
        defaultBranch: config.defaultBranch || "main"
      })
    });
  }
  const workers = await Promise.all(prepared.map(({ item, worktree }) => workerExecutor({
    repository: config.repository,
    item,
    worktree,
    runId
  })));
  return { runId, mode: "execute", plan, preflights, workers };
}

module.exports = { newRunId, dryRun, executeRun };

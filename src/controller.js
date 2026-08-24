const crypto = require("node:crypto");
const { computePlan } = require("./planner");
const { describePreflights, runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { prepareWorktree } = require("./worktrees");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { integrateApproved } = require("./integrator");
const { saveRunState } = require("./run-store");

function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

async function dryRun(config, { repoPath }) {
  const plan = computePlan(config);
  return {
    runId: newRunId(),
    mode: "dry-run",
    repoPath,
    plan,
    baseline: {
      commands: config.baseline?.commands || config.integration?.commands || [],
      allowFailing: config.baseline?.allowFailing === true
    },
    preflights: describePreflights(config, plan.selected)
  };
}

async function executeRun(config, {
  repoPath,
  runId = newRunId(),
  workerExecutor = executeWorker,
  validatorExecutor = validateWorker,
  worktreeFactory = prepareWorktree,
  preflightRunner,
  baselineRunner,
  stateSaver = saveRunState
} = {}) {
  const plan = computePlan(config);
  if (!plan.selected.length) return { runId, mode: "execute", plan, baseline: null, preflights: [], workers: [], validations: [] };

  // Fail fast on missing runtime capabilities before spending minutes on the
  // expensive repository baseline. A missing database/browser/etc. is an
  // environment problem, not useful baseline evidence.
  console.error(`[Maestro] run ${runId}: capability preflight`);
  const preflights = await runPreflights(config, plan.selected, { cwd: repoPath, runner: preflightRunner });
  console.error(`[Maestro] run ${runId}: baseline validation`);
  const baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner });
  console.error(`[Maestro] run ${runId}: preparing ${plan.selected.length} worker(s)`);

  const prepared = [];
  for (const item of plan.selected) {
    prepared.push({
      item,
      worktree: await worktreeFactory({ repoPath, item, runId, defaultBranch: config.defaultBranch || "main" })
    });
  }

  console.error(`[Maestro] run ${runId}: workers running`);
  const workers = await Promise.all(prepared.map(({ item, worktree }) => workerExecutor({
    repository: config.repository,
    item,
    worktree,
    runId
  })));

  console.error(`[Maestro] run ${runId}: validating changed branches`);
  const validations = await Promise.all(workers
    .filter((worker) => worker.exitCode === 0 && worker.headSha !== worker.baseSha)
    .map((worker) => validatorExecutor({ repository: config.repository, worker, baseline, runId })));

  const result = { runId, mode: "execute", repoPath, plan, baseline, preflights, workers, validations, reviews: {} };
  await stateSaver(repoPath, runId, result);
  console.error(`[Maestro] run ${runId}: complete`);
  return result;
}

async function executeAndIntegrate(config, options = {}) {
  const result = await executeRun(config, options);
  const blockedValidation = result.validations.find((entry) => entry.verdict !== "approve");
  if (blockedValidation) return { ...result, integration: [], stopped: `validation-${blockedValidation.verdict}` };
  if (result.workers.some((worker) => worker.exitCode !== 0)) return { ...result, integration: [], stopped: "worker-failure" };
  const integration = await integrateApproved({
    config,
    repoPath: options.repoPath,
    workers: result.workers,
    validations: result.validations
  });
  return { ...result, integration };
}

async function continuousRun(config, { repoPath, maxCycles = 20 } = {}) {
  const runtime = cloneConfig(config);
  const cycles = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const plan = computePlan(runtime);
    if (!plan.selected.length) {
      return { mode: "continuous", cycles, finalPlan: plan, stopped: plan.humanGates.length ? "human-gate" : "no-ready-work" };
    }
    const result = await executeAndIntegrate(runtime, { repoPath });
    cycles.push(result);
    if (result.stopped) return { mode: "continuous", cycles, finalPlan: computePlan(runtime), stopped: result.stopped };
    if (!result.integration.length) return { mode: "continuous", cycles, finalPlan: computePlan(runtime), stopped: "nothing-integrated" };
    for (const integrated of result.integration) {
      if (runtime.work?.[integrated.issue]) runtime.work[integrated.issue].status = "complete";
    }
  }
  return { mode: "continuous", cycles, finalPlan: computePlan(runtime), stopped: "max-cycles" };
}

module.exports = { newRunId, dryRun, executeRun, executeAndIntegrate, continuousRun };

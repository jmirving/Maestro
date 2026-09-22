const crypto = require("node:crypto");
const { computePlan } = require("./planner");
const { describePreflights, runPreflights } = require("./preflight");
const { captureBaseline } = require("./baseline");
const { prepareWorktree } = require("./worktrees");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { saveRunState } = require("./run-store");
const { commitLifecycleTransition } = require("./lifecycle-coordination");
const { bindValidation, createDelegatedAuthorization, saveAuthorization, resolveExplicitIssueScope } = require("./authorization");
const { integrateExistingRun } = require("./existing-run");

function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function upsertIssueEvidence(entries = [], replacement) {
  if (!replacement) return entries;
  return [
    ...entries.filter((entry) => String(entry.issue) !== String(replacement.issue)),
    replacement
  ];
}

async function dryRun(config, { repoPath, planOptions = {}, concurrency } = {}) {
  const plan = computePlan(config, { ...planOptions, ...(concurrency ? { concurrency } : {}) });
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
  plan = null,
  concurrency,
  workerExecutor = executeWorker,
  validatorExecutor = validateWorker,
  worktreeFactory = prepareWorktree,
  preflightRunner,
  baselineRunner,
  stateSaver = saveRunState,
  scope = null,
  authorization = null,
  reservedState = null,
  onIssueSettled = async () => {}
} = {}) {
  plan = plan || computePlan(config, { concurrency });
  if (!plan.selected.length) {
    const empty = { runId, mode: "execute", status: "no-ready-work", plan, baseline: null, preflights: [], workers: [], validations: [], reviews: {}, ...(scope ? { scope } : {}), ...(authorization ? { authorization } : {}) };
    if (scope) await stateSaver(repoPath, runId, empty);
    return empty;
  }

  const result = reservedState || {
    runId,
    mode: "execute",
    status: "running",
    repoPath,
    plan,
    baseline: null,
    preflights: [],
    workers: [],
    validations: [],
    reviews: {}
  };
  if (scope) result.scope = scope;
  if (authorization) result.authorization = authorization;
  if (!reservedState || scope) await stateSaver(repoPath, runId, result);
  let sourceSettled = false;

  async function persistLifecycle(issueIds, mutate) {
    if (stateSaver !== saveRunState) {
      await stateSaver(repoPath, runId, result);
      return result;
    }
    return commitLifecycleTransition({ repoPath, runId, issueIds, mutate });
  }

  try {
    // Fail fast on missing runtime capabilities before spending minutes on the
    // expensive repository baseline. A missing database/browser/etc. is an
    // environment problem, not useful baseline evidence.
    console.error(`[Maestro] run ${runId}: capability preflight`);
    result.preflights = await runPreflights(config, plan.selected, { cwd: repoPath, runner: preflightRunner });
    console.error(`[Maestro] run ${runId}: baseline validation`);
    result.baseline = await captureBaseline(config, { cwd: repoPath, runner: baselineRunner });
    console.error(`[Maestro] run ${runId}: preparing ${plan.selected.length} worker(s)`);

    console.error(`[Maestro] run ${runId}: workers running`);
    const settlementErrors = [];
    const settled = await Promise.allSettled(plan.selected.map(async (item) => {
      const issue = String(item.id);
      try {
        const worktree = await worktreeFactory({ repoPath, item, runId, defaultBranch: config.defaultBranch || "main" });
        const worker = await workerExecutor({ repository: config.repository, item, worktree, runId });
        result.workers.push(worker);
        if (worker.exitCode === 0 && worker.headSha !== worker.baseSha) {
          console.error(`[Maestro] run ${runId}: validating changed branch for #${issue}`);
          const validation = await validatorExecutor({ repository: config.repository, worker, baseline: result.baseline, runId });
          result.validations.push(bindValidation(config, worker, validation, { scopeRevision: result.authorization?.scope?.revision }));
        }
      } catch (error) {
        if (!result.workers.some((worker) => String(worker.issue) === issue)) {
          result.workers.push({ issue, exitCode: 1, report: error.message, infrastructureFailure: true });
        }
        throw error;
      } finally {
        const hasPerIssueReservations = Boolean(result.capacity?.issues);
        if (result.capacity?.issues) {
          result.capacity.issues = result.capacity.issues.filter((id) => String(id) !== issue);
        }
        if (hasPerIssueReservations) {
          const worker = result.workers.find((entry) => String(entry.issue) === issue);
          const validation = result.validations.find((entry) => String(entry.issue) === issue);
          await persistLifecycle([issue], (current) => {
            current.baseline = result.baseline;
            current.preflights = result.preflights;
            current.workers = upsertIssueEvidence(current.workers, worker);
            current.validations = upsertIssueEvidence(current.validations, validation);
            if (current.capacity?.issues) {
              current.capacity.issues = current.capacity.issues.filter((id) => String(id) !== issue);
            }
            return current;
          });
        }
        try {
          await onIssueSettled({ issue, result });
        } catch (error) {
          settlementErrors.push(error);
        }
      }
    }));
    const rejected = settled.find((entry) => entry.status === "rejected");
    if (rejected) throw rejected.reason;

    result.status = "awaiting-review";
    await persistLifecycle(plan.selected.map((item) => item.id), (current) => {
      current.status = "awaiting-review";
      current.baseline = result.baseline;
      current.preflights = result.preflights;
      current.workers = result.workers;
      current.validations = result.validations;
      if (current.capacity?.issues) current.capacity.issues = [];
      return current;
    });
    sourceSettled = true;
    console.error(`[Maestro] run ${runId}: complete`);
    if (settlementErrors.length === 1) throw settlementErrors[0];
    if (settlementErrors.length > 1) {
      throw new AggregateError(settlementErrors, `${settlementErrors.length} lifecycle backfill operations failed.`);
    }
    return result;
  } catch (error) {
    if (sourceSettled) throw error;
    result.status = "failed";
    result.failure = error.message;
    await persistLifecycle(plan.selected.map((item) => item.id), (current) => {
      current.status = "failed";
      current.failure = error.message;
      current.baseline = result.baseline;
      current.preflights = result.preflights;
      current.workers = result.workers;
      current.validations = result.validations;
      if (current.capacity?.issues) current.capacity.issues = [];
      return current;
    });
    throw error;
  }
}

async function executeAndIntegrate(config, options = {}) {
  if (options.delegate !== true) {
    throw new Error("Execute-and-integrate requires explicit delegated authorization. Use --delegate; validator approval alone is not integration authority.");
  }
  const runId = options.runId || newRunId();
  const plan = options.plan || computePlan(config, { concurrency: options.concurrency });
  if (!plan.selected.length) return executeRun(config, { ...options, runId, plan });
  const explicitScope = await (options.explicitScopeResolver || resolveExplicitIssueScope)({
    config,
    repoPath: options.repoPath,
    issueIds: plan.selected.map((item) => String(item.id))
  });
  const authorization = createDelegatedAuthorization({
    config,
    repoPath: options.repoPath,
    runId,
    issueIds: plan.selected.map((item) => String(item.id)),
    scope: { revision: explicitScope.revision },
    limits: {
      concurrency: plan.concurrency,
      correction: { enabled: false, retryLimit: 0, deadlineMs: 0 }
    }
  });
  await saveAuthorization(options.repoPath, authorization);
  const result = await executeRun(config, { ...options, runId, plan, scope: options.scope || null, authorization, reservedState: options.reservedState ? { ...options.reservedState, authorization } : null });
  if (!options.reservedState) {
    result.authorization = authorization;
    await (options.stateSaver || saveRunState)(options.repoPath, runId, result);
  }
  if (result.workers.some((worker) => worker.exitCode !== 0)) return { ...result, integration: [], stopped: "worker-failure" };
  const integrated = await integrateExistingRun(config, { repoPath: options.repoPath, manifestPath: options.manifestPath || null, runId });
  const blockedValidation = result.validations.find((entry) => entry.verdict !== "approve");
  return { ...result, integration: integrated.integration || [], ...(blockedValidation ? { stopped: `validation-${blockedValidation.verdict}` } : {}) };
}

async function continuousRun(config, { repoPath, maxCycles = 20, concurrency, delegate = false } = {}) {
  const runtime = cloneConfig(config);
  const cycles = [];
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const plan = computePlan(runtime, { concurrency });
    if (!plan.selected.length) {
      return { mode: "continuous", cycles, finalPlan: plan, stopped: plan.humanGates.length ? "human-gate" : "no-ready-work" };
    }
    const result = await executeAndIntegrate(runtime, { repoPath, concurrency, delegate });
    cycles.push(result);
    if (result.stopped) return { mode: "continuous", cycles, finalPlan: computePlan(runtime, { concurrency }), stopped: result.stopped };
    if (!result.integration.length) return { mode: "continuous", cycles, finalPlan: computePlan(runtime, { concurrency }), stopped: "nothing-integrated" };
    for (const integrated of result.integration) {
      if (runtime.work?.[integrated.issue]) runtime.work[integrated.issue].status = "complete";
    }
  }
  return { mode: "continuous", cycles, finalPlan: computePlan(runtime, { concurrency }), stopped: "max-cycles" };
}

module.exports = { newRunId, dryRun, executeRun, executeAndIntegrate, continuousRun };

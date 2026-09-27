const test = require("node:test");
const assert = require("node:assert/strict");
const { executeRun } = require("../src/controller");
const { resolveConcurrency } = require("../src/concurrency");

const config = {
  repository: "example/repo",
  defaultConcurrency: 2,
  capabilities: { node: { preflight: "node --version" } },
  work: {
    "1": { status: "ready", requires: ["node"] },
    "2": { status: "ready", requires: ["node"] },
    "3": { status: "ready", blockedBy: ["1"] }
  }
};

test("executeRun preflights once, creates isolated worktrees, runs workers, validates changed branches, and persists the run", async () => {
  const preflightCalls = [];
  const worktreeCalls = [];
  const workerCalls = [];
  const validatorCalls = [];
  const saved = [];
  const result = await executeRun(config, {
    repoPath: "/target",
    runId: "run-1",
    concurrency: resolveConcurrency({ override: 2, savedDefault: config.defaultConcurrency }),
    preflightRunner: async (command, options) => {
      preflightCalls.push({ command, options });
      return { code: 0, stdout: "ok", stderr: "" };
    },
    worktreeFactory: async ({ item }) => {
      worktreeCalls.push(item.id);
      return { baseSha: "base", branch: `maestro/${item.id}`, worktreePath: `/wt/${item.id}` };
    },
    workerExecutor: async ({ item, worktree }) => {
      workerCalls.push({ id: item.id, path: worktree.worktreePath });
      return {
        issue: item.id,
        exitCode: 0,
        baseSha: worktree.baseSha,
        headSha: `head-${item.id}`,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        report: "complete"
      };
    },
    validatorExecutor: async ({ worker }) => {
      validatorCalls.push(worker.issue);
      return { issue: worker.issue, exitCode: 0, verdict: "approve" };
    },
    stateSaver: async (repoPath, runId, state) => saved.push({ repoPath, runId, state: structuredClone(state) })
  });

  assert.equal(preflightCalls.length, 1);
  assert.deepEqual(worktreeCalls, ["1", "2"]);
  assert.deepEqual(workerCalls.map((entry) => entry.id), ["1", "2"]);
  assert.deepEqual(validatorCalls, ["1", "2"]);
  assert.deepEqual(result.workers.map((entry) => entry.headSha), ["head-1", "head-2"]);
  assert.deepEqual(result.validations.map((entry) => entry.verdict), ["approve", "approve"]);
  assert.ok(saved.length >= 2);
  assert.equal(saved[0].runId, "run-1");
  assert.equal(saved[0].state.status, "running");
  assert.equal(saved[0].state.plan.concurrency, 2);
  assert.equal(saved[0].state.plan.concurrencySource, "this invocation");
  assert.equal(saved[0].state.plan.savedDefaultConcurrency, 2);
  assert.deepEqual(saved[0].state.workers, []);
  assert.equal(saved.at(-1).state.status, "awaiting-review");
  assert.deepEqual(saved.at(-1).state.reviews, {});
});

test("executeRun independently validates an explicit no-change claim without requiring a fake commit", async () => {
  let validatorWorker = null;
  const result = await executeRun({ repository: "example/repo", work: { "1": { status: "ready" } } }, {
    repoPath: "/target",
    runId: "run-no-change",
    plan: { selected: [{ id: "1", requires: [] }] },
    preflightRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
    baselineRunner: async () => ({ enabled: false, commands: [], results: [], passing: true }),
    worktreeFactory: async () => ({ baseSha: "already-there", branch: "maestro/1", worktreePath: "/wt/1" }),
    workerExecutor: async ({ item, worktree }) => ({ issue: item.id, exitCode: 0, ...worktree, headSha: worktree.baseSha, report: "Already implemented; npm test passed." }),
    validatorExecutor: async ({ worker }) => { validatorWorker = worker; return { issue: worker.issue, exitCode: 0, verdict: "approve" }; },
    stateSaver: async () => {}
  });
  assert.equal(validatorWorker.noChange, true);
  assert.equal(result.workers[0].headSha, result.workers[0].baseSha);
  assert.equal(result.validations[0].verdict, "approve");
});

test("executeRun persists a failed lifecycle that requires an explicit retry", async () => {
  const saved = [];
  await assert.rejects(executeRun(config, {
    repoPath: "/target",
    runId: "run-failed",
    preflightRunner: async () => { throw new Error("node missing"); },
    stateSaver: async (repoPath, runId, state) => saved.push({ repoPath, runId, state: structuredClone(state) })
  }), /Required capability 'node' failed preflight/);

  assert.deepEqual(saved.map((entry) => entry.state.status), ["running", "failed"]);
  assert.match(saved[1].state.failure, /Required capability 'node' failed preflight/);
});

test("executeRun resumes an interrupted validation from persisted worker evidence without rerunning the worker", async () => {
  let workerCalls = 0;
  let validations = 0;
  const state = {
    runId: "resume-validation", mode: "autonomous", status: "running", repoPath: "/target",
    plan: { selected: [{ id: "1", requires: [] }] }, baseline: { enabled: false }, preflights: [],
    workers: [{ issue: "1", exitCode: 0, baseSha: "base", headSha: "head", branch: "b-1", worktreePath: "/wt/1" }],
    validations: [], reviews: {}, capacity: { issues: ["1"] },
    operations: { "1": { stage: "validation", worktree: { baseSha: "base", branch: "b-1", worktreePath: "/wt/1" } } }
  };
  const result = await executeRun({ repository: "example/repo", work: { "1": { status: "ready" } } }, {
    repoPath: "/target", runId: state.runId, plan: state.plan, reservedState: state,
    preflightRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
    baselineRunner: async () => ({ enabled: false }),
    workerExecutor: async () => { workerCalls += 1; throw new Error("must not rerun worker"); },
    validatorExecutor: async ({ worker }) => { validations += 1; return { issue: worker.issue, exitCode: 0, verdict: "approve" }; },
    stateSaver: async () => {}
  });
  assert.equal(workerCalls, 0);
  assert.equal(validations, 1);
  assert.equal(result.validations[0].verdict, "approve");
});

test("executeRun persists reliable process identity for active workers and validators", async () => {
  const saved = [];
  const result = await executeRun({ repository: "example/repo", work: { "1": { status: "ready" } } }, {
    repoPath: "/target",
    runId: "process-identity",
    plan: { selected: [{ id: "1", requires: [] }] },
    preflightRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
    baselineRunner: async () => ({ enabled: false }),
    processIdentity: async (pid) => `boot-a:${pid === 101 ? "worker-start" : "validator-start"}`,
    worktreeFactory: async () => ({ baseSha: "base", branch: "b-1", worktreePath: "/wt/1" }),
    workerExecutor: async ({ item, worktree, onProcessStart }) => {
      await onProcessStart(101);
      return { issue: item.id, exitCode: 0, ...worktree, headSha: "head" };
    },
    validatorExecutor: async ({ worker, onProcessStart }) => {
      await onProcessStart(202);
      return { issue: worker.issue, exitCode: 0, verdict: "approve" };
    },
    stateSaver: async (_repoPath, _runId, state) => saved.push(structuredClone(state))
  });

  const workerActive = saved.find((state) => state.operations?.["1"]?.stage === "worker" && state.operations["1"].processId === 101);
  const validatorActive = saved.find((state) => state.operations?.["1"]?.stage === "validation" && state.operations["1"].processId === 202);
  assert.equal(workerActive.operations["1"].processStartTime, "boot-a:worker-start");
  assert.equal(validatorActive.operations["1"].processStartTime, "boot-a:validator-start");
  assert.equal(result.operations["1"].stage, "complete");
  assert.equal(result.operations["1"].processStartTime, "boot-a:validator-start");
});

test("executeRun continues an interrupted worker in its retained worktree without allocating a duplicate", async () => {
  let factories = 0;
  let mode;
  const state = {
    runId: "resume-worker", mode: "autonomous", status: "running", repoPath: "/target",
    plan: { selected: [{ id: "1", requires: [] }] }, baseline: { enabled: false }, preflights: [],
    workers: [], validations: [], reviews: {}, capacity: { issues: ["1"] },
    operations: { "1": { stage: "worker", resumedAt: new Date().toISOString(), worktree: { baseSha: "base", branch: "b-1", worktreePath: "/wt/1" } } }
  };
  const result = await executeRun({ repository: "example/repo", work: { "1": { status: "ready" } } }, {
    repoPath: "/target", runId: state.runId, plan: state.plan, reservedState: state,
    preflightRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
    baselineRunner: async () => ({ enabled: false }),
    worktreeFactory: async () => { factories += 1; throw new Error("must not allocate"); },
    workerExecutor: async ({ item, worktree }) => {
      mode = item.mode;
      return { issue: "1", exitCode: 0, baseSha: worktree.baseSha, headSha: "head", branch: worktree.branch, worktreePath: worktree.worktreePath };
    },
    validatorExecutor: async () => ({ issue: "1", exitCode: 0, verdict: "approve" }),
    stateSaver: async () => {}
  });
  assert.equal(factories, 0);
  assert.equal(mode, "resume");
  assert.equal(result.status, "awaiting-review");
});

test("executeRun releases each persisted issue reservation when its validator settles", async () => {
  const saved = [];
  let releaseSecond;
  const second = new Promise((resolve) => { releaseSecond = resolve; });
  const run = executeRun(config, {
    repoPath: "/target",
    runId: "run-reserved",
    plan: { selected: [{ id: "1", requires: ["node"] }, { id: "2", requires: ["node"] }] },
    reservedState: {
      runId: "run-reserved", mode: "execute", status: "running", repoPath: "/target",
      plan: { selected: [{ id: "1" }, { id: "2" }] }, baseline: null, preflights: [], workers: [], validations: [], reviews: {},
      capacity: { scope: "repository", limit: 2, issues: ["1", "2"] }
    },
    preflightRunner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    baselineRunner: async () => ({ ok: true }),
    worktreeFactory: async ({ item }) => ({ baseSha: "base", branch: `b-${item.id}`, worktreePath: `/wt/${item.id}` }),
    workerExecutor: async ({ item, worktree }) => {
      if (item.id === "2") await second;
      return { issue: item.id, exitCode: 0, ...worktree, headSha: `head-${item.id}` };
    },
    validatorExecutor: async ({ worker }) => ({ issue: worker.issue, exitCode: 0, verdict: "approve" }),
    stateSaver: async (repoPath, runId, state) => saved.push(structuredClone(state))
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(saved.some((state) => state.capacity.issues.length === 1 && state.capacity.issues[0] === "2"));
  releaseSecond();
  const result = await run;
  assert.deepEqual(result.capacity.issues, []);
});

test("a failed lifecycle backfill does not invalidate successful source evidence", async () => {
  const saved = new Map();
  const stateSaver = async (repoPath, runId, state) => saved.set(runId, structuredClone(state));
  const executionOptions = {
    repoPath: "/target",
    preflightRunner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    baselineRunner: async () => ({ ok: true }),
    worktreeFactory: async ({ item }) => ({ baseSha: "base", branch: `b-${item.id}`, worktreePath: `/wt/${item.id}` }),
    validatorExecutor: async ({ worker }) => ({ issue: worker.issue, exitCode: 0, verdict: "approve" }),
    stateSaver
  };

  await assert.rejects(executeRun(config, {
    ...executionOptions,
    runId: "source-run",
    plan: { selected: [{ id: "1", requires: ["node"] }] },
    workerExecutor: async ({ item, worktree }) => ({
      issue: item.id,
      exitCode: 0,
      ...worktree,
      headSha: "source-head",
      report: "source complete"
    }),
    onIssueSettled: async () => executeRun(config, {
      ...executionOptions,
      runId: "backfill-run",
      plan: { selected: [{ id: "2", requires: ["node"] }] },
      workerExecutor: async () => { throw new Error("backfill failed"); }
    })
  }), /backfill failed/);

  const source = saved.get("source-run");
  assert.equal(source.status, "awaiting-review");
  assert.equal(source.failure, undefined);
  assert.equal(source.workers[0].report, "source complete");
  assert.equal(source.validations[0].verdict, "approve");

  const backfill = saved.get("backfill-run");
  assert.equal(backfill.status, "failed");
  assert.equal(backfill.failure, "backfill failed");
});

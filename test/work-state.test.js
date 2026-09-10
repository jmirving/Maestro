const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { computePlan } = require("../src/planner");
const { saveRunState } = require("../src/run-store");
const { reportRootForRepo } = require("../src/reporter");
const { reconcilePlan, computeEffectivePlan } = require("../src/work-state");

function config(work, defaultConcurrency = 4) {
  return { repository: "example/repo", defaultConcurrency, work };
}

function worker(issue, exitCode = 0) {
  return { issue: String(issue), exitCode, baseSha: "base", headSha: `head-${issue}` };
}

test("mixed validator, review, and integration outcomes are deferred with actions", () => {
  const manifest = config({
    "2": { status: "ready" },
    "5": { status: "ready" },
    "7": { status: "ready" },
    "12": { status: "ready" },
    "20": { status: "ready" }
  });
  const states = [{
    runId: "20260910010101-aaaaaa",
    mode: "execute",
    workers: [worker(2), worker(5), worker(7), worker(12)],
    validations: [
      { issue: "2", verdict: "approve" },
      { issue: "5", verdict: "approve" },
      { issue: "7", verdict: "rework" },
      { issue: "12", verdict: "approve" }
    ],
    reviews: { "5": { disposition: "approve" }, "12": { disposition: "approve" } },
    integration: [{ issue: "12", integratedSha: "integrated" }]
  }];

  const plan = reconcilePlan(manifest, states);
  assert.deepEqual(plan.selected.map((item) => item.id), ["20"]);
  assert.deepEqual(plan.deferred.map((item) => [item.id, item.lifecycle.state]), [
    ["2", "awaiting-human-review"],
    ["5", "awaiting-integration"],
    ["7", "awaiting-rework"],
    ["12", "integrated-pending-manifest"]
  ]);
  assert.ok(plan.recommendations.includes("maestro approve 2 --run 20260910010101-aaaaaa"));
  assert.ok(plan.recommendations.includes("maestro rework --run 20260910010101-aaaaaa"));
  assert.ok(plan.recommendations.includes("maestro commit --run 20260910010101-aaaaaa"));
});

test("an active rework child supersedes the source rework recommendation", () => {
  const manifest = config({ "7": { status: "ready" } });
  const plan = reconcilePlan(manifest, [
    {
      runId: "20260910010101-aaaaaa",
      mode: "execute",
      workers: [worker(7)],
      validations: [{ issue: "7", verdict: "rework" }],
      reviews: {}
    },
    {
      runId: "20260910020202-bbbbbb",
      parentRunId: "20260910010101-aaaaaa",
      mode: "rework",
      status: "running",
      plan: { selected: [{ id: "7" }] },
      workers: [],
      validations: [],
      reviews: {}
    }
  ]);

  assert.equal(plan.selected.length, 0);
  assert.equal(plan.deferred[0].lifecycle.state, "rework-running");
  assert.deepEqual(plan.recommendations, ["maestro status"]);
});

test("persisted lifecycle blocks repeated next plans and completion unlocks dependents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-work-state-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const manifest = config({
    "2": { status: "ready" },
    "3": { status: "ready", blockedBy: ["2"] }
  });
  await saveRunState(repoPath, "20260910030303-cccccc", {
    runId: "20260910030303-cccccc",
    mode: "execute",
    status: "awaiting-review",
    workers: [worker(2)],
    validations: [{ issue: "2", verdict: "approve" }],
    reviews: {}
  });

  const first = await computeEffectivePlan(manifest, repoPath);
  const repeated = await computeEffectivePlan(manifest, repoPath);
  assert.equal(first.selected.length, 0);
  assert.deepEqual(repeated, first);
  assert.equal(first.deferred[0].id, "2");

  manifest.work["2"].status = "complete";
  const advanced = await computeEffectivePlan(manifest, repoPath);
  assert.deepEqual(advanced.selected.map((item) => item.id), ["3"]);
});

test("an isolated worktree blocks duplicate execution before a run state is complete", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-active-worktree-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const worktreeRoot = path.dirname(reportRootForRepo(repoPath));
  await fs.mkdir(path.join(worktreeRoot, "14-20260910050505-eeeeee"), { recursive: true });
  const plan = await computeEffectivePlan(config({
    "14": { status: "ready" },
    "15": { status: "ready" }
  }, 1), repoPath);

  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.ready.map((item) => item.id), ["15"]);
  assert.equal(plan.availableConcurrency, 0);
  assert.equal(plan.deferred[0].id, "14");
  assert.equal(plan.deferred[0].lifecycle.state, "running");
});

test("intentional rerun remains an explicit manifest-only bypass", () => {
  const manifest = config({ "2": { status: "ready" } });
  const states = [{
    runId: "20260910040404-dddddd",
    workers: [worker(2)],
    validations: [{ issue: "2", verdict: "approve" }],
    reviews: {}
  }];

  assert.equal(reconcilePlan(manifest, states).selected.length, 0);
  assert.deepEqual(computePlan(manifest).selected.map((item) => item.id), ["2"]);
});

test("repeated maestro next invocations do not execute a persisted item again", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-next-lifecycle-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(manifestPath, `${JSON.stringify(config({ "2": { status: "ready" } }))}\n`);
  await saveRunState(repoPath, "20260910060606-ffffff", {
    runId: "20260910060606-ffffff",
    mode: "execute",
    status: "awaiting-review",
    workers: [worker(2)],
    validations: [{ issue: "2", verdict: "approve" }],
    reviews: {}
  });

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const invoke = () => spawnSync(process.execPath, [cli, "next", manifestPath, "--repo-path", repoPath], { encoding: "utf8" });
  const first = invoke();
  const repeated = invoke();

  assert.equal(first.status, 0, first.stderr);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(first.stdout).plan.selected, []);
  assert.deepEqual(JSON.parse(repeated.stdout).plan.selected, []);
  assert.match(first.stdout, /maestro approve 2 --run 20260910060606-ffffff/);
});

test("legacy reports defer work after their disposable worktree is removed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-legacy-reports-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  const reportRoot = reportRootForRepo(repoPath);
  const runId = "20260910070707-aaaaaa";
  await fs.mkdir(repoPath);
  await fs.mkdir(reportRoot, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(manifestPath, `${JSON.stringify(config({ "14": { status: "ready" } }))}\n`);
  await fs.writeFile(path.join(reportRoot, `worker-14-${runId}.md`), "Result: complete\n");
  await fs.writeFile(path.join(reportRoot, `validator-14-${runId}.md`), "VERDICT: APPROVE\n");

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const invoke = (command) => spawnSync(
    process.execPath,
    [cli, command, manifestPath, "--repo-path", repoPath],
    { encoding: "utf8" }
  );
  const status = invoke("status");
  const first = invoke("next");
  const repeated = invoke("next");

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /IN FLIGHT\s+#14 \(awaiting-human-review\)/);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(first.stdout).plan.selected, []);
  assert.deepEqual(JSON.parse(repeated.stdout).plan.selected, []);
});

test("a HUMAN_GATE recommendation is an executable review resolution", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-human-gate-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  const runId = "20260910080808-bbbbbb";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(manifestPath, `${JSON.stringify(config({ "14": { status: "ready" } }))}\n`);
  await saveRunState(repoPath, runId, {
    runId,
    mode: "execute",
    status: "awaiting-review",
    workers: [worker(14)],
    validations: [{ issue: "14", verdict: "human_gate" }],
    reviews: {}
  });

  const plan = await computeEffectivePlan(config({ "14": { status: "ready" } }), repoPath);
  const recommendation = plan.recommendations[0];
  assert.equal(
    recommendation,
    `maestro review --run ${runId} --issue 14 --disposition rework-original`
  );

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const args = recommendation.split(" ").slice(1);
  const resolved = spawnSync(
    process.execPath,
    [cli, ...args, "--repo-path", repoPath],
    { encoding: "utf8" }
  );
  assert.equal(resolved.status, 0, resolved.stderr);

  const after = await computeEffectivePlan(config({ "14": { status: "ready" } }), repoPath);
  assert.equal(after.deferred[0].lifecycle.state, "awaiting-rework");
  assert.deepEqual(after.recommendations, [`maestro rework --run ${runId}`]);
});

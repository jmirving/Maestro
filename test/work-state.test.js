const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { computePlan } = require("../src/planner");
const { saveRunState, loadPersistedRunStates } = require("../src/run-store");

function parseLeadingJson(stdout) {
  return JSON.parse(stdout.split("\n\nIssue #", 1)[0]);
}
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
  assert.ok(plan.recommendations.includes("maestro rework 7"));
  assert.ok(plan.recommendations.includes("maestro commit --run 20260910010101-aaaaaa"));
});

test("persisted integration evidence is resolved once the manifest records completion", () => {
  const state = {
    runId: "20260910010101-aaaaaa",
    mode: "execute",
    workers: [worker(12)],
    validations: [{ issue: "12", verdict: "approve" }],
    reviews: { "12": { disposition: "approve" } },
    integration: [{ issue: "12", integratedSha: "integrated" }]
  };

  const pending = reconcilePlan(config({ "12": { status: "ready" } }), [state]);
  assert.equal(pending.deferred[0].lifecycle.state, "integrated-pending-manifest");

  const completed = reconcilePlan(config({ "12": { status: "complete" } }), [state]);
  assert.deepEqual(completed.deferred, []);
  assert.deepEqual(completed.recommendations, []);
});

test("recorded integration remains terminal when a newer stale run exists", () => {
  const integrated = {
    runId: "20260910010101-aaaaaa",
    mode: "execute",
    workers: [worker(12)],
    validations: [{ issue: "12", verdict: "approve" }],
    reviews: { "12": { disposition: "approve" } },
    integration: [{ issue: "12", integratedSha: "integrated" }]
  };
  const stale = {
    runId: "20260910020202-bbbbbb",
    mode: "execute",
    workers: [worker(12)],
    validations: [{ issue: "12", verdict: "approve" }],
    reviews: { "12": { disposition: "approve" } },
    integration: []
  };

  const plan = reconcilePlan(config({ "12": { status: "complete" } }), [integrated, stale]);
  assert.deepEqual(plan.deferred, []);
  assert.deepEqual(plan.recommendations, []);
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

test("a correction reservation and its still-running original sibling consume separate slots", () => {
  const manifest = config({
    "1": { status: "ready" },
    "2": { status: "ready" },
    "3": { status: "ready" }
  }, 2);
  const sourceRunId = "20260910010101-aaaaaa";
  const correctionRunId = "20260910010102-bbbbbb";
  const plan = reconcilePlan(manifest, [
    {
      runId: sourceRunId,
      mode: "execute",
      status: "running",
      plan: { selected: [{ id: "1" }, { id: "2" }] },
      capacity: { limit: 2, issues: ["2"] },
      workers: [worker(1)],
      validations: [{ issue: "1", verdict: "rework" }],
      reviews: {}
    },
    {
      runId: correctionRunId,
      parentRunId: sourceRunId,
      mode: "rework",
      status: "running",
      plan: { selected: [{ id: "1" }] },
      capacity: { limit: 2, issues: ["1"] },
      workers: [],
      validations: [],
      reviews: {}
    }
  ]);

  assert.deepEqual(plan.active.map((entry) => [entry.issue, entry.runId]).sort(), [
    ["1", correctionRunId],
    ["2", sourceRunId]
  ]);
  assert.equal(plan.availableConcurrency, 0);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.deferred.some((entry) => entry.id === "3"), false);
});

test("effective planning keeps new work advisory-separated from active work", () => {
  const manifest = {
    ...config({ "1": { status: "ready" }, "2": { status: "ready" }, "3": { status: "ready" } }, 2),
    planning: {
      advisoryConflicts: [{ issues: ["1", "2"], confidence: "high", source: "test", reason: "shared files", analyzer: "test" }]
    }
  };
  const plan = reconcilePlan(manifest, [{
    runId: "20260910010101-active",
    mode: "execute",
    status: "running",
    plan: { selected: [{ id: "1" }] },
    workers: [],
    validations: [],
    reviews: {}
  }]);

  assert.deepEqual(plan.active.map((item) => item.issue), ["1"]);
  assert.deepEqual(plan.selected.map((item) => item.id), ["3"]);
  assert.deepEqual(plan.advisoryDeferred.map((item) => item.id), ["2"]);
});

test("next --auto-rework preserves a lexically lower same-second running child and its capacity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-running-lineage-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  const parentRunId = "20260910010101-ffffff";
  const childRunId = "20260910010101-000001";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(manifestPath, `${JSON.stringify(config({
    "7": { status: "ready" },
    "8": { status: "ready" }
  }, 1))}\n`);
  await saveRunState(repoPath, parentRunId, {
    runId: parentRunId,
    mode: "execute",
    status: "awaiting-review",
    plan: { selected: [{ id: "7" }] },
    workers: [worker(7)],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: {}
  });
  await saveRunState(repoPath, childRunId, {
    runId: childRunId,
    parentRunId,
    mode: "rework",
    status: "running",
    plan: { selected: [{ id: "7" }] },
    workers: [],
    validations: [],
    reviews: {}
  });
  const before = await loadPersistedRunStates(repoPath);

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "../bin/maestro.js"),
    "next",
    manifestPath,
    "--auto-rework",
    "--repo-path",
    repoPath
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const output = parseLeadingJson(result.stdout);
  assert.deepEqual(output.plan.selected, []);
  assert.equal(output.plan.availableConcurrency, 0);
  assert.deepEqual(output.plan.active.map(({ issue, runId, state }) => ({ issue, runId, state })), [{
    issue: "7",
    runId: childRunId,
    state: "rework-running"
  }]);
  assert.deepEqual(output.autoRework.issues, []);
  assert.deepEqual(await loadPersistedRunStates(repoPath), before);
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
  assert.deepEqual(parseLeadingJson(first.stdout).plan.selected, []);
  assert.deepEqual(parseLeadingJson(repeated.stdout).plan.selected, []);
  assert.match(first.stdout, /Recommended: `maestro approve 2`/);
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
  assert.match(status.stdout, /Awaiting human approval \(1\)[\s\S]*#14 - validator approved, awaiting human approval/);
  assert.match(status.stdout, /Recommended: `maestro approve 14`/);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(parseLeadingJson(first.stdout).plan.selected, []);
  assert.deepEqual(parseLeadingJson(repeated.stdout).plan.selected, []);
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
  assert.deepEqual(after.recommendations, ["maestro rework 14"]);
});

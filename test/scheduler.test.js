const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadPersistedRunStates, saveRunState } = require("../src/run-store");
const { reportRootForRepo } = require("../src/reporter");
const {
  capacitySnapshot,
  reserveReadyWork,
  reserveExplicitWork,
  capacityBatches,
  runCapacityPool,
  runLifecycleBackfill
} = require("../src/scheduler");

function config(work, concurrency = 2, conflicts = []) {
  return {
    repository: "example/repo",
    defaultConcurrency: concurrency,
    work,
    planning: { advisoryConflicts: conflicts }
  };
}

async function tempRepo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-capacity-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, repoPath };
}

test("atomic repository reservations cannot duplicate work or oversubscribe capacity", async (t) => {
  const { repoPath } = await tempRepo(t);
  const manifest = config({
    "1": { status: "ready", priority: 1 },
    "2": { status: "ready", priority: 2 },
    "3": { status: "ready", priority: 3 }
  });

  const reservations = await Promise.all([
    reserveReadyWork(manifest, { repoPath, runId: "20260912010101-aaaaaa" }),
    reserveReadyWork(manifest, { repoPath, runId: "20260912010102-bbbbbb" })
  ]);
  const issues = reservations.flatMap((entry) => entry.state?.capacity.issues || []);
  assert.equal(new Set(issues).size, issues.length);
  assert.equal(issues.length, 2);

  const states = await loadPersistedRunStates(repoPath);
  const snapshot = capacitySnapshot(manifest, states);
  assert.equal(snapshot.used, 2);
  assert.equal(snapshot.available, 0);
  assert.equal(snapshot.idle.kind, "exhausted");
});

test("the first active invocation owns the aggregate limit until its session drains", () => {
  const states = [{
    runId: "20260912010101-aaaaaa",
    mode: "execute",
    status: "running",
    plan: { selected: [{ id: "1" }] },
    workers: [],
    validations: [],
    reviews: {},
    capacity: { limit: 2, sessionId: "session-a", sessionStartedAt: "2026-09-12T01:01:01.000Z" }
  }];
  const snapshot = capacitySnapshot(config({ "1": { status: "ready" }, "2": { status: "ready" } }, 5), states);
  assert.equal(snapshot.limit, 2);
  assert.equal(snapshot.requestedLimit, 5);
  assert.equal(snapshot.available, 1);
});

test("outside-selection active work constrains advisory-conflicting backfill", () => {
  const manifest = config({ "2": { status: "ready" } }, 2, [{
    issues: ["1", "2"], reason: "shared files", source: "test", confidence: "high"
  }]);
  const states = [{
    runId: "20260912010101-aaaaaa",
    mode: "rework",
    status: "running",
    plan: { selected: [{ id: "1" }] },
    workers: [], validations: [], reviews: {}
  }];
  const snapshot = capacitySnapshot(manifest, states);
  assert.deepEqual(snapshot.plan.selected, []);
  assert.equal(snapshot.plan.advisoryDeferred[0].id, "2");
  assert.equal(snapshot.idle.kind, "conflict");
});

test("an active rework consumes one shared slot and leaves an independent item selected", () => {
  const manifest = config({ "1": { status: "ready" }, "2": { status: "ready" } }, 2);
  const states = [{
    runId: "20260912010101-aaaaaa",
    mode: "rework",
    status: "running",
    plan: { selected: [{ id: "1" }] },
    workers: [], validations: [], reviews: {},
    capacity: { limit: 2, sessionId: "session-a" }
  }];
  const snapshot = capacitySnapshot(manifest, states);
  assert.equal(snapshot.used, 1);
  assert.equal(snapshot.available, 1);
  assert.deepEqual(snapshot.plan.selected.map((item) => item.id), ["2"]);
});

test("a multi-item run counts only issue reservations that have not settled", () => {
  const manifest = config({
    "1": { status: "ready" },
    "2": { status: "ready" },
    "3": { status: "ready" }
  }, 2);
  const states = [{
    runId: "20260912010101-aaaaaa", mode: "execute", status: "running",
    plan: { selected: [{ id: "1" }, { id: "2" }] },
    workers: [{ issue: "1", exitCode: 0, baseSha: "base", headSha: "head" }],
    validations: [{ issue: "1", exitCode: 0, verdict: "approve" }],
    reviews: {},
    capacity: { limit: 2, sessionId: "session-a", issues: ["2"] }
  }];
  const snapshot = capacitySnapshot(manifest, states);
  assert.equal(snapshot.used, 1);
  assert.deepEqual(snapshot.active.map((item) => item.issue), ["2"]);
  assert.deepEqual(snapshot.plan.selected.map((item) => item.id), ["3"]);
});

test("integration completion exposes newly unblocked work to backfill", () => {
  const manifest = config({
    "1": { status: "complete" },
    "2": { status: "ready", blockedBy: ["1"] }
  }, 2);
  const snapshot = capacitySnapshot(manifest, []);
  assert.deepEqual(snapshot.plan.selected.map((item) => item.id), ["2"]);
});

test("advisory-conflicting correction work is deterministically serialized", () => {
  const conflicts = [{ issues: ["1", "2"], reason: "shared files", source: "test", confidence: "high" }];
  const batches = capacityBatches([{ id: "1" }, { id: "2" }, { id: "3" }], 2, conflicts);
  assert.deepEqual(batches.map((batch) => batch.map((item) => item.id)), [["1", "3"], ["2"]]);
});

test("idle capacity distinguishes dependencies, lifecycle gates, and absent authorized work", () => {
  const dependency = capacitySnapshot(config({ "2": { status: "blocked", blockedBy: ["1"] } }), []);
  assert.equal(dependency.idle.kind, "dependency");

  const gated = capacitySnapshot(config({ "2": { status: "human_gate" } }), []);
  assert.equal(gated.idle.kind, "human-gate");

  const empty = capacitySnapshot(config({ "2": { status: "complete" } }), []);
  assert.equal(empty.idle.kind, "no-authorized-work");
});

test("gated work does not consume a slot but an active resolver does", async (t) => {
  const { repoPath } = await tempRepo(t);
  await saveRunState(repoPath, "20260912010101-aaaaaa", {
    runId: "20260912010101-aaaaaa", mode: "rework", status: "awaiting-review",
    plan: { selected: [{ id: "1" }] }, workers: [{ issue: "1", exitCode: 0 }],
    validations: [{ issue: "1", verdict: "human_gate" }], reviews: {}
  });
  const available = await reserveExplicitWork(config({ "1": { status: "ready" }, "2": { status: "ready" } }, 1), {
    repoPath, runId: "20260912010102-bbbbbb", mode: "reconcile", items: [{ id: "2" }]
  });
  assert.equal(available.reserved, true);
  const exhausted = await reserveExplicitWork(config({ "3": { status: "ready" } }, 1), {
    repoPath, runId: "20260912010103-cccccc", mode: "execute", items: [{ id: "3" }]
  });
  assert.equal(exhausted.reserved, false);
  assert.equal(exhausted.reason, "exhausted");
});

test("linked worktrees share one report and reservation scope", async (t) => {
  const { root, repoPath } = await tempRepo(t);
  await fs.writeFile(path.join(repoPath, "tracked"), "one\n");
  assert.equal(spawnSync("git", ["add", "tracked"], { cwd: repoPath }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repoPath }).status, 0);
  const linked = path.join(root, "linked");
  assert.equal(spawnSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: repoPath }).status, 0);
  assert.equal(reportRootForRepo(linked), reportRootForRepo(repoPath));
});

test("the lifecycle pool backfills a slot as soon as one task settles", async () => {
  const started = [];
  let releaseLong;
  const long = new Promise((resolve) => { releaseLong = resolve; });
  const running = runCapacityPool(["rework", "fresh-a", "fresh-b"], 2, async (task) => {
    started.push(task);
    if (task === "rework") await long;
    return task;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["rework", "fresh-a", "fresh-b"]);
  releaseLong();
  assert.deepEqual(await running, ["rework", "fresh-a", "fresh-b"]);
});

test("lifecycle backfill re-queries eligibility after each settled transition", async (t) => {
  const { repoPath } = await tempRepo(t);
  const manifest = config({
    "1": { status: "ready", priority: 1 },
    "2": { status: "ready", blockedBy: ["1"], priority: 2 },
    "3": { status: "ready", priority: 3 }
  }, 1);
  const started = [];
  let sequence = 0;
  const outcomes = await runLifecycleBackfill(manifest, {
    repoPath,
    authorizedIssueIds: ["1", "2"],
    runIdFactory: () => `2026091202020${++sequence}-aaaaaa`,
    executeReserved: async ({ candidate, runId, reservation }) => {
      started.push(candidate.id);
      manifest.work[candidate.id].status = "complete";
      reservation.state.status = "awaiting-review";
      reservation.state.capacity.issues = [];
      await saveRunState(repoPath, runId, reservation.state);
      return candidate.id;
    }
  });
  assert.deepEqual(started, ["1", "2"]);
  assert.deepEqual(outcomes, ["1", "2"]);
  assert.equal(started.includes("3"), false);
});

test("explicit authorization is applied before ready backfill selection", async (t) => {
  const { repoPath } = await tempRepo(t);
  const manifest = config({
    "1": { status: "ready", priority: 1 },
    "2": { status: "ready", priority: 2 }
  }, 1);
  const started = [];
  await runLifecycleBackfill(manifest, {
    repoPath,
    authorizedIssueIds: ["2"],
    runIdFactory: () => "20260912030303-aaaaaa",
    executeReserved: async ({ candidate, runId, reservation }) => {
      started.push(candidate.id);
      manifest.work[candidate.id].status = "complete";
      reservation.state.status = "awaiting-review";
      reservation.state.capacity.issues = [];
      await saveRunState(repoPath, runId, reservation.state);
    }
  });
  assert.deepEqual(started, ["2"]);
});

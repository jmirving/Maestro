const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadPersistedRunStates, saveRunState } = require("../src/run-store");
const { reportRootForRepo } = require("../src/reporter");
const { resolveCurrentIssueStates } = require("../src/run-resolver");
const { isRecoverableValidatorRework } = require("../src/run-lifecycle");
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

test("stale rework discovery cannot reserve after another invocation settles the issue", async (t) => {
  for (const verdict of ["approve", "human_gate"]) {
    await t.test(verdict, async (t) => {
      const { repoPath } = await tempRepo(t);
      const manifest = config({ "7": { status: "ready" } }, 1);
      const sourceRunId = "20260912010101-aaaaaa";
      const settledRunId = verdict === "approve"
        ? "20260912010102-bbbbbb"
        : "20260912010103-cccccc";
      const reservationRunId = verdict === "approve"
        ? "20260912010104-dddddd"
        : "20260912010105-eeeeee";
      await saveRunState(repoPath, sourceRunId, {
        runId: sourceRunId,
        mode: "execute",
        status: "awaiting-review",
        plan: { selected: [{ id: "7" }] },
        workers: [{ issue: "7", exitCode: 0, baseSha: "base", headSha: "rejected" }],
        validations: [{ issue: "7", exitCode: 0, verdict: "rework" }],
        reviews: {}
      });
      const [discovered] = await resolveCurrentIssueStates(repoPath, ["7"]);
      let workerStarts = 0;

      const outcomes = await runLifecycleBackfill(manifest, {
        repoPath,
        authorizedIssueIds: ["7"],
        initialTasks: [{ issue: "7" }],
        reserveInitial: async (task) => {
          await saveRunState(repoPath, settledRunId, {
            runId: settledRunId,
            parentRunId: sourceRunId,
            mode: "rework",
            status: "awaiting-review",
            plan: { selected: [{ id: task.issue }] },
            workers: [{ issue: task.issue, exitCode: 0, baseSha: "rejected", headSha: "settled" }],
            validations: [{ issue: task.issue, exitCode: 0, verdict }],
            reviews: {}
          });
          const reservation = await reserveExplicitWork(manifest, {
            repoPath,
            runId: reservationRunId,
            mode: "rework",
            items: [{ id: task.issue, mode: "rework" }],
            expectedCurrent: [{ issue: task.issue, runId: discovered.runId }],
            currentEligibility: (current) => (
              current.evidence?.state === "awaiting-rework" &&
              isRecoverableValidatorRework(current.evidence)
            )
          });
          return { ...reservation, terminal: reservation.reason === "changed-evidence" };
        },
        executeInitial: async () => {
          workerStarts += 1;
          return "unexpected-worker";
        },
        runIdFactory: () => "20260912010106-ffffff",
        executeReserved: async () => "unexpected-backfill"
      });

      assert.deepEqual(outcomes, []);
      assert.equal(workerStarts, 0);
      const states = await loadPersistedRunStates(repoPath);
      assert.equal(states.some((state) => state.runId === reservationRunId), false);
      const snapshot = capacitySnapshot(manifest, states);
      assert.equal(snapshot.used, 0);
      assert.equal(snapshot.available, 1);
    });
  }
});

test("reserveReadyWork applies authorization before capacity selection", async (t) => {
  const { repoPath } = await tempRepo(t);
  const manifest = config({
    "1": { status: "ready", priority: 1 },
    "2": { status: "ready", priority: 2 }
  }, 1);

  const reservation = await reserveReadyWork(manifest, {
    repoPath,
    runId: "20260912010103-cccccc",
    authorizedIssueIds: ["2"]
  });

  assert.equal(reservation.reserved, true);
  assert.deepEqual(reservation.plan.selected.map((item) => item.id), ["2"]);
  assert.deepEqual(reservation.state.capacity.issues, ["2"]);
});

test("the first active invocation owns the aggregate limit over later temporary overrides until its session drains", () => {
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
  const manifest = config({ "1": { status: "ready" }, "2": { status: "ready" } }, 3);
  const concurrency = { value: 5, source: "this invocation", savedDefault: 3 };
  const snapshot = capacitySnapshot(manifest, states, { concurrency });
  assert.equal(snapshot.limit, 2);
  assert.equal(snapshot.requestedLimit, 5);
  assert.equal(snapshot.available, 1);
  assert.equal(snapshot.plan.concurrency, 2);
  assert.equal(snapshot.plan.concurrencySource, "captured session");

  const drained = capacitySnapshot(manifest, [], { concurrency });
  assert.equal(drained.limit, 5);
  assert.equal(drained.plan.concurrency, 5);
  assert.equal(drained.plan.concurrencySource, "this invocation");
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

test("lifecycle scheduling serializes conflicting corrections and fills the spare slot", async (t) => {
  const { repoPath } = await tempRepo(t);
  const manifest = config({
    "1": { status: "ready" },
    "2": { status: "ready" },
    "3": { status: "ready", priority: 1 }
  }, 2, [{ issues: ["1", "2"], reason: "shared files", source: "test", confidence: "high" }]);
  const started = [];
  let running = 0;
  let peak = 0;
  let sequence = 0;
  let independentStarted;
  const independent = new Promise((resolve) => { independentStarted = resolve; });

  async function settle(runId, state, issue = null) {
    state.status = "awaiting-review";
    state.capacity.issues = [];
    if (issue) {
      state.workers = [{ issue, exitCode: 0, baseSha: "base", headSha: "head" }];
      state.validations = [{ issue, exitCode: 0, verdict: "approve" }];
    }
    await saveRunState(repoPath, runId, state);
  }

  const outcomes = await runLifecycleBackfill(manifest, {
    repoPath,
    authorizedIssueIds: ["1", "2", "3"],
    initialTasks: [{ issue: "1" }, { issue: "2" }],
    reserveInitial: async (task) => {
      const runId = `2026091204040${++sequence}-aaaaaa`;
      const reservation = await reserveExplicitWork(manifest, {
        repoPath, runId, mode: "rework", items: [{ id: task.issue, mode: "rework" }]
      });
      return { ...reservation, runId };
    },
    executeInitial: async (task, prepared) => {
      started.push(`correction-${task.issue}`);
      running += 1;
      peak = Math.max(peak, running);
      if (task.issue === "1") await independent;
      await settle(prepared.runId, prepared.state, task.issue);
      running -= 1;
      return `correction-${task.issue}`;
    },
    runIdFactory: () => `2026091204040${++sequence}-bbbbbb`,
    executeReserved: async ({ candidate, runId, reservation }) => {
      started.push(`ready-${candidate.id}`);
      running += 1;
      peak = Math.max(peak, running);
      independentStarted();
      manifest.work[candidate.id].status = "complete";
      await settle(runId, reservation.state);
      running -= 1;
      return `ready-${candidate.id}`;
    }
  });

  assert.deepEqual(started, ["correction-1", "ready-3", "correction-2"]);
  assert.equal(peak, 2);
  assert.deepEqual(new Set(outcomes), new Set(["correction-1", "correction-2", "ready-3"]));
});

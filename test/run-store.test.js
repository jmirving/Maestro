const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadIssueDetails } = require("../src/details");
const { latestRunBundle, reportRootForRepo } = require("../src/reporter");
const {
  RunStateConflictError,
  loadRunState,
  saveRunState,
  statePath
} = require("../src/run-store");

const runId = "20260920010101-abcdef";

function runState(generation = 0) {
  return {
    runId,
    mode: "execute",
    status: "awaiting-review",
    generation,
    plan: { selected: [{ id: "7", title: "Atomic state" }] },
    workers: [{ issue: "7", exitCode: 0, headSha: `head-${generation}` }],
    validations: [{ issue: "7", exitCode: 0, verdict: "approve" }],
    reviews: {}
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-run-store-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { repoPath };
}

async function temporaryNames(repoPath) {
  const file = statePath(repoPath, runId);
  const names = await fs.readdir(path.dirname(file));
  const prefix = `${path.basename(file)}.`;
  return names.filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"));
}

async function ageFile(file, ageMs = 5_000) {
  const old = new Date(Date.now() - ageMs);
  await fs.utimes(file, old, old);
}

test("concurrent run-state readers observe only complete generations", async (t) => {
  const { repoPath } = await fixture(t);
  const state = runState();
  await saveRunState(repoPath, runId, state);

  let releaseTemporary;
  const temporaryWritten = new Promise((resolve) => {
    releaseTemporary = resolve;
  });
  let allowRename;
  const renameAllowed = new Promise((resolve) => {
    allowRename = resolve;
  });
  state.generation = 1;
  state.workers[0].headSha = "head-1";
  const writing = saveRunState(repoPath, runId, state, {
    afterTemporaryWrite: async () => {
      releaseTemporary();
      await renameAllowed;
    }
  });
  await temporaryWritten;

  const readers = await Promise.all([
    ...Array.from({ length: 40 }, () => loadRunState(repoPath, runId)),
    latestRunBundle(repoPath),
    loadIssueDetails(repoPath, ["7"], { runId })
  ]);
  assert.ok(readers.slice(0, 40).every((loaded) => loaded.generation === 0));
  assert.equal(readers[40].state.generation, 0);
  assert.equal(readers[41][0].state.generation, 0);

  allowRename();
  await writing;
  assert.equal((await loadRunState(repoPath, runId)).generation, 1);

  let reading = true;
  const observed = [];
  const reader = (async () => {
    while (reading) {
      observed.push((await loadRunState(repoPath, runId)).generation);
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  for (let generation = 2; generation <= 30; generation += 1) {
    state.generation = generation;
    state.workers[0].headSha = `head-${generation}`;
    await saveRunState(repoPath, runId, state);
  }
  reading = false;
  await reader;
  assert.ok(observed.length > 0);
  assert.ok(observed.every((generation) => Number.isInteger(generation) && generation >= 1 && generation <= 30));
});

test("sequential writes serialize and overlapping stale writers cannot lose updates", async (t) => {
  const { repoPath } = await fixture(t);
  const state = runState();
  await saveRunState(repoPath, runId, state);
  state.generation = 1;
  await saveRunState(repoPath, runId, state);
  state.generation = 2;
  await saveRunState(repoPath, runId, state);
  assert.equal((await loadRunState(repoPath, runId)).generation, 2);

  const first = await loadRunState(repoPath, runId);
  const second = await loadRunState(repoPath, runId);
  first.reviews["7"] = { disposition: "approve" };
  second.autoRework = { "7": { status: "approved" } };

  const results = await Promise.allSettled([
    saveRunState(repoPath, runId, first),
    saveRunState(repoPath, runId, second)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected").reason;
  assert.ok(rejection instanceof RunStateConflictError);
  assert.equal(rejection.code, "RUN_STATE_CONFLICT");

  const persisted = await loadRunState(repoPath, runId);
  const keptReview = persisted.reviews["7"]?.disposition === "approve";
  const keptAutoRework = persisted.autoRework?.["7"]?.status === "approved";
  assert.notEqual(keptReview, keptAutoRework);
});

test("failures after temp creation and before rename preserve prior state and clean temporary files", async (t) => {
  const { repoPath } = await fixture(t);
  const state = runState();
  await saveRunState(repoPath, runId, state);
  state.generation = 1;

  await assert.rejects(saveRunState(repoPath, runId, state, {
    afterTemporaryWrite: () => {
      throw new Error("injected after temp creation");
    }
  }), /injected after temp creation/);
  assert.equal((await loadRunState(repoPath, runId)).generation, 0);
  assert.deepEqual(await temporaryNames(repoPath), []);

  await assert.rejects(saveRunState(repoPath, runId, state, {
    beforeRename: () => {
      throw new Error("injected before rename");
    }
  }), /injected before rename/);

  assert.equal((await loadRunState(repoPath, runId)).generation, 0);
  assert.deepEqual(await temporaryNames(repoPath), []);
});

test("abandoned temporary files are removed safely and existing permissions are retained", async (t) => {
  const { repoPath } = await fixture(t);
  const state = runState();
  await saveRunState(repoPath, runId, state);
  const file = statePath(repoPath, runId);
  await fs.chmod(file, 0o640);
  await fs.writeFile(`${file}.abandoned.tmp`, "{ partial", "utf8");

  state.generation = 1;
  await saveRunState(repoPath, runId, state);

  assert.deepEqual(await temporaryNames(repoPath), []);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  assert.equal((await loadRunState(repoPath, runId)).generation, 1);
});

test("abandoned empty, malformed, and dead-owner locks are reclaimed after the stale grace period", async (t) => {
  const cases = ["", "not-a-pid\n", "2147483647\n"];

  for (const contents of cases) {
    const { repoPath } = await fixture(t);
    const file = statePath(repoPath, runId);
    const lock = `${file}.lock`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(lock, contents, "utf8");
    await ageFile(lock);

    await saveRunState(repoPath, runId, runState(), { retryMs: 0 });

    assert.equal((await loadRunState(repoPath, runId)).generation, 0);
    await assert.rejects(fs.stat(lock), { code: "ENOENT" });
  }
});

test("young incomplete locks and changed lock identities are never reclaimed", async (t) => {
  const { repoPath } = await fixture(t);
  const file = statePath(repoPath, runId);
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(lock, "", "utf8");

  await assert.rejects(
    saveRunState(repoPath, runId, runState(), { retryMs: 0, timeoutMs: 0 }),
    /Timed out waiting for Maestro's run-state lock/
  );
  assert.equal(await fs.readFile(lock, "utf8"), "");

  await ageFile(lock);
  let replacementIdentity;
  await assert.rejects(
    saveRunState(repoPath, runId, runState(), {
      retryMs: 0,
      timeoutMs: 0,
      beforeStaleLockRemoval: async () => {
        await fs.unlink(lock);
        await fs.writeFile(lock, `${process.pid}\n`, "utf8");
        replacementIdentity = await fs.stat(lock, { bigint: true });
      }
    }),
    /Timed out waiting for Maestro's run-state lock/
  );

  const retainedIdentity = await fs.stat(lock, { bigint: true });
  assert.equal(retainedIdentity.dev, replacementIdentity.dev);
  assert.equal(retainedIdentity.ino, replacementIdentity.ino);
  assert.equal(await fs.readFile(lock, "utf8"), `${process.pid}\n`);
});

test("simultaneous stale-lock reclaimers serialize before either writer publishes", async (t) => {
  const { repoPath } = await fixture(t);
  const file = statePath(repoPath, runId);
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(lock, "abandoned\n", "utf8");
  await ageFile(lock);

  let releaseFirst;
  const firstMayRemove = new Promise((resolve) => { releaseFirst = resolve; });
  let firstInspected;
  const firstDidInspect = new Promise((resolve) => { firstInspected = resolve; });
  let secondContended;
  const secondDidContend = new Promise((resolve) => { secondContended = resolve; });

  const firstState = runState(1);
  const secondState = runState(2);
  const first = saveRunState(repoPath, runId, firstState, {
    retryMs: 0,
    beforeStaleLockRemoval: async () => {
      firstInspected();
      await firstMayRemove;
    }
  });
  await firstDidInspect;
  const second = saveRunState(repoPath, runId, secondState, {
    retryMs: 0,
    onStaleLockReclaimBusy: secondContended
  });
  await secondDidContend;
  releaseFirst();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected").reason;
  assert.ok(rejection instanceof RunStateConflictError);
  assert.ok([1, 2].includes((await loadRunState(repoPath, runId)).generation));
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("a writer paused before owner publication exposes no incomplete reclaimable lock", async (t) => {
  const { repoPath } = await fixture(t);
  const file = statePath(repoPath, runId);
  const lock = `${file}.lock`;
  let resumeFirst;
  const firstMayPublish = new Promise((resolve) => { resumeFirst = resolve; });
  let firstPrepared;
  const firstDidPrepare = new Promise((resolve) => { firstPrepared = resolve; });
  let paused = false;
  let currentTime = Date.now();

  const first = saveRunState(repoPath, runId, runState(1), {
    retryMs: 0,
    staleLockMs: 1_000,
    now: () => currentTime,
    beforeLockPublish: async () => {
      if (paused) return;
      paused = true;
      firstPrepared();
      await firstMayPublish;
    }
  });
  await firstDidPrepare;
  currentTime += 5_000;
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });

  await saveRunState(repoPath, runId, runState(2), { retryMs: 0, staleLockMs: 1_000 });
  resumeFirst();
  await assert.rejects(first, RunStateConflictError);

  assert.equal((await loadRunState(repoPath, runId)).generation, 2);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" });
});

test("genuinely corrupt state still fails clearly", async (t) => {
  const { repoPath } = await fixture(t);
  const root = reportRootForRepo(repoPath);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(statePath(repoPath, runId), "{ corrupt", "utf8");
  await assert.rejects(loadRunState(repoPath, runId), SyntaxError);
});

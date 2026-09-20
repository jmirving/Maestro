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

test("genuinely corrupt state still fails clearly", async (t) => {
  const { repoPath } = await fixture(t);
  const root = reportRootForRepo(repoPath);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(statePath(repoPath, runId), "{ corrupt", "utf8");
  await assert.rejects(loadRunState(repoPath, runId), SyntaxError);
});

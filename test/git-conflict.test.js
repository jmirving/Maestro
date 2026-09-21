const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  inspectGitOperation,
  captureConflict,
  safelyAbortConflict,
  contentConflictError,
  conflictRecoveryCommands
} = require("../src/git-conflict");
const { formatDetails } = require("../src/details");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const error = new Error(`git ${args.join(" ")} failed`);
    error.result = { code: result.status, stdout: result.stdout, stderr: result.stderr };
    throw error;
  }
  return result.stdout.trim();
}

async function conflictingRepository(t, { deleteOnWorker = false, renameOnWorker = false, deleteOnMain = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-git-conflict-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "--bare", "-q", origin);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Maestro Test");
  git(repo, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "shared.txt");
  git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  const baseSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "worker/7");
  if (renameOnWorker) git(repo, "mv", "shared.txt", "renamed.txt");
  else if (deleteOnWorker) await fs.rm(path.join(repo, "shared.txt"));
  else await fs.writeFile(path.join(repo, "shared.txt"), "worker\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "worker change");
  const sourceSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  if (deleteOnMain) {
    await fs.rm(path.join(repo, "shared.txt"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "main delete");
  } else {
    await fs.writeFile(path.join(repo, "shared.txt"), "main\n");
    git(repo, "commit", "-qam", "main change");
  }
  git(repo, "push", "-q", "origin", "main");
  const targetSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "worker/7");
  return { repo, baseSha, sourceSha, targetSha };
}

test("shared conflict contract captures exact content provenance before a safe abort", async (t) => {
  const fixture = await conflictingRepository(t);
  let failure;
  try { git(fixture.repo, "rebase", "origin/main"); } catch (error) { failure = error; }

  const observed = await inspectGitOperation(fixture.repo);
  assert.equal(observed.operation, "rebase");
  assert.equal(observed.headSha, fixture.targetSha);
  assert.equal(observed.operationOriginalHeadSha, fixture.sourceSha);
  assert.equal(observed.operationCurrentHeadSha, fixture.targetSha);
  assert.equal(observed.operationHeadSha, fixture.sourceSha);
  assert.equal(observed.operationOntoSha, fixture.targetSha);
  assert.equal(observed.operationSourceSha, fixture.sourceSha);
  assert.equal(observed.operationTargetSha, fixture.targetSha);
  assert.deepEqual(observed.conflictedFiles, ["shared.txt"]);

  const conflict = await captureConflict({
    repository: "example/repo", issue: "7", sourceRunId: "run-1",
    stage: "integration-refresh", interruptedAction: "serialized integration refresh",
    worktreePath: fixture.repo, branch: "worker/7", originalBaseSha: fixture.baseSha,
    sourceSha: fixture.sourceSha, targetBranch: "main", targetSha: fixture.targetSha,
    failure
  });
  assert.equal(conflict.contractVersion, 1);
  assert.equal(conflict.operationState, "active");
  assert.equal(conflict.sourceSha, fixture.sourceSha);
  assert.equal(conflict.targetSha, fixture.targetSha);
  assert.equal(conflict.operationOriginalHeadSha, fixture.sourceSha);
  assert.equal(conflict.operationCurrentHeadSha, fixture.targetSha);
  assert.equal(conflict.operationHeadSha, fixture.sourceSha);
  assert.equal(conflict.operationOntoSha, fixture.targetSha);
  assert.deepEqual(conflict.conflictedFiles, ["shared.txt"]);
  assert.equal(conflict.continuationAction, "maestro reconcile 7");

  await safelyAbortConflict(conflict);
  assert.equal(conflict.operationState, "aborted");
  assert.equal(git(fixture.repo, "status", "--porcelain"), "");
  assert.equal(git(fixture.repo, "rev-parse", "HEAD"), fixture.sourceSha);
});

test("modify/delete conflicts retain the conflicted pathname", async (t) => {
  const fixture = await conflictingRepository(t, { deleteOnWorker: true });
  let failure;
  try { git(fixture.repo, "rebase", "origin/main"); } catch (error) { failure = error; }
  const conflict = await captureConflict({
    issue: "7", sourceRunId: "run-1", stage: "rework-refresh",
    interruptedAction: "validator correction refresh", worktreePath: fixture.repo,
    targetSha: fixture.targetSha, failure
  });
  assert.deepEqual(conflict.conflictedFiles, ["shared.txt"]);
  await safelyAbortConflict(conflict);
});

test("rename/delete conflicts retain Git's exact renamed pathname", async (t) => {
  const fixture = await conflictingRepository(t, { renameOnWorker: true, deleteOnMain: true });
  let failure;
  try { git(fixture.repo, "rebase", "origin/main"); } catch (error) { failure = error; }
  const conflict = await captureConflict({
    issue: "7", sourceRunId: "run-1", stage: "integration-refresh",
    interruptedAction: "serialized integration refresh", worktreePath: fixture.repo,
    targetSha: fixture.targetSha, failure
  });
  assert.deepEqual(conflict.conflictedFiles, ["renamed.txt"]);
  await safelyAbortConflict(conflict);
});

test("generic Git failures are not mislabeled as content conflicts", async (t) => {
  const fixture = await conflictingRepository(t);
  const conflict = await captureConflict({
    issue: "7", sourceRunId: "run-1", stage: "rework-refresh",
    interruptedAction: "validator correction refresh", worktreePath: fixture.repo,
    failure: new Error("authentication failed")
  });
  assert.equal(conflict, null);
});

test("Maestro never aborts a user-owned active operation or discards partial resolution", async (t) => {
  const fixture = await conflictingRepository(t);
  try { git(fixture.repo, "rebase", "origin/main"); } catch {}
  await fs.writeFile(path.join(fixture.repo, "shared.txt"), "partially resolved\n");
  git(fixture.repo, "add", "shared.txt");
  const conflict = await captureConflict({
    issue: null, sourceRunId: null, stage: "reconciliation-refresh",
    interruptedAction: "adopted operation", worktreePath: fixture.repo,
    startedByMaestro: false
  });
  assert.equal(conflict.sourceSha, fixture.sourceSha);
  assert.equal(conflict.targetSha, fixture.targetSha);
  assert.equal(conflict.operationOriginalHeadSha, fixture.sourceSha);
  assert.equal(conflict.operationCurrentHeadSha, fixture.targetSha);
  assert.equal(conflict.operationHeadSha, fixture.sourceSha);
  assert.equal(conflict.operationOntoSha, fixture.targetSha);
  assert.equal(conflict.continuationAction, null);
  assert.equal(conflictRecoveryCommands(conflict).some((command) => command.includes("null")), false);
  assert.doesNotMatch(contentConflictError(conflict).message, /\bnull\b/);
  await safelyAbortConflict(conflict);
  assert.equal(conflict.operationOwner, "user");
  assert.equal(conflict.operationState, "active");
  assert.equal(conflict.preservation.partialResolutionsPreserved, true);
  assert.equal((await inspectGitOperation(fixture.repo)).operationActive, true);
  assert.match(await fs.readFile(path.join(fixture.repo, "shared.txt"), "utf8"), /partially resolved/);
  git(fixture.repo, "rebase", "--abort");
});

test("a user-owned merge records its original source and merge target before persistence", async (t) => {
  const fixture = await conflictingRepository(t);
  let failure;
  try { git(fixture.repo, "merge", "origin/main"); } catch (error) { failure = error; }

  const observed = await inspectGitOperation(fixture.repo);
  assert.equal(observed.operation, "merge");
  assert.equal(observed.headSha, fixture.sourceSha);
  assert.equal(observed.operationOriginalHeadSha, fixture.sourceSha);
  assert.equal(observed.operationCurrentHeadSha, fixture.sourceSha);
  assert.equal(observed.operationHeadSha, fixture.targetSha);
  assert.equal(observed.operationMergeHeadSha, fixture.targetSha);
  assert.equal(observed.operationSourceSha, fixture.sourceSha);
  assert.equal(observed.operationTargetSha, fixture.targetSha);

  const conflict = await captureConflict({
    issue: null, sourceRunId: null, stage: "reconciliation-refresh",
    interruptedAction: "adopted merge operation", worktreePath: fixture.repo,
    startedByMaestro: false, failure
  });
  assert.equal(conflict.operationOwner, "user");
  assert.equal(conflict.sourceSha, fixture.sourceSha);
  assert.equal(conflict.targetSha, fixture.targetSha);
  assert.equal(conflict.operationOriginalHeadSha, fixture.sourceSha);
  assert.equal(conflict.operationCurrentHeadSha, fixture.sourceSha);
  assert.equal(conflict.operationHeadSha, fixture.targetSha);
  assert.equal(conflict.operationMergeHeadSha, fixture.targetSha);
  assert.equal(conflict.continuationAction, null);

  const runId = "20260913010101-aaaaaa";
  const details = formatDetails([{
    issue: "7", runId, title: null, manifestStatus: null, lineage: [],
    state: { runId, mode: "reconcile", status: "technical-conflict" },
    evidence: { issue: "7", state: "technical-conflict", conflict }
  }]);
  assert.match(details, new RegExp(`Source SHA: ${fixture.sourceSha}`));
  assert.match(details, new RegExp(`Target SHA: ${fixture.targetSha}`));
  assert.match(details, new RegExp(`Operation original HEAD: ${fixture.sourceSha}`));
  assert.match(details, new RegExp(`Operation current HEAD: ${fixture.sourceSha}`));
  assert.match(details, new RegExp(`Operation head: ${fixture.targetSha}`));
  assert.match(details, new RegExp(`Merge head SHA: ${fixture.targetSha}`));
  git(fixture.repo, "merge", "--abort");
});

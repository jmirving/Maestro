const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildReconcilePrompt, resolveReconcileSource, executeReconcileRun } = require("../src/reconcile");
const { saveRunState, loadRunState, loadPersistedRunStates } = require("../src/run-store");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

async function conflictFixture(t, { sourceConflict = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-reconcile-conflict-"));
  const originPath = path.join(root, "origin.git");
  const repoPath = path.join(root, "target");
  const workerPath = path.join(root, "worker");
  const sourceRunId = "20260910010101-aaaaaa";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "--bare", "-q", originPath);
  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.name", "Maestro Test");
  git(repoPath, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(repoPath, "shared.txt"), "base\n");
  git(repoPath, "add", "shared.txt");
  git(repoPath, "commit", "-qm", "base");
  const baseSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "remote", "add", "origin", originPath);
  git(repoPath, "push", "-q", "-u", "origin", "main");
  git(repoPath, "worktree", "add", "-q", "-b", "worker/19", workerPath);
  await fs.writeFile(path.join(workerPath, "shared.txt"), "worker\n");
  git(workerPath, "commit", "-qam", "worker change");
  const originalHead = git(workerPath, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repoPath, "shared.txt"), "main\n");
  git(repoPath, "commit", "-qam", "main change");
  git(repoPath, "push", "-q", "origin", "main");
  const targetSha = git(repoPath, "rev-parse", "HEAD");

  const conflict = {
    contractVersion: 1,
    issue: "19",
    sourceRunId,
    operation: "rebase",
    operationState: "aborted",
    interruptedStage: "integration-refresh"
  };
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    status: sourceConflict ? "technical-conflict" : "awaiting-review",
    workers: [{ issue: "19", branch: "worker/19", worktreePath: workerPath, baseSha, headSha: originalHead, exitCode: 0 }],
    validations: [{ issue: "19", verdict: "approve", exitCode: 0 }],
    reviews: { "19": { disposition: "approve" } },
    conflicts: sourceConflict ? { "19": conflict } : {}
  });
  return { root, repoPath, workerPath, sourceRunId, baseSha, originalHead, targetSha };
}

test("reconcile prompt bounds the agent to approved integration-conflict repair", () => {
  const prompt = buildReconcilePrompt({
    repository: "example/repo",
    worker: { issue: "56", report: "approved worker behavior" },
    validation: { report: "VERDICT: APPROVE\napproved evidence" },
    sourceRunId: "run-1",
    defaultBranch: "main"
  });

  assert.match(prompt, /already validator-approved/);
  assert.match(prompt, /active git rebase conflict/);
  assert.match(prompt, /Resolve ONLY the rebase conflict/);
  assert.match(prompt, /GIT_EDITOR=true git rebase --continue/);
  assert.match(prompt, /Do not push/);
  assert.match(prompt, /approved evidence/);
  assert.match(prompt, /approved worker behavior/);
});

test("issue-oriented reconciliation resolves current evidence while --run remains an explicit override", async (t) => {
  const { repoPath, sourceRunId } = await conflictFixture(t);
  assert.deepEqual(await resolveReconcileSource(repoPath, "19"), {
    sourceRunId,
    issueIds: ["19"]
  });
  assert.deepEqual(await resolveReconcileSource(repoPath, "19", "historical-run"), {
    sourceRunId: "historical-run",
    issueIds: ["19"]
  });
});

test("reconcile verifies a manually completed operation and creates fresh review evidence", async (t) => {
  const { repoPath, workerPath, sourceRunId } = await conflictFixture(t);
  const childRunId = "20260910020202-bbbbbb";

  const attempted = spawnSync("git", ["rebase", "origin/main"], { cwd: workerPath, encoding: "utf8" });
  assert.notEqual(attempted.status, 0);
  await fs.writeFile(path.join(workerPath, "shared.txt"), "main and worker\n");
  git(workerPath, "add", "shared.txt");
  git(workerPath, "-c", "core.editor=true", "rebase", "--continue");
  await fs.writeFile(path.join(repoPath, "later.txt"), "second target movement\n");
  git(repoPath, "add", "later.txt");
  git(repoPath, "commit", "-qm", "move target again");
  git(repoPath, "push", "-q", "origin", "main");
  const targetSha = git(repoPath, "rev-parse", "HEAD");

  const result = await executeReconcileRun({
    repository: "example/repo",
    defaultBranch: "main",
    work: { "19": { status: "ready" } }
  }, {
    repoPath,
    sourceRunId,
    issueIds: ["19"],
    runId: childRunId,
    validatorExecutor: async ({ worker }) => ({ issue: worker.issue, verdict: "approve", exitCode: 0, report: "fresh" })
  });

  assert.equal(result.status, "awaiting-review");
  assert.equal(result.workers[0].headSha, git(workerPath, "rev-parse", "HEAD"));
  assert.equal(result.workers[0].baseSha, targetSha);
  assert.equal(result.validations[0].verdict, "approve");
  assert.deepEqual(result.reviews, {});
  assert.equal(result.conflicts["19"].operationState, "completed");
  assert.equal(result.conflicts["19"].resolvedBy, "reconciliation-refresh");
  assert.equal(result.conflicts["19"].resolutionVerifiedAgainstSha, targetSha);
  assert.equal((await loadRunState(repoPath, childRunId)).status, "awaiting-review");

  const runCountAfterRecovery = (await loadPersistedRunStates(repoPath)).length;
  await assert.rejects(
    executeReconcileRun({
      repository: "example/repo",
      defaultBranch: "main",
      work: { "19": { status: "ready" } }
    }, {
      repoPath,
      sourceRunId,
      issueIds: ["19"],
      validatorExecutor: async () => { throw new Error("validator must not restart"); }
    }),
    /Cannot reconcile superseded implementation evidence/
  );
  assert.equal((await loadPersistedRunStates(repoPath)).length, runCountAfterRecovery);
});

test("reconcile rejects manual recovery that resets away the implementation", async (t) => {
  const { repoPath, workerPath, sourceRunId } = await conflictFixture(t);
  git(workerPath, "reset", "--hard", "origin/main");
  let validatorCalls = 0;

  await assert.rejects(
    executeReconcileRun({ repository: "example/repo", defaultBranch: "main", work: { "19": { status: "ready" } } }, {
      repoPath,
      sourceRunId,
      issueIds: ["19"],
      runId: "20260910020202-bbbbbb",
      validatorExecutor: async () => { validatorCalls += 1; }
    }),
    /discarded the source implementation/
  );
  assert.equal(validatorCalls, 0);
  const state = await loadRunState(repoPath, "20260910020202-bbbbbb");
  assert.equal(state.status, "failed");
  assert.match(state.failure, /discarded the source implementation/);
});

test("a reconciliation-created conflict persists the shared recoverable contract", async (t) => {
  const { repoPath, workerPath, sourceRunId, baseSha, originalHead, targetSha } = await conflictFixture(t, {
    sourceConflict: false
  });
  const runId = "20260910020202-bbbbbb";
  assert.equal((await loadRunState(repoPath, sourceRunId)).conflicts["19"], undefined);

  await assert.rejects(
    executeReconcileRun({ repository: "example/repo", defaultBranch: "main", work: { "19": { status: "ready" } } }, {
      repoPath,
      sourceRunId,
      issueIds: ["19"],
      runId,
      processRunner: async () => ({ code: 1 })
    }),
    (error) => error.code === "GIT_CONTENT_CONFLICT"
  );

  const state = await loadRunState(repoPath, runId);
  const conflict = state.conflicts["19"];
  assert.equal(state.status, "technical-conflict");
  assert.equal(conflict.contractVersion, 1);
  assert.equal(conflict.interruptedStage, "reconciliation-refresh");
  assert.equal(conflict.operation, "rebase");
  assert.equal(conflict.operationOwner, "maestro");
  assert.equal(conflict.operationState, "aborted");
  assert.deepEqual(conflict.conflictedFiles, ["shared.txt"]);
  assert.equal(conflict.parentRunId, sourceRunId);
  assert.equal(conflict.originalBaseSha, baseSha);
  assert.equal(conflict.sourceSha, originalHead);
  assert.equal(conflict.targetSha, targetSha);
  assert.equal(conflict.continuationAction, "maestro reconcile 19");
  assert.equal(state.runId, runId);
  assert.equal(git(workerPath, "rev-parse", "HEAD"), originalHead);
  assert.equal(git(workerPath, "status", "--porcelain"), "");

  const originalProvenance = {
    interruptedStage: conflict.interruptedStage,
    sourceRunId: conflict.sourceRunId,
    parentRunId: conflict.parentRunId,
    originalBaseSha: conflict.originalBaseSha,
    sourceSha: conflict.sourceSha,
    targetSha: conflict.targetSha,
    conflictedFiles: conflict.conflictedFiles
  };

  const runCount = (await loadPersistedRunStates(repoPath)).length;
  const attempted = spawnSync("git", ["rebase", "origin/main"], { cwd: workerPath, encoding: "utf8" });
  assert.notEqual(attempted.status, 0);
  await fs.writeFile(path.join(workerPath, "shared.txt"), "main and retained worker\n");
  git(workerPath, "add", "shared.txt");
  git(workerPath, "-c", "core.editor=true", "rebase", "--continue");
  await fs.writeFile(path.join(repoPath, "later.txt"), "target moved after conflict\n");
  git(repoPath, "add", "later.txt");
  git(repoPath, "commit", "-qm", "move target after reconciliation conflict");
  git(repoPath, "push", "-q", "origin", "main");
  const movedTargetSha = git(repoPath, "rev-parse", "HEAD");

  const resumed = await executeReconcileRun({
    repository: "example/repo",
    defaultBranch: "main",
    work: { "19": { status: "ready" } }
  }, {
    repoPath,
    sourceRunId,
    issueIds: ["19"],
    runId,
    validatorExecutor: async ({ worker }) => ({ issue: worker.issue, verdict: "approve", exitCode: 0, report: "fresh" })
  });
  assert.equal(resumed.runId, runId);
  assert.equal(resumed.status, "awaiting-review");
  assert.equal(resumed.validations[0].verdict, "approve");
  assert.deepEqual({
    interruptedStage: resumed.conflicts["19"].interruptedStage,
    sourceRunId: resumed.conflicts["19"].sourceRunId,
    parentRunId: resumed.conflicts["19"].parentRunId,
    originalBaseSha: resumed.conflicts["19"].originalBaseSha,
    sourceSha: resumed.conflicts["19"].sourceSha,
    targetSha: resumed.conflicts["19"].targetSha,
    conflictedFiles: resumed.conflicts["19"].conflictedFiles
  }, originalProvenance);
  assert.equal(resumed.conflicts["19"].operationState, "completed");
  assert.equal(resumed.conflicts["19"].resolvedHeadSha, resumed.workers[0].headSha);
  assert.equal(resumed.conflicts["19"].resolutionVerifiedAgainstSha, movedTargetSha);
  const persisted = await loadRunState(repoPath, runId);
  assert.equal(persisted.conflicts["19"].interruptedStage, "reconciliation-refresh");
  assert.equal(persisted.conflicts["19"].sourceSha, originalHead);
  assert.equal(persisted.conflicts["19"].targetSha, targetSha);
  assert.deepEqual(persisted.conflicts["19"].conflictedFiles, ["shared.txt"]);
  assert.equal(persisted.conflicts["19"].resolutionVerifiedAgainstSha, movedTargetSha);
  assert.equal((await loadPersistedRunStates(repoPath)).length, runCount);
});

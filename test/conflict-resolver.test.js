const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { executeReworkRun, refreshWorker } = require("../src/rework");
const { buildConflictResolverPrompt, parseResolution, executeConflictResolver } = require("../src/conflict-resolver");
const { saveRunState, loadRunState, loadPersistedRunStates } = require("../src/run-store");
const { loadIssueDetails, formatDetails } = require("../src/details");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

async function conflictFixture(t, {
  filename = "shared.txt",
  baseContent = "base\n",
  workerContent = "worker change\n",
  mainContent = "main change\n"
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-conflict-resolver-"));
  const repoPath = path.join(root, "target");
  const originPath = path.join(root, "origin.git");
  const sourceRunId = "20260910010101-aaaaaa";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "--bare", "-q", originPath);
  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.email", "maestro@example.test");
  git(repoPath, "config", "user.name", "Maestro Test");
  await fs.writeFile(path.join(repoPath, filename), baseContent);
  git(repoPath, "add", filename);
  git(repoPath, "commit", "-q", "-m", "base");
  const baseSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "remote", "add", "origin", originPath);
  git(repoPath, "push", "-q", "-u", "origin", "main");
  git(repoPath, "checkout", "-q", "-b", "maestro/35");
  await fs.writeFile(path.join(repoPath, filename), workerContent);
  git(repoPath, "commit", "-qam", "retained implementation");
  const sourceSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "checkout", "-q", "main");
  await fs.writeFile(path.join(repoPath, filename), mainContent);
  git(repoPath, "commit", "-qam", "current main behavior");
  git(repoPath, "push", "-q", "origin", "main");
  const targetSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "checkout", "-q", "maestro/35");

  const worker = {
    issue: "35",
    exitCode: 0,
    baseSha,
    headSha: sourceSha,
    branch: "maestro/35",
    worktreePath: repoPath,
    report: "preserve the retained implementation"
  };
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    mode: "execute",
    status: "awaiting-review",
    plan: { selected: [{ id: "35", title: "Resolve rework conflicts" }] },
    workers: [worker],
    validations: [{ issue: "35", exitCode: 0, verdict: "rework", report: "VERDICT: REWORK\nKeep current-main behavior too." }],
    reviews: {}
  });
  return { repoPath, sourceRunId, worker, filename, baseSha, sourceSha, targetSha };
}

test("bounded resolver prompt carries intent and prohibits lifecycle authority", () => {
  const prompt = buildConflictResolverPrompt({
    repository: "example/repo",
    issue: "35",
    issueContext: { title: "Conflict recovery", body: "Preserve both behaviors." },
    priorWorkerReport: "Added correction lifecycle.",
    validatorReport: "VERDICT: REWORK\nRetain scheduler reservations.",
    conflict: {
      branch: "maestro/35",
      originalBaseSha: "base",
      sourceSha: "source",
      targetRef: "origin/main",
      targetSha: "target",
      rebaseHeadSha: "source",
      conflictedFiles: ["src/scheduler.js"],
      gitStatus: "u UU src/scheduler.js",
      retainedDiff: "+ correction lifecycle",
      targetDiff: "+ scheduler reservations"
    }
  });
  assert.match(prompt, /Preserve both behaviors/);
  assert.match(prompt, /Added correction lifecycle/);
  assert.match(prompt, /Retain scheduler reservations/);
  assert.match(prompt, /Original base SHA: base/);
  assert.match(prompt, /Source SHA before rebase: source/);
  assert.match(prompt, /src\/scheduler\.js/);
  assert.match(prompt, /Do not abort, skip, restart, or replace the rebase/);
  assert.match(prompt, /Do not.*approve, integrate, close issues/);
  assert.equal(parseResolution("RESOLUTION: RESOLVED\nDone."), "resolved");
  assert.equal(parseResolution("RESOLUTION: HUMAN_REQUIRED\nAmbiguous."), "human-required");
  assert.equal(parseResolution("looks good"), "invalid");
});

test("live conflict resolver uses the workspace-write sandbox", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-conflict-sandbox-"));
  const worktreePath = path.join(root, "worktree");
  await fs.mkdir(worktreePath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let invokedArgs;
  await executeConflictResolver({
    repository: "example/repo",
    issue: "35",
    conflict: { conflictedFiles: ["shared.txt"], targetRef: "origin/main" },
    worktreePath,
    runId: "sandbox-test",
    runner: async (_command, args) => {
      invokedArgs = args;
      return { code: 1, stderr: "fault injection" };
    }
  });
  assert.deepEqual(invokedArgs.slice(0, 3), ["exec", "--sandbox", "workspace-write"]);
  assert.equal(invokedArgs.includes("--approve-for-me"), true);
  assert.equal(invokedArgs.includes("--ignore-user-config"), true);
  assert.equal(invokedArgs.includes("--ignore-rules"), true);
  assert.equal(invokedArgs.includes("--ephemeral"), true);
  assert.equal(invokedArgs.includes("danger-full-access"), false);
});

test("textual conflict resolves, verifies target ancestry, and continues the original correction once", async (t) => {
  const fixture = await conflictFixture(t);
  const runId = "20260910020202-bbbbbb";
  let resolverCalls = 0;
  let workerCalls = 0;
  let validatorCalls = 0;
  let resolverContext;
  const result = await executeReworkRun({
    repository: "example/repo",
    defaultBranch: "main",
    work: { "35": { status: "ready", github: { title: "Resolve rework conflicts" } } }
  }, {
    repoPath: fixture.repoPath,
    sourceRunId: fixture.sourceRunId,
    runId,
    conflictResolver: async (context) => {
      resolverCalls += 1;
      resolverContext = context;
      await fs.writeFile(path.join(context.worktreePath, fixture.filename), "main change\nworker change\n");
      git(context.worktreePath, "add", fixture.filename);
      git(context.worktreePath, "-c", "core.editor=true", "rebase", "--continue");
      return { status: "resolved", exitCode: 0, report: "RESOLUTION: RESOLVED\nPreserved both lines." };
    },
    workerExecutor: async ({ worktree }) => {
      workerCalls += 1;
      await fs.writeFile(path.join(worktree.worktreePath, "correction.txt"), "validator correction\n");
      git(worktree.worktreePath, "add", "correction.txt");
      git(worktree.worktreePath, "commit", "-q", "-m", "validator correction");
      return { issue: "35", exitCode: 0, ...worktree, headSha: git(worktree.worktreePath, "rev-parse", "HEAD"), report: "corrected" };
    },
    validatorExecutor: async () => {
      validatorCalls += 1;
      return { issue: "35", exitCode: 0, verdict: "approve", report: "VERDICT: APPROVE" };
    }
  });

  assert.equal(result.status, "awaiting-review");
  assert.equal(resolverCalls, 1);
  assert.equal(workerCalls, 1);
  assert.equal(validatorCalls, 1);
  assert.equal(result.correction.attempts["35"].number, 1);
  assert.equal(result.correction.attempts["35"].outcome, "approved");
  const conflict = result.correction.attempts["35"].conflict;
  assert.equal(conflict.operationState, "completed");
  assert.equal(conflict.resolution.status, "resolved");
  assert.equal(conflict.resolution.verification.targetAncestor, true);
  assert.equal(conflict.resolution.verification.worktreeClean, true);
  assert.equal(conflict.targetSha, fixture.targetSha);
  assert.match(conflict.retainedDiff, /worker change/);
  assert.match(conflict.targetDiff, /main change/);
  assert.match(resolverContext.priorWorkerReport, /retained implementation/);
  assert.match(resolverContext.validatorReport, /Keep current-main behavior/);
  assert.equal(resolverContext.timeoutMs, 10 * 60 * 1000);
  assert.equal(git(fixture.repoPath, "merge-base", "--is-ancestor", fixture.targetSha, "HEAD"), "");
  assert.equal(git(fixture.repoPath, "status", "--porcelain"), "");
  assert.equal(await fs.readFile(path.join(fixture.repoPath, fixture.filename), "utf8"), "main change\nworker change\n");
  assert.equal((await loadPersistedRunStates(fixture.repoPath)).length, 2, "refresh recovery must not create a duplicate correction run");
  const details = formatDetails(await loadIssueDetails(fixture.repoPath, ["35"]));
  assert.match(details, /Resolver status: resolved/);
  assert.match(details, /Target ancestry verified: yes/);
  assert.match(details, /Conflicted files: shared\.txt/);
});

test("overlapping scheduler lifecycle edits preserve both current-main and retained behavior", async (t) => {
  const fixture = await conflictFixture(t, {
    filename: "scheduler.js",
    baseContent: "function advance() {\n  return selectReady();\n}\n",
    workerContent: "function advance() {\n  reserveCorrection();\n  return selectReady();\n}\n",
    mainContent: "function advance() {\n  reconcileLifecycle();\n  return selectReady();\n}\n"
  });
  const refreshed = await refreshWorker(fixture.worker, {
    repository: "example/repo",
    defaultBranch: "main",
    conflictResolver: async ({ worktreePath }) => {
      await fs.writeFile(path.join(worktreePath, fixture.filename),
        "function advance() {\n  reconcileLifecycle();\n  reserveCorrection();\n  return selectReady();\n}\n");
      git(worktreePath, "add", fixture.filename);
      git(worktreePath, "-c", "core.editor=true", "rebase", "--continue");
      return { status: "resolved", exitCode: 0, report: "RESOLUTION: RESOLVED" };
    }
  });
  assert.equal(refreshed.baseSha, fixture.targetSha);
  const content = await fs.readFile(path.join(fixture.repoPath, fixture.filename), "utf8");
  assert.match(content, /reconcileLifecycle/);
  assert.match(content, /reserveCorrection/);
  assert.equal(git(fixture.repoPath, "status", "--porcelain"), "");
});

test("resolver failure leaves the active rebase and captured evidence recoverable", async (t) => {
  const fixture = await conflictFixture(t);
  const runId = "20260910030303-cccccc";
  await assert.rejects(executeReworkRun({
    repository: "example/repo",
    defaultBranch: "main",
    work: { "35": { status: "ready" } }
  }, {
    repoPath: fixture.repoPath,
    sourceRunId: fixture.sourceRunId,
    runId,
    conflictResolver: async ({ worktreePath }) => {
      await fs.writeFile(path.join(worktreePath, fixture.filename), "partial attempted resolution\n");
      return { status: "failed", exitCode: 1, report: "RESOLUTION: FAILED\nCould not prove semantics." };
    },
    workerExecutor: async () => assert.fail("correction worker must not run")
  }), (error) => error.code === "REWORK_REFRESH_CONFLICT" && error.outcome === "human-required");

  const state = await loadRunState(fixture.repoPath, runId);
  const attempt = state.correction.attempts["35"];
  assert.equal(attempt.outcome, "human-required");
  assert.equal(attempt.conflict.operationState, "active");
  assert.deepEqual(attempt.conflict.conflictedFiles, [fixture.filename]);
  assert.equal(attempt.conflict.sourceSha, fixture.sourceSha);
  assert.equal(attempt.conflict.targetSha, fixture.targetSha);
  assert.equal(attempt.conflict.resolution.status, "failed");
  assert.equal(attempt.conflict.operationEvidence.beforeResolver.active, true);
  assert.equal(attempt.conflict.operationEvidence.verification.expectedRebasePresent, true);
  assert.equal(attempt.conflict.operationEvidence.verification.recoverable, true);
  assert.equal(git(fixture.repoPath, "rev-parse", "-q", "--verify", "REBASE_HEAD"), fixture.sourceSha);
  assert.match(git(fixture.repoPath, "status", "--porcelain"), /UU shared\.txt/);
});

test("hostile resolver abort is detected and never persisted as an active recoverable rebase", async (t) => {
  const fixture = await conflictFixture(t);
  const runId = "20260910040404-dddddd";
  let workerCalls = 0;
  await assert.rejects(executeReworkRun({
    repository: "example/repo",
    defaultBranch: "main",
    work: { "35": { status: "ready" } }
  }, {
    repoPath: fixture.repoPath,
    sourceRunId: fixture.sourceRunId,
    runId,
    conflictResolver: async ({ worktreePath }) => {
      git(worktreePath, "rebase", "--abort");
      return { status: "failed", exitCode: 1, report: "RESOLUTION: FAILED\nAborted unexpectedly." };
    },
    workerExecutor: async () => {
      workerCalls += 1;
      assert.fail("correction worker must not run");
    }
  }), (error) => {
    assert.equal(error.code, "REWORK_REFRESH_CONFLICT");
    assert.equal(error.outcome, "human-required");
    assert.match(error.message, /no longer safely active.*aborted/s);
    return true;
  });

  const state = await loadRunState(fixture.repoPath, runId);
  const attempt = state.correction.attempts["35"];
  assert.equal(workerCalls, 0);
  assert.equal(attempt.number, 1);
  assert.equal(attempt.outcome, "human-required");
  assert.equal(attempt.conflict.operationState, "aborted");
  assert.notEqual(attempt.conflict.operationState, "active");
  assert.equal(attempt.conflict.operationEvidence.beforeResolver.active, true);
  assert.equal(attempt.conflict.operationEvidence.beforeResolver.rebaseHeadSha, fixture.sourceSha);
  assert.equal(attempt.conflict.operationEvidence.beforeResolver.originalHeadSha, fixture.sourceSha);
  assert.equal(attempt.conflict.operationEvidence.beforeResolver.ontoSha, fixture.targetSha);
  assert.equal(attempt.conflict.operationEvidence.beforeResolver.headName, `refs/heads/${fixture.worker.branch}`);
  assert.equal(attempt.conflict.operationEvidence.afterResolver.active, false);
  assert.equal(attempt.conflict.operationEvidence.verification.expectedRebasePresent, false);
  assert.equal(attempt.conflict.operationEvidence.verification.recoverable, false);
  assert.deepEqual(attempt.conflict.conflictedFiles, [fixture.filename]);
  assert.equal(attempt.conflict.sourceSha, fixture.sourceSha);
  assert.equal(attempt.conflict.targetSha, fixture.targetSha);
  assert.equal((await loadPersistedRunStates(fixture.repoPath)).length, 2, "resolver failure must not create another correction generation");
  assert.equal(git(fixture.repoPath, "branch", "--show-current"), fixture.worker.branch);
  assert.equal(git(fixture.repoPath, "rev-parse", "HEAD"), fixture.sourceSha);
  const details = formatDetails(await loadIssueDetails(fixture.repoPath, ["35"]));
  assert.match(details, /Operation state: aborted/);
  assert.match(details, /Expected rebase present: no/);
  assert.match(details, /Rebase recoverable: no/);
});

test("non-content Git failures never invoke the resolver", async () => {
  let resolverCalls = 0;
  let commandCalls = 0;
  const runner = async (_command, args) => {
    commandCalls += 1;
    if (args[0] === "status") return { stdout: "" };
    if (args[0] === "fetch") throw new Error("authentication failed");
    assert.fail(`unexpected Git call: ${args.join(" ")}`);
  };
  await assert.rejects(refreshWorker({ issue: "35", worktreePath: "/tmp/not-used" }, {
    runner,
    conflictResolver: async () => { resolverCalls += 1; }
  }), /authentication failed/);
  assert.equal(commandCalls, 2);
  assert.equal(resolverCalls, 0);
});

test("a clean branch is rejected when resolver output is not based on the intended target", async (t) => {
  const fixture = await conflictFixture(t);
  await assert.rejects(refreshWorker(fixture.worker, {
    repository: "example/repo",
    defaultBranch: "main",
    conflictResolver: async ({ worktreePath }) => {
      git(worktreePath, "rebase", "--abort");
      assert.equal(git(worktreePath, "status", "--porcelain"), "");
      return { status: "resolved", exitCode: 0, report: "RESOLUTION: RESOLVED" };
    }
  }), (error) => {
    assert.equal(error.code, "REWORK_REFRESH_CONFLICT");
    assert.equal(error.outcome, "human-required");
    assert.equal(error.conflict.resolution.verification.verified, false);
    assert.match(error.conflict.resolution.verification.failure, /merge-base --is-ancestor/);
    return true;
  });
  assert.equal(git(fixture.repoPath, "status", "--porcelain"), "");
  assert.equal(git(fixture.repoPath, "rev-parse", "HEAD"), fixture.sourceSha);
});

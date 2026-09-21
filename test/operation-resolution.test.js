const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { executeAdoptedResolution } = require("../src/operation-resolution");
const { inspectGitOperation } = require("../src/git-conflict");
const { loadPersistedRunStates, saveRunState } = require("../src/run-store");
const { reserveExplicitWork } = require("../src/scheduler");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-adopt-resolution-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Maestro Test");
  git(root, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(root, "shared.txt"), "base\n");
  await fs.writeFile(path.join(root, "local.txt"), "clean local\n");
  git(root, "add", "shared.txt", "local.txt");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  await fs.writeFile(path.join(root, "shared.txt"), "feature\n");
  git(root, "commit", "-qam", "feature behavior");
  const sourceSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  await fs.writeFile(path.join(root, "shared.txt"), "main\n");
  git(root, "commit", "-qam", "main behavior");
  const targetSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "feature");
  return { root, sourceSha, targetSha };
}

test("explicit adoption preserves partial merge resolution and unrelated untracked state", async (t) => {
  const fixture = await repository(t);
  const attempted = spawnSync("git", ["merge", "main"], { cwd: fixture.root, encoding: "utf8" });
  assert.notEqual(attempted.status, 0);
  await fs.writeFile(path.join(fixture.root, "shared.txt"), "main\nfeature\n");
  git(fixture.root, "add", "shared.txt");
  await fs.writeFile(path.join(fixture.root, "local.txt"), "dirty local\n");
  await fs.writeFile(path.join(fixture.root, "notes.local"), "do not touch\n");

  let resolverCalls = 0;
  const state = await executeAdoptedResolution({
    repository: "example/repo",
    resolution: { commands: ["npm test"] },
    work: {}
  }, {
    repoPath: fixture.root,
    runId: "20260920010101-aaaaaa",
    resolver: async ({ conflict, worktreePath }) => {
      resolverCalls += 1;
      assert.equal(conflict.operation, "merge");
      assert.equal(await fs.readFile(path.join(worktreePath, "shared.txt"), "utf8"), "main\nfeature\n");
      git(worktreePath, "-c", "core.editor=true", "merge", "--continue");
      return { status: "resolved", exitCode: 0, report: "RESOLUTION: RESOLVED" };
    },
    shellRunner: async () => ({ code: 0, stdout: "all pass", stderr: "" })
  });

  assert.equal(resolverCalls, 1);
  assert.equal(state.status, "validated");
  assert.equal(state.resolution.conflict.operationOwner, "user");
  assert.equal(state.resolution.conflict.operationState, "completed");
  assert.equal(state.resolution.validation.results[0].code, 0);
  assert.equal(await fs.readFile(path.join(fixture.root, "notes.local"), "utf8"), "do not touch\n");
  assert.equal(await fs.readFile(path.join(fixture.root, "local.txt"), "utf8"), "dirty local\n");
  assert.equal(await inspectGitOperation(fixture.root).then((entry) => entry.operationActive), false);
  assert.equal(git(fixture.root, "merge-base", "--is-ancestor", fixture.sourceSha, "HEAD"), "");
  assert.equal(git(fixture.root, "merge-base", "--is-ancestor", fixture.targetSha, "HEAD"), "");
  assert.equal(state.resolution.conflict.preservation.recoveryArtifacts.length, 1);
  const artifact = JSON.parse(await fs.readFile(state.resolution.conflict.preservation.recoveryArtifacts[0], "utf8"));
  const untracked = artifact.pathStates.find((entry) => entry.path === "notes.local");
  assert.equal(Buffer.from(untracked.workingTree.contentBase64, "base64").toString(), "do not touch\n");
});

test("same-status tracked and untracked content mutations fail preservation verification", async (t) => {
  const fixture = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: fixture.root }).status, 0);
  await fs.writeFile(path.join(fixture.root, "local.txt"), "dirty before\n");
  await fs.writeFile(path.join(fixture.root, "notes.local"), "notes before\n");

  await assert.rejects(executeAdoptedResolution({
    repository: "example/repo", defaultConcurrency: 1, resolution: { commands: ["npm test"] }, work: {}
  }, {
    repoPath: fixture.root,
    runId: "20260920011111-a1a1a1",
    resolver: async ({ worktreePath }) => {
      await fs.writeFile(path.join(worktreePath, "shared.txt"), "main\nfeature\n");
      git(worktreePath, "add", "shared.txt");
      await fs.writeFile(path.join(worktreePath, "local.txt"), "dirty after\n");
      await fs.writeFile(path.join(worktreePath, "notes.local"), "notes after\n");
      git(worktreePath, "-c", "core.editor=true", "merge", "--continue");
      return { status: "resolved", exitCode: 0 };
    },
    shellRunner: async () => ({ code: 0, stdout: "pass", stderr: "" })
  }), /changed unrelated staged, unstaged, or untracked user state/);

  const [state] = (await loadPersistedRunStates(fixture.root)).filter((entry) => entry.mode === "resolve");
  assert.equal(state.status, "human-required");
  assert.deepEqual(state.capacity.issues, []);
});

test("resolver errors consume a persisted attempt and resume with the next charged attempt", async (t) => {
  const fixture = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: fixture.root }).status, 0);
  const runId = "20260920012121-a2a2a2";
  const config = { repository: "example/repo", defaultConcurrency: 1, resolution: { commands: ["npm test"] }, work: {} };

  await assert.rejects(executeAdoptedResolution(config, {
    repoPath: fixture.root,
    runId,
    resolver: async () => {
      const persisted = (await loadPersistedRunStates(fixture.root)).find((entry) => entry.runId === runId);
      assert.equal(persisted.resolution.attempts.length, 1);
      assert.equal(persisted.resolution.attempts[0].status, "running");
      assert.equal(persisted.capacity.issues.length, 1);
      const contention = await reserveExplicitWork({
        repository: "example/repo",
        defaultConcurrency: 1,
        work: { "88": { status: "ready", blockedBy: [], requires: [] } }
      }, {
        repoPath: fixture.root,
        runId: "20260920012122-b2b2b2",
        mode: "execute",
        items: [{ id: "88" }]
      });
      assert.equal(contention.reserved, false);
      assert.equal(contention.reason, "exhausted");
      throw new Error("resolver crashed");
    }
  }), /resolver crashed/);
  let persisted = (await loadPersistedRunStates(fixture.root)).find((entry) => entry.runId === runId);
  assert.equal(persisted.resolution.attempts[0].failureKind, "resolver-error");
  assert.deepEqual(persisted.capacity.issues, []);

  const resumed = await executeAdoptedResolution(config, {
    repoPath: fixture.root,
    continueExisting: true,
    resolver: async ({ worktreePath }) => {
      await fs.writeFile(path.join(worktreePath, "shared.txt"), "main\nfeature\n");
      git(worktreePath, "add", "shared.txt");
      git(worktreePath, "-c", "core.editor=true", "merge", "--continue");
      return { status: "resolved", exitCode: 0 };
    },
    shellRunner: async () => ({ code: 0, stdout: "pass", stderr: "" })
  });
  assert.equal(resumed.resolution.attempts.length, 2);
  assert.equal(resumed.resolution.attempts[1].number, 2);
  assert.deepEqual(resumed.capacity.issues, []);
});

test("resume retains the charge from a resolver process that exited without reporting", async (t) => {
  const fixture = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: fixture.root }).status, 0);
  const runId = "20260920012525-a25a25";
  const config = { repository: "example/repo", defaultConcurrency: 1, resolution: { commands: ["npm test"] }, work: {} };
  const interrupted = await executeAdoptedResolution(config, {
    repoPath: fixture.root,
    runId,
    resolver: async () => ({ status: "failed", exitCode: 1 })
  });
  Object.assign(interrupted.resolution.attempts[0], { status: "running", processId: 2147483647 });
  interrupted.status = "resolving";
  interrupted.capacity.issues = [`adopt-${runId}`];
  await saveRunState(fixture.root, runId, interrupted);

  const resumed = await executeAdoptedResolution(config, {
    repoPath: fixture.root,
    continueExisting: true,
    resolver: async ({ worktreePath }) => {
      await fs.writeFile(path.join(worktreePath, "shared.txt"), "main\nfeature\n");
      git(worktreePath, "add", "shared.txt");
      git(worktreePath, "-c", "core.editor=true", "merge", "--continue");
      return { status: "resolved", exitCode: 0 };
    },
    shellRunner: async () => ({ code: 0, stdout: "pass", stderr: "" })
  });
  assert.equal(resumed.resolution.attempts[0].status, "interrupted");
  assert.equal(resumed.resolution.attempts[0].failureKind, "resolver-process-exited");
  assert.equal(resumed.resolution.attempts[1].number, 2);
  assert.deepEqual(resumed.capacity.issues, []);
});

test("standalone adoption respects repository capacity contention", async (t) => {
  const fixture = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: fixture.root }).status, 0);
  await saveRunState(fixture.root, "20260920013131-a3a3a3", {
    runId: "20260920013131-a3a3a3",
    mode: "execute",
    status: "running",
    plan: { selected: [{ id: "99" }] },
    workers: [], validations: [], reviews: {},
    capacity: { scope: "repository", limit: 1, issues: ["99"] }
  });
  let resolverCalls = 0;
  await assert.rejects(executeAdoptedResolution({
    repository: "example/repo",
    defaultConcurrency: 1,
    resolution: { commands: ["npm test"] },
    work: { "99": { status: "ready", blockedBy: [], requires: [] } }
  }, {
    repoPath: fixture.root,
    runId: "20260920014141-a4a4a4",
    resolver: async () => { resolverCalls += 1; }
  }), /capacity.*exhausted/);
  assert.equal(resolverCalls, 0);
  assert.equal((await loadPersistedRunStates(fixture.root)).some((entry) => entry.runId === "20260920014141-a4a4a4"), false);
});

test("issue-associated adoption fails closed at manifest and persisted human gates", async (t) => {
  const manifestGate = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: manifestGate.root }).status, 0);
  await assert.rejects(executeAdoptedResolution({
    repository: "example/repo",
    resolution: { commands: ["npm test"] },
    work: { "7": { status: "human_gate", blockedBy: [], requires: [] } }
  }, {
    repoPath: manifestGate.root,
    issue: "7",
    resolver: async () => assert.fail("human gate must block the resolver")
  }), /current human gate/);

  const lifecycleGate = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: lifecycleGate.root }).status, 0);
  await saveRunState(lifecycleGate.root, "20260920015151-a5a5a5", {
    runId: "20260920015151-a5a5a5",
    mode: "execute",
    status: "review",
    plan: { selected: [{ id: "7" }] },
    workers: [],
    validations: [{ issue: "7", exitCode: 0, verdict: "human_gate", report: "VERDICT: HUMAN_GATE" }],
    reviews: {}
  });
  await assert.rejects(executeAdoptedResolution({
    repository: "example/repo",
    resolution: { commands: ["npm test"] },
    work: { "7": { status: "ready", blockedBy: [], requires: [] } }
  }, {
    repoPath: lifecycleGate.root,
    issue: "7",
    resolver: async () => assert.fail("persisted human gate must block the resolver")
  }), /current lifecycle ownership \(awaiting-human-review\)/);
});

test("eligible issue association is atomically admitted and reserved under that issue", async (t) => {
  const fixture = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: fixture.root }).status, 0);
  const runId = "20260920015555-a55a55";
  const state = await executeAdoptedResolution({
    repository: "example/repo",
    defaultConcurrency: 1,
    resolution: { commands: ["npm test"] },
    work: { "7": { status: "ready", blockedBy: [], requires: [] } }
  }, {
    repoPath: fixture.root,
    runId,
    issue: "7",
    resolver: async ({ worktreePath }) => {
      const active = (await loadPersistedRunStates(fixture.root)).find((entry) => entry.runId === runId);
      assert.deepEqual(active.capacity.issues, ["7"]);
      await fs.writeFile(path.join(worktreePath, "shared.txt"), "main\nfeature\n");
      git(worktreePath, "add", "shared.txt");
      git(worktreePath, "-c", "core.editor=true", "merge", "--continue");
      return { status: "resolved", exitCode: 0 };
    },
    shellRunner: async () => ({ code: 0, stdout: "pass", stderr: "" })
  });
  assert.equal(state.status, "validated");
  assert.deepEqual(state.capacity.issues, []);
});

test("timeout and attempt exhaustion remain charged and release capacity", async (t) => {
  const timedOut = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: timedOut.root }).status, 0);
  const timeoutState = await executeAdoptedResolution({
    repository: "example/repo",
    defaultConcurrency: 1,
    resolution: { commands: ["npm test"], timeoutMs: -1 },
    work: {}
  }, {
    repoPath: timedOut.root,
    runId: "20260920016161-a6a6a6",
    resolver: async () => assert.fail("expired handoff must not invoke resolver")
  });
  assert.equal(timeoutState.status, "human-required");
  assert.equal(timeoutState.resolution.attempts.length, 0);

  const exhausted = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: exhausted.root }).status, 0);
  const config = {
    repository: "example/repo",
    defaultConcurrency: 1,
    resolution: { commands: ["npm test"], maxAttempts: 1 },
    work: {}
  };
  const first = await executeAdoptedResolution(config, {
    repoPath: exhausted.root,
    runId: "20260920017171-a7a7a7",
    resolver: async () => ({ status: "failed", exitCode: 1 })
  });
  assert.equal(first.resolution.attempts.length, 1);
  assert.deepEqual(first.capacity.issues, []);
  await assert.rejects(executeAdoptedResolution(config, {
    repoPath: exhausted.root,
    continueExisting: true,
    resolver: async () => assert.fail("exhausted handoff must not invoke resolver")
  }), /attempt limit \(1\) exhausted/);
  const persisted = (await loadPersistedRunStates(exhausted.root)).find((entry) => entry.runId === first.runId);
  assert.equal(persisted.resolution.attempts.length, 1);
  assert.deepEqual(persisted.capacity.issues, []);
});

test("failed standalone validation persists evidence and releases capacity", async (t) => {
  const fixture = await repository(t);
  assert.notEqual(spawnSync("git", ["merge", "main"], { cwd: fixture.root }).status, 0);
  await assert.rejects(executeAdoptedResolution({
    repository: "example/repo", defaultConcurrency: 1, resolution: { commands: ["npm test"] }, work: {}
  }, {
    repoPath: fixture.root,
    runId: "20260920018181-a8a8a8",
    resolver: async ({ worktreePath }) => {
      await fs.writeFile(path.join(worktreePath, "shared.txt"), "main\nfeature\n");
      git(worktreePath, "add", "shared.txt");
      git(worktreePath, "-c", "core.editor=true", "merge", "--continue");
      return { status: "resolved", exitCode: 0 };
    },
    shellRunner: async () => {
      const active = (await loadPersistedRunStates(fixture.root)).find((entry) => entry.runId === "20260920018181-a8a8a8");
      assert.equal(active.capacity.issues.length, 1);
      return { code: 1, stdout: "", stderr: "failed check" };
    }
  }), /standalone resolution validation failed/);
  const persisted = (await loadPersistedRunStates(fixture.root)).find((entry) => entry.runId === "20260920018181-a8a8a8");
  assert.equal(persisted.status, "validation-failed");
  assert.equal(persisted.resolution.validation.status, "failed");
  assert.deepEqual(persisted.capacity.issues, []);
});

test("failed adopted resolver resumes the same run after manual completion", async (t) => {
  const fixture = await repository(t);
  const attempted = spawnSync("git", ["rebase", "main"], { cwd: fixture.root, encoding: "utf8" });
  assert.notEqual(attempted.status, 0);
  const runId = "20260920020202-bbbbbb";
  const config = { repository: "example/repo", resolution: { commands: ["npm test"] }, work: {} };
  const first = await executeAdoptedResolution(config, {
    repoPath: fixture.root,
    runId,
    resolver: async ({ worktreePath }) => {
      await fs.writeFile(path.join(worktreePath, "shared.txt"), "partial manual progress\n");
      return { status: "failed", exitCode: 1, report: "RESOLUTION: FAILED" };
    }
  });
  assert.equal(first.status, "human-required");
  assert.equal((await inspectGitOperation(fixture.root)).operationActive, true);
  await fs.writeFile(path.join(fixture.root, "shared.txt"), "main\nfeature\n");
  git(fixture.root, "add", "shared.txt");
  git(fixture.root, "-c", "core.editor=true", "rebase", "--continue");

  const resumed = await executeAdoptedResolution(config, {
    repoPath: fixture.root,
    continueExisting: true,
    resolver: async () => assert.fail("completed manual resolution must not launch another agent"),
    shellRunner: async () => ({ code: 0, stdout: "pass", stderr: "" })
  });
  assert.equal(resumed.runId, runId);
  assert.equal(resumed.status, "validated");
  assert.equal((await loadPersistedRunStates(fixture.root)).filter((entry) => entry.mode === "resolve").length, 1);
});

test("standalone adoption rejects unsupported operations and absent validation policy", async (t) => {
  const fixture = await repository(t);
  let attempted = spawnSync("git", ["merge", "main"], { cwd: fixture.root, encoding: "utf8" });
  assert.notEqual(attempted.status, 0);
  await assert.rejects(executeAdoptedResolution({ repository: "example/repo", work: {} }, {
    repoPath: fixture.root,
    resolver: async () => assert.fail("resolver must not run")
  }), /requires at least one validation command/);
  git(fixture.root, "merge", "--abort");

  git(fixture.root, "checkout", "-q", "main");
  const featureCommit = git(fixture.root, "rev-parse", "feature");
  attempted = spawnSync("git", ["cherry-pick", featureCommit], { cwd: fixture.root, encoding: "utf8" });
  assert.notEqual(attempted.status, 0);
  await assert.rejects(executeAdoptedResolution({
    repository: "example/repo", resolution: { commands: ["npm test"] }, work: {}
  }, {
    repoPath: fixture.root,
    resolver: async () => assert.fail("resolver must not run")
  }), /cherry-pick adoption is not supported/);
  assert.equal((await inspectGitOperation(fixture.root)).operation, "cherry-pick");
  git(fixture.root, "cherry-pick", "--abort");
});

test("one adopted resolver invocation completes every conflict step in a multi-commit rebase", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-adopt-multistep-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Maestro Test");
  git(root, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(root, "one.txt"), "base one\n");
  await fs.writeFile(path.join(root, "two.txt"), "base two\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  await fs.writeFile(path.join(root, "one.txt"), "feature one\n");
  git(root, "commit", "-qam", "feature one");
  await fs.writeFile(path.join(root, "two.txt"), "feature two\n");
  git(root, "commit", "-qam", "feature two");
  git(root, "checkout", "-q", "main");
  await fs.writeFile(path.join(root, "one.txt"), "main one\n");
  await fs.writeFile(path.join(root, "two.txt"), "main two\n");
  git(root, "commit", "-qam", "main changes");
  const targetSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "feature");
  const attempted = spawnSync("git", ["rebase", "main"], { cwd: root, encoding: "utf8" });
  assert.notEqual(attempted.status, 0);
  let steps = 0;

  const state = await executeAdoptedResolution({
    repository: "example/repo", resolution: { commands: ["npm test"] }, work: {}
  }, {
    repoPath: root,
    runId: "20260920040404-dddddd",
    resolver: async ({ worktreePath }) => {
      while ((await inspectGitOperation(worktreePath)).operationActive) {
        const operation = await inspectGitOperation(worktreePath);
        assert.equal(operation.operation, "rebase");
        for (const file of operation.conflictedFiles) {
          await fs.writeFile(path.join(worktreePath, file), `${file.startsWith("one") ? "main one\nfeature one" : "main two\nfeature two"}\n`);
          git(worktreePath, "add", file);
        }
        const continued = spawnSync("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: worktreePath, encoding: "utf8" });
        if (continued.status !== 0) {
          assert.equal((await inspectGitOperation(worktreePath)).operationActive, true, continued.stderr);
        }
        steps += 1;
      }
      return { status: "resolved", exitCode: 0, report: "RESOLUTION: RESOLVED" };
    },
    shellRunner: async () => ({ code: 0, stdout: "pass", stderr: "" })
  });

  assert.equal(steps, 2);
  assert.equal(state.status, "validated");
  assert.equal(git(root, "merge-base", "--is-ancestor", targetSha, "HEAD"), "");
  assert.match(await fs.readFile(path.join(root, "one.txt"), "utf8"), /main one\nfeature one/);
  assert.match(await fs.readFile(path.join(root, "two.txt"), "utf8"), /main two\nfeature two/);
});

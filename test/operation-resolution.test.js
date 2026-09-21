const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { executeAdoptedResolution } = require("../src/operation-resolution");
const { inspectGitOperation } = require("../src/git-conflict");
const { loadPersistedRunStates } = require("../src/run-store");

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
  git(root, "add", "shared.txt");
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
  assert.equal(await inspectGitOperation(fixture.root).then((entry) => entry.operationActive), false);
  assert.equal(git(fixture.root, "merge-base", "--is-ancestor", fixture.sourceSha, "HEAD"), "");
  assert.equal(git(fixture.root, "merge-base", "--is-ancestor", fixture.targetSha, "HEAD"), "");
  assert.equal(state.resolution.conflict.preservation.recoveryArtifacts.length, 1);
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

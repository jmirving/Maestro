const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  failureSignatures,
  isAcceptedBaselineFailure,
  withPreservedManifest,
  integrateApproved
} = require("../src/integrator");

function git(repoPath, ...args) {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-integrator-test-"));
  git(repoPath, "init", "-q");
  git(repoPath, "config", "user.name", "Maestro Test");
  git(repoPath, "config", "user.email", "maestro@example.test");
  fs.writeFileSync(path.join(repoPath, "README.md"), "base\n");
  git(repoPath, "add", "README.md");
  git(repoPath, "commit", "-qm", "base");
  return repoPath;
}

test("failureSignatures ignores TAP ordinal and timing noise", () => {
  const first = `not ok 53 - focuses the requested inbox item\n# error: timeout after 5000ms\n# duration_ms: 5004.21`;
  const second = `not ok 54 - focuses the requested inbox item\n# error: timeout after 5000ms\n# duration_ms: 5011.92`;
  assert.deepEqual(failureSignatures(first), ["tap:focuses the requested inbox item"]);
  assert.deepEqual(failureSignatures(second), ["tap:focuses the requested inbox item"]);
});

test("accepted baseline failure requires the same failing test identities", () => {
  const baseline = {
    allowFailing: true,
    results: [{ command: "npm run verify", code: 1, stdout: "not ok 53 - focuses the requested inbox item", stderr: "" }]
  };
  assert.equal(isAcceptedBaselineFailure({
    baseline,
    command: "npm run verify",
    result: { code: 1, stdout: "not ok 54 - focuses the requested inbox item", stderr: "" }
  }), true);
  assert.equal(isAcceptedBaselineFailure({
    baseline,
    command: "npm run verify",
    result: { code: 1, stdout: "not ok 54 - focuses the requested inbox item\nnot ok 55 - another regression", stderr: "" }
  }), false);
});

test("falls back to normalized error fingerprint when no test identity is available", () => {
  const baseline = {
    allowFailing: true,
    results: [{ command: "custom", code: 1, stdout: "", stderr: "Error: service unavailable" }]
  };
  assert.equal(isAcceptedBaselineFailure({
    baseline,
    command: "custom",
    result: { code: 1, stdout: "", stderr: "Error: service unavailable" }
  }), true);
});

test("preserves an untracked manifest while integration runs with a clean tree", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  const original = '{"work":{"13":{"status":"ready"}}}\n';
  fs.writeFileSync(manifestPath, original);

  await withPreservedManifest({ repoPath, manifestPath }, async () => {
    assert.equal(fs.existsSync(manifestPath), false);
    assert.equal(git(repoPath, "status", "--porcelain"), "");
  });

  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
  assert.equal(git(repoPath, "status", "--porcelain"), "?? .maestro.json");
  assert.equal(git(repoPath, "stash", "list"), "");
});

test("preserves an ignored manifest while integration runs with a clean tree", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  const original = '{"work":{"13":{"status":"ready","notes":"keep me"}}}\n';
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".maestro.json\n");
  git(repoPath, "add", ".gitignore");
  git(repoPath, "commit", "-qm", "ignore manifest");
  fs.writeFileSync(manifestPath, original);

  await withPreservedManifest({ repoPath, manifestPath }, async () => {
    assert.equal(fs.existsSync(manifestPath), false);
    assert.equal(git(repoPath, "status", "--porcelain"), "");
  });

  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
  assert.equal(git(repoPath, "status", "--porcelain", "--ignored=matching", "--", ".maestro.json"), "!! .maestro.json");
  assert.equal(git(repoPath, "stash", "list"), "");
});

test("leaves a tracked clean manifest available during integration", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, "tracked\n");
  git(repoPath, "add", ".maestro.json");
  git(repoPath, "commit", "-qm", "track manifest");

  await withPreservedManifest({ repoPath, manifestPath }, async () => {
    assert.equal(fs.readFileSync(manifestPath, "utf8"), "tracked\n");
    assert.equal(git(repoPath, "status", "--porcelain"), "");
  });

  assert.equal(git(repoPath, "status", "--porcelain"), "");
});

test("restores tracked manifest index and working-tree edits exactly", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, "base\n");
  git(repoPath, "add", ".maestro.json");
  git(repoPath, "commit", "-qm", "track manifest");
  fs.writeFileSync(manifestPath, "staged user edit\n");
  git(repoPath, "add", ".maestro.json");
  fs.writeFileSync(manifestPath, "unstaged user edit\n");

  await withPreservedManifest({ repoPath, manifestPath }, async () => {
    assert.equal(fs.readFileSync(manifestPath, "utf8"), "base\n");
    assert.equal(git(repoPath, "status", "--porcelain"), "");
  });

  assert.equal(git(repoPath, "show", ":.maestro.json"), "staged user edit");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "unstaged user edit\n");
  assert.equal(git(repoPath, "status", "--porcelain"), "MM .maestro.json");
  assert.equal(git(repoPath, "stash", "list"), "");
});

test("rejects unrelated dirty state without changing the manifest", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, "manifest edit\n");
  fs.writeFileSync(path.join(repoPath, "README.md"), "unrelated edit\n");
  let operated = false;

  await assert.rejects(
    withPreservedManifest({ repoPath, manifestPath }, async () => { operated = true; }),
    /changes outside the resolved Maestro manifest.*README\.md/s
  );
  assert.equal(operated, false);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "manifest edit\n");
  assert.equal(git(repoPath, "stash", "list"), "");
});

test("restores manifest state when integration fails", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, "recover me\n");

  await assert.rejects(
    withPreservedManifest({ repoPath, manifestPath }, async () => { throw new Error("merge failed"); }),
    /merge failed/
  );
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "recover me\n");
  assert.equal(git(repoPath, "status", "--porcelain"), "?? .maestro.json");
  assert.equal(git(repoPath, "stash", "list"), "");
});

test("keeps the recovery stash when incoming work conflicts with manifest edits", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, "base\n");
  git(repoPath, "add", ".maestro.json");
  git(repoPath, "commit", "-qm", "track manifest");
  fs.writeFileSync(manifestPath, "local progress\n");

  await assert.rejects(withPreservedManifest({ repoPath, manifestPath }, async () => {
    fs.writeFileSync(manifestPath, "incoming progress\n");
    git(repoPath, "add", ".maestro.json");
    git(repoPath, "commit", "-qm", "incoming manifest change");
  }), /original state remains recoverable in Git stash [a-f0-9]+/);

  assert.match(git(repoPath, "stash", "list"), /maestro: preserve manifest during integration/);
  assert.match(git(repoPath, "status", "--porcelain"), /UU \.maestro\.json/);
});

test("keeps an ignored manifest recoverable when incoming work claims its path", async () => {
  const repoPath = repository();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".maestro.json\n");
  git(repoPath, "add", ".gitignore");
  git(repoPath, "commit", "-qm", "ignore manifest");
  fs.writeFileSync(manifestPath, "ignored local manifest\n");

  await assert.rejects(withPreservedManifest({ repoPath, manifestPath }, async () => {
    fs.writeFileSync(manifestPath, "incoming tracked manifest\n");
    git(repoPath, "add", "--force", ".maestro.json");
    git(repoPath, "commit", "-qm", "incoming manifest");
  }), /original state remains recoverable in Git stash [a-f0-9]+/);

  assert.equal(fs.readFileSync(manifestPath, "utf8"), "incoming tracked manifest\n");
  assert.equal(git(repoPath, "show", "stash@{0}^3:.maestro.json"), "ignored local manifest");
  assert.match(git(repoPath, "stash", "list"), /maestro: preserve manifest during integration/);
});

test("rejects worker branches that change the manifest before merging", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === "diff") return { code: 0, stdout: ".maestro.json\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(integrateApproved({
    config: { defaultBranch: "main", integration: { enabled: true } },
    repoPath: "/target",
    manifestPath: "/target/.maestro.json",
    workers: [{ issue: "13", branch: "worker/13", worktreePath: "/worker", exitCode: 0 }],
    validations: [{ issue: "13", verdict: "approve" }],
    reviewAuthorizations: [{ issue: "13", review: { disposition: "approve" } }],
    runner
  }), /Worker branch worker\/13 changes the Maestro manifest/);

  assert.equal(calls.some((call) => call.args[0] === "merge"), false);
});

test("integrates an audited validator override while excluding unreviewed REWORK work", async () => {
  const calls = [];
  let revision = 0;
  const runner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-parse" && options.cwd === "/worker/7") return { code: 0, stdout: "worker-head\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `sha-${revision += 1}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const override = {
    disposition: "approve-override",
    validatorOverride: { verdict: "rework", exitCode: 1, report: "override me" }
  };

  const results = await integrateApproved({
    config: { defaultBranch: "main", integration: { enabled: true } },
    repoPath: "/target",
    workers: [
      { issue: "7", branch: "worker/7", worktreePath: "/worker/7", exitCode: 0 },
      { issue: "8", branch: "worker/8", worktreePath: "/worker/8", exitCode: 0 }
    ],
    validations: [
      { issue: "7", verdict: "rework", exitCode: 1, report: "override me" },
      { issue: "8", verdict: "rework", exitCode: 1, report: "not reviewed" }
    ],
    reviewAuthorizations: [{ issue: "7", review: override }],
    runner
  });

  assert.deepEqual(results.map((entry) => entry.issue), ["7"]);
  assert.deepEqual(calls.filter((call) => call.args[0] === "merge").map((call) => call.args.at(-1)), ["worker/7"]);
  assert.equal(calls.some((call) => call.args.includes("worker/8")), false);
});

test("approve-with-follow-up remains a valid supervised integration disposition", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "worker-head\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await integrateApproved({
    config: { defaultBranch: "main", integration: { enabled: true, closeIssues: false } },
    repoPath: "/target",
    workers: [{ issue: "25", branch: "worker/25", worktreePath: "/worker/25", exitCode: 0 }],
    validations: [{ issue: "25", verdict: "approve", exitCode: 0 }],
    reviewAuthorizations: [{ issue: "25", review: { disposition: "approve-with-follow-up", recordedAt: "2026-09-21T00:00:00Z" } }],
    runner
  });
  assert.deepEqual(result.map((entry) => entry.issue), ["25"]);
  assert.equal(result[0].authorization.kind, "human-review");
  assert.equal(calls.some((call) => call.args[0] === "merge"), true);
  assert.equal(calls.some((call) => call.command === "gh" && call.args[1] === "close"), false);
});

test("integration refresh persists the shared conflict contract before aborting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-integration-conflict-"));
  const originPath = path.join(root, "origin.git");
  const repoPath = path.join(root, "target");
  const workerPath = path.join(root, "worker");
  fs.mkdirSync(repoPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", "-q", originPath);
  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.name", "Maestro Test");
  git(repoPath, "config", "user.email", "maestro@example.test");
  fs.writeFileSync(path.join(repoPath, "shared.txt"), "base\n");
  git(repoPath, "add", "shared.txt");
  git(repoPath, "commit", "-qm", "base");
  const baseSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "remote", "add", "origin", originPath);
  git(repoPath, "push", "-q", "-u", "origin", "main");
  git(repoPath, "worktree", "add", "-q", "-b", "worker/19", workerPath);
  fs.writeFileSync(path.join(workerPath, "shared.txt"), "worker\n");
  git(workerPath, "commit", "-qam", "worker change");
  fs.writeFileSync(path.join(repoPath, "shared.txt"), "main\n");
  git(repoPath, "commit", "-qam", "main change");
  git(repoPath, "push", "-q", "origin", "main");

  let persisted = null;
  await assert.rejects(integrateApproved({
    config: { repository: "example/repo", defaultBranch: "main", integration: { enabled: true } },
    repoPath,
    workers: [{ issue: "19", branch: "worker/19", worktreePath: workerPath, baseSha, exitCode: 0 }],
    validations: [{ issue: "19", verdict: "approve" }],
    reviewAuthorizations: [{ issue: "19", review: { disposition: "approve" } }],
    sourceRunId: "run-source",
    onConflict: async (conflict) => { persisted = JSON.parse(JSON.stringify(conflict)); }
  }), (error) => error.code === "GIT_CONTENT_CONFLICT");

  assert.equal(persisted.operationState, "aborted");
  assert.equal(persisted.interruptedStage, "integration-refresh");
  assert.deepEqual(persisted.conflictedFiles, ["shared.txt"]);
  assert.equal(persisted.continuationAction, "maestro reconcile 19");
  assert.equal(git(workerPath, "status", "--porcelain"), "");
});

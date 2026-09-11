const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadRunState, saveRunState } = require("../src/run-store");

function git(repoPath, ...args) {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runCli(repoPath, manifestPath, command, ...args) {
  const cli = path.resolve(__dirname, "../bin/maestro.js");
  return spawnSync(process.execPath, [cli, command, manifestPath, ...args, "--repo-path", repoPath], {
    cwd: repoPath,
    encoding: "utf8"
  });
}

test("approve --override followed by commit merges and records validator-REWORK work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-override-integration-"));
  const repoPath = path.join(root, "target");
  const remotePath = path.join(root, "remote.git");
  const workerPath = path.join(root, "worker-7");
  const manifestPath = path.join(repoPath, ".maestro.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(repoPath);
  fs.mkdirSync(remotePath);
  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.name", "Maestro Test");
  git(repoPath, "config", "user.email", "maestro@example.test");
  fs.writeFileSync(path.join(repoPath, "README.md"), "base\n");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    repository: "example/repo",
    defaultBranch: "main",
    integration: { enabled: false },
    work: { "7": { status: "ready" } }
  }, null, 2)}\n`);
  git(repoPath, "add", "README.md", ".maestro.json");
  git(repoPath, "commit", "-qm", "base");
  git(remotePath, "init", "--bare", "-q");
  git(repoPath, "remote", "add", "origin", remotePath);
  git(repoPath, "push", "-u", "origin", "main");

  git(repoPath, "worktree", "add", "-q", "-b", "maestro/7", workerPath, "main");
  fs.writeFileSync(path.join(workerPath, "issue-7.txt"), "accepted override\n");
  git(workerPath, "add", "issue-7.txt");
  git(workerPath, "commit", "-qm", "implement issue 7");
  const workerSha = git(workerPath, "rev-parse", "HEAD");

  const runId = "20260911010101-aaaaaa";
  const validator = { issue: "7", verdict: "rework", exitCode: 1, report: "VERDICT: REWORK\nHuman review requested." };
  await saveRunState(repoPath, runId, {
    runId,
    mode: "execute",
    status: "awaiting-review",
    workers: [{
      issue: "7",
      exitCode: 0,
      baseSha: git(repoPath, "rev-parse", "main"),
      headSha: workerSha,
      branch: "maestro/7",
      worktreePath: workerPath
    }],
    validations: [validator],
    reviews: {}
  });

  const approval = runCli(repoPath, manifestPath, "approve", "7", "--override");
  assert.equal(approval.status, 0, approval.stderr);
  assert.match(approval.stdout, /Override-approved: #7/);

  const commit = runCli(repoPath, manifestPath, "commit", "--run", runId);
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stdout, /Committed Maestro run .*#7/);
  assert.match(commit.stdout, /Advanced .*#7/);
  assert.equal(fs.readFileSync(path.join(repoPath, "issue-7.txt"), "utf8"), "accepted override\n");
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).work["7"].status, "complete");

  const saved = await loadRunState(repoPath, runId);
  assert.equal(saved.reviews["7"].disposition, "approve-override");
  assert.deepEqual(saved.reviews["7"].validatorOverride, {
    verdict: validator.verdict,
    exitCode: validator.exitCode,
    report: validator.report
  });
  assert.equal(saved.integration.length, 1);
  assert.equal(String(saved.integration[0].issue), "7");
  assert.equal(saved.integration[0].integratedSha, workerSha);
  assert.equal(git(repoPath, "show", "origin/main:issue-7.txt"), "accepted override");
  assert.equal(JSON.parse(git(repoPath, "show", "origin/main:.maestro.json")).work["7"].status, "complete");
});

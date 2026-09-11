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

function runCommit(repoPath, manifestPath, ...args) {
  const cli = path.resolve(__dirname, "../bin/maestro.js");
  return spawnSync(process.execPath, [cli, "commit", manifestPath, ...args, "--repo-path", repoPath], {
    cwd: repoPath,
    encoding: "utf8"
  });
}

test("plain commit resumes the historical partially integrated run contract without duplicating work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-partial-integration-"));
  const repoPath = path.join(root, "target");
  const remotePath = path.join(root, "remote.git");
  const worker8Path = path.join(root, "worker-8");
  const worker13Path = path.join(root, "worker-13");
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
    work: {
      "8": { status: "complete", priority: 10 },
      "13": { status: "ready", priority: 20 }
    }
  }, null, 2)}\n`);
  git(repoPath, "add", "README.md", ".maestro.json");
  git(repoPath, "commit", "-qm", "base");
  git(remotePath, "init", "--bare", "-q");
  git(repoPath, "remote", "add", "origin", remotePath);
  git(repoPath, "push", "-u", "origin", "main");

  git(repoPath, "worktree", "add", "-q", "-b", "maestro/8", worker8Path, "main");
  fs.writeFileSync(path.join(worker8Path, "issue-8.txt"), "integrated first\n");
  git(worker8Path, "add", "issue-8.txt");
  git(worker8Path, "commit", "-qm", "implement issue 8");
  const issue8Sha = git(worker8Path, "rev-parse", "HEAD");
  git(repoPath, "merge", "--ff-only", "maestro/8");
  git(repoPath, "push", "origin", "main");

  git(repoPath, "worktree", "add", "-q", "-b", "maestro/13", worker13Path, "main");
  fs.writeFileSync(path.join(worker13Path, "issue-13.txt"), "integrated on resume\n");
  git(worker13Path, "add", "issue-13.txt");
  git(worker13Path, "commit", "-qm", "implement issue 13");
  const issue13Sha = git(worker13Path, "rev-parse", "HEAD");

  const runId = "20260909220204-d61127";
  await saveRunState(repoPath, runId, {
    runId,
    mode: "execute",
    status: "awaiting-review",
    baseline: { allowFailing: false, commands: [], results: [] },
    workers: [
      { issue: "8", exitCode: 0, headSha: issue8Sha, branch: "maestro/8", worktreePath: worker8Path },
      { issue: "13", exitCode: 0, headSha: issue13Sha, branch: "maestro/13", worktreePath: worker13Path }
    ],
    validations: [
      { issue: "8", verdict: "approve", exitCode: 0 },
      { issue: "13", verdict: "approve", exitCode: 0 }
    ],
    reviews: {
      "8": { disposition: "approve" },
      "13": { disposition: "approve" }
    },
    integration: [{ issue: "8", branch: "maestro/8", integratedSha: issue8Sha, validationResults: [] }]
  });

  const resumed = runCommit(repoPath, manifestPath);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, new RegExp(`Committed Maestro run ${runId}: newly integrated #13; already integrated #8`));
  assert.match(resumed.stdout, /Advanced .*: #13/);
  assert.equal(fs.readFileSync(path.join(repoPath, "issue-8.txt"), "utf8"), "integrated first\n");
  assert.equal(fs.readFileSync(path.join(repoPath, "issue-13.txt"), "utf8"), "integrated on resume\n");

  const resumedState = await loadRunState(repoPath, runId);
  assert.deepEqual(resumedState.integration.map((entry) => String(entry.issue)), ["8", "13"]);
  assert.equal(resumedState.integration[0].integratedSha, issue8Sha);
  assert.equal(resumedState.integration[1].integratedSha, issue13Sha);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.work["8"].status, "complete");
  assert.equal(manifest.work["8"].priority, 10);
  assert.equal(manifest.work["13"].status, "complete");
  assert.equal(manifest.work["13"].priority, 20);

  const headAfterResume = git(repoPath, "rev-parse", "HEAD");
  const repeated = runCommit(repoPath, manifestPath, "--run", runId);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, new RegExp(`Committed Maestro run ${runId}: nothing remaining; already integrated #8, #13`));
  assert.equal(git(repoPath, "rev-parse", "HEAD"), headAfterResume);
  assert.deepEqual((await loadRunState(repoPath, runId)).integration.map((entry) => String(entry.issue)), ["8", "13"]);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  normalizeCommand,
  resolveRepoPath,
  resolveManifestPath,
  markManifestComplete,
  persistManifestCompletion
} = require("../src/cli-context");
const { latestRunId, saveRunState } = require("../src/run-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maestro-cli-test-"));
}

function initGitRepo(repoPath) {
  const result = spawnSync("git", ["init", "-q"], { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function git(repoPath, ...args) {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initPushableRepo() {
  const repoPath = tempDir();
  const remotePath = tempDir();
  initGitRepo(repoPath);
  git(repoPath, "config", "user.name", "Maestro Test");
  git(repoPath, "config", "user.email", "maestro@example.test");
  fs.writeFileSync(path.join(repoPath, "README.md"), "base\n");
  git(repoPath, "add", "README.md");
  git(repoPath, "commit", "-qm", "base");
  git(remotePath, "init", "--bare", "-q");
  git(repoPath, "remote", "add", "origin", remotePath);
  git(repoPath, "push", "-u", "origin", "HEAD");
  return repoPath;
}

test("short command aliases normalize to ergonomic commands", () => {
  assert.equal(normalizeCommand("s"), "start");
  assert.equal(normalizeCommand("st"), "status");
  assert.equal(normalizeCommand("o"), "output");
  assert.equal(normalizeCommand("a"), "approve");
  assert.equal(normalizeCommand("c"), "commit");
  assert.equal(normalizeCommand("n"), "next");
  assert.equal(normalizeCommand("run"), "run");
});

test("repo and manifest default to the current Git root and .maestro.json", () => {
  const repoPath = tempDir();
  initGitRepo(repoPath);
  fs.mkdirSync(path.join(repoPath, "nested"));
  fs.writeFileSync(path.join(repoPath, ".maestro.json"), JSON.stringify({ repository: "owner/repo", work: {} }));

  assert.equal(resolveRepoPath(null, path.join(repoPath, "nested")), repoPath);
  assert.equal(resolveManifestPath(null, repoPath), path.join(repoPath, ".maestro.json"));
});

test("markManifestComplete changes only known incomplete work", () => {
  const repoPath = tempDir();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    repository: "owner/repo",
    work: {
      "57": { status: "ready", priority: 10 },
      "59": { status: "complete" }
    }
  }, null, 2)}\n`);

  assert.deepEqual(markManifestComplete(manifestPath, ["57", "59", "999"]), ["57"]);
  const saved = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(saved.work["57"].status, "complete");
  assert.equal(saved.work["57"].priority, 10);
  assert.equal(saved.work["59"].status, "complete");
});

test("persistManifestCompletion commits an untracked bootstrap manifest", () => {
  const repoPath = initPushableRepo();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    repository: "owner/repo",
    work: { "13": { status: "ready" } }
  }, null, 2)}\n`);

  assert.deepEqual(persistManifestCompletion({ repoPath, manifestPath, issueIds: ["13"] }), {
    changed: ["13"],
    committed: true
  });
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).work["13"].status, "complete");
  assert.equal(git(repoPath, "status", "--porcelain"), "");
  assert.equal(git(repoPath, "show", "@{upstream}:.maestro.json").includes('"status": "complete"'), true);
});

test("persistManifestCompletion commits an ignored bootstrap manifest", () => {
  const repoPath = initPushableRepo();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".maestro.json\n");
  git(repoPath, "add", ".gitignore");
  git(repoPath, "commit", "-qm", "ignore manifest");
  git(repoPath, "push");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    repository: "owner/repo",
    work: { "13": { status: "ready", notes: "preserved" } }
  }, null, 2)}\n`);

  assert.deepEqual(persistManifestCompletion({ repoPath, manifestPath, issueIds: ["13"] }), {
    changed: ["13"],
    committed: true
  });
  const persisted = JSON.parse(git(repoPath, "show", "@{upstream}:.maestro.json"));
  assert.deepEqual(persisted.work["13"], { status: "complete", notes: "preserved" });
  assert.equal(git(repoPath, "status", "--porcelain"), "");
});

test("persistManifestCompletion retains user-authored fields in a tracked dirty manifest", () => {
  const repoPath = initPushableRepo();
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    repository: "owner/repo",
    work: { "13": { status: "ready", priority: 10 } }
  }, null, 2)}\n`);
  git(repoPath, "add", ".maestro.json");
  git(repoPath, "commit", "-qm", "track manifest");
  git(repoPath, "push");

  const edited = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  edited.work["13"].priority = 25;
  edited.work["13"].notes = "user-authored";
  fs.writeFileSync(manifestPath, `${JSON.stringify(edited, null, 2)}\n`);

  const result = persistManifestCompletion({ repoPath, manifestPath, issueIds: ["13"] });
  const saved = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(result, { changed: ["13"], committed: true });
  assert.deepEqual(saved.work["13"], { status: "complete", priority: 25, notes: "user-authored" });
  assert.equal(git(repoPath, "status", "--porcelain"), "");
});

test("latestRunId resolves the newest persisted run", async () => {
  const repoPath = tempDir();
  await saveRunState(repoPath, "20260826010101-aaaaaa", { runId: "20260826010101-aaaaaa", workers: [] });
  await saveRunState(repoPath, "20260826020202-bbbbbb", { runId: "20260826020202-bbbbbb", workers: [] });
  assert.equal(await latestRunId(repoPath), "20260826020202-bbbbbb");
});

test("maestro plan runs from a target repo without explicit manifest or repo path", () => {
  const repoPath = tempDir();
  initGitRepo(repoPath);
  fs.writeFileSync(path.join(repoPath, ".maestro.json"), `${JSON.stringify({
    repository: "owner/repo",
    defaultConcurrency: 1,
    work: {
      "2": { status: "ready", priority: 20 },
      "1": { status: "ready", priority: 10 }
    }
  }, null, 2)}\n`);

  const cliPath = path.resolve(__dirname, "../bin/maestro.js");
  const result = spawnSync(process.execPath, [cliPath, "plan"], { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.selected.map((item) => item.id), ["1"]);
});

test("package exposes the maestro binary", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.bin.maestro, "./bin/maestro.js");
});

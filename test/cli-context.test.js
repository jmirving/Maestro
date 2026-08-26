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
  markManifestComplete
} = require("../src/cli-context");
const { latestRunId, saveRunState } = require("../src/run-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maestro-cli-test-"));
}

function initGitRepo(repoPath) {
  const result = spawnSync("git", ["init", "-q"], { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
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

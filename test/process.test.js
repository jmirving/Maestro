const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runProcess } = require("../src/process");
const { executeWorker } = require("../src/worker");
const { validateWorker } = require("../src/validator");

test("runProcess terminates commands at the configured timeout", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 30 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("runProcess terminates commands that exceed the configured output bound", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000)); setTimeout(() => {}, 1000)"], { maxOutputBytes: 100 });
  assert.equal(result.outputLimitExceeded, true);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.length, 100);
});

test("worker and validator adapters pass the caller's remaining timeout to their processes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-agent-timeout-"));
  const worktreePath = path.join(root, "worktree");
  await fs.mkdir(worktreePath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["config", "user.email", "maestro@example.test"], ["config", "user.name", "Maestro Test"]]) {
    const result = spawnSync("git", args, { cwd: worktreePath, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  await fs.writeFile(path.join(worktreePath, "tracked.txt"), "base\n");
  spawnSync("git", ["add", "tracked.txt"], { cwd: worktreePath });
  spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: worktreePath });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).stdout.trim();
  const received = [];
  const runner = async (_command, _args, options) => {
    received.push(options.timeoutMs);
    return { code: 1, stdout: "", stderr: "timed out", timedOut: true };
  };

  const worker = await executeWorker({
    repository: "example/repo",
    item: { id: "7" },
    worktree: { worktreePath, baseSha: head, branch: "maestro/7" },
    runId: "run-timeout",
    timeoutMs: 41,
    runner
  });
  const validation = await validateWorker({
    repository: "example/repo",
    worker,
    runId: "run-timeout",
    baseline: null,
    timeoutMs: 29,
    runner
  });

  assert.deepEqual(received, [41, 29]);
  assert.equal(worker.timedOut, true);
  assert.equal(validation.timedOut, true);
});

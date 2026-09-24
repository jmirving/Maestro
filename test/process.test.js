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

test("runProcess bounded capture drains excess output without changing a successful exit", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { maxCaptureBytes: 100 });

  assert.equal(result.code, 0);
  assert.equal(result.outputLimitExceeded, false);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
  assert.equal(Buffer.byteLength(result.stdout), 100);
});

test("runProcess bounded capture is byte-correct at a multibyte UTF-8 boundary", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('\u{1f642}'.repeat(100))"], { maxCaptureBytes: 5 });

  assert.equal(result.code, 0);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout, "🙂");
  assert.equal(Buffer.byteLength(result.stdout), 4);
  assert.doesNotMatch(result.stdout, /\uFFFD/);
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


test("runProcess tolerates a child exiting before consuming piped stdin", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdin.destroy(); process.exit(2)"
  ], {
    input: "x".repeat(1024 * 1024)
  });

  assert.equal(result.code, 2);
  assert.equal(result.timedOut, false);
});

async function validatorFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-validator-output-"));
  const worktreePath = path.join(root, "worktree");
  const codexCommand = path.join(root, "fake-codex");
  await fs.mkdir(worktreePath);
  await fs.writeFile(codexCommand, `#!/usr/bin/env node
const fs = require("node:fs");
const reportIndex = process.argv.indexOf("--output-last-message");
const verdict = process.env.FAKE_VERDICT || "APPROVE";
const diagnosticBytes = Number(process.env.FAKE_DIAGNOSTIC_BYTES || 0);
const reportBytes = Number(process.env.FAKE_REPORT_BYTES || 0);
if (diagnosticBytes) process.stderr.write("d".repeat(diagnosticBytes));
const report = reportBytes
  ? \`VERDICT: \${verdict}\\n\${"r".repeat(reportBytes)}\`
  : \`VERDICT: \${verdict}\\nvalidator evidence\\n\`;
fs.writeFileSync(process.argv[reportIndex + 1], report);
if (process.env.FAKE_EXIT_CODE) process.exitCode = Number(process.env.FAKE_EXIT_CODE);
if (process.env.FAKE_HANG) setTimeout(() => {}, 1000);
`);
  await fs.chmod(codexCommand, 0o755);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    codexCommand,
    worker: { issue: "31", baseSha: "base", headSha: "head", branch: "maestro/31", worktreePath, report: "implemented" }
  };
}

function validatorRunner(env) {
  return (command, args, options) => runProcess(command, args, {
    ...options,
    stream: false,
    env: { ...(options.env || {}), ...env }
  });
}

for (const [reported, expected] of [["APPROVE", "approve"], ["REWORK", "rework"], ["HUMAN_GATE", "human_gate"]]) {
  test(`validator accepts ${reported} after truncating more than 512 KiB of diagnostics`, async (t) => {
    const fixture = await validatorFixture(t);
    const validation = await validateWorker({
      repository: "example/repo",
      worker: fixture.worker,
      runId: `large-${expected}`,
      baseline: null,
      codexCommand: fixture.codexCommand,
      runner: validatorRunner({ FAKE_VERDICT: reported, FAKE_DIAGNOSTIC_BYTES: String(512 * 1024 + 4096) })
    });

    assert.equal(validation.exitCode, 0);
    assert.equal(validation.verdict, expected);
    assert.equal(validation.outputTruncated, true);
    assert.equal(validation.stderrTruncated, true);
    assert.equal(validation.outputLimitExceeded, false);
    assert.equal(validation.reportLimitExceeded, false);
    assert.equal(Buffer.byteLength(validation.stderr), 512 * 1024);
  });
}

test("validator fails when its authoritative report exceeds the report limit", async (t) => {
  const fixture = await validatorFixture(t);
  const validation = await validateWorker({
    repository: "example/repo",
    worker: fixture.worker,
    runId: "large-report",
    baseline: null,
    codexCommand: fixture.codexCommand,
    runner: validatorRunner({ FAKE_REPORT_BYTES: "100" }),
    maxOutputBytes: 64
  });

  assert.equal(validation.exitCode, 0);
  assert.equal(validation.verdict, "failed");
  assert.equal(validation.reportLimitExceeded, true);
  assert.equal(validation.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(validation.report) <= 64);
});

test("validator fails on a nonzero Codex exit even when the report approves", async (t) => {
  const fixture = await validatorFixture(t);
  const validation = await validateWorker({
    repository: "example/repo",
    worker: fixture.worker,
    runId: "nonzero",
    baseline: null,
    codexCommand: fixture.codexCommand,
    runner: validatorRunner({ FAKE_EXIT_CODE: "7" })
  });

  assert.equal(validation.exitCode, 7);
  assert.equal(validation.verdict, "failed");
});

test("validator fails when the authoritative report has no valid verdict", async (t) => {
  const fixture = await validatorFixture(t);
  const validation = await validateWorker({
    repository: "example/repo",
    worker: fixture.worker,
    runId: "invalid-verdict",
    baseline: null,
    codexCommand: fixture.codexCommand,
    runner: validatorRunner({ FAKE_VERDICT: "MAYBE" })
  });

  assert.equal(validation.exitCode, 0);
  assert.equal(validation.verdict, "failed");
});

test("validator fails on timeout even when the report approves", async (t) => {
  const fixture = await validatorFixture(t);
  const validation = await validateWorker({
    repository: "example/repo",
    worker: fixture.worker,
    runId: "timeout",
    baseline: null,
    codexCommand: fixture.codexCommand,
    runner: validatorRunner({ FAKE_HANG: "1" }),
    timeoutMs: 30
  });

  assert.equal(validation.timedOut, true);
  assert.notEqual(validation.exitCode, 0);
  assert.equal(validation.verdict, "failed");
});

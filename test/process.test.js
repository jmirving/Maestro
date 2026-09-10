const test = require("node:test");
const assert = require("node:assert/strict");
const { runProcess } = require("../src/process");

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

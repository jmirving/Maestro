const test = require("node:test");
const assert = require("node:assert/strict");
const { failureSignatures, isAcceptedBaselineFailure } = require("../src/integrator");

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

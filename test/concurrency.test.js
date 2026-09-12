const test = require("node:test");
const assert = require("node:assert/strict");
const { parseConcurrency, resolveConcurrency } = require("../src/concurrency");
const { computePlan } = require("../src/planner");
const { computeExpectedWaves } = require("../src/planning-analysis");

function manifest(defaultConcurrency) {
  return {
    repository: "owner/repo",
    ...(defaultConcurrency == null ? {} : { defaultConcurrency }),
    work: Object.fromEntries([1, 2, 3, 4, 5].map((id) => [id, { status: "ready" }]))
  };
}

test("resolves invocation, saved, fallback, and captured concurrency without mutating configuration", () => {
  const config = manifest(2);
  const original = structuredClone(config);
  assert.deepEqual(resolveConcurrency({ override: "4", savedDefault: 2 }), { value: 4, source: "this invocation", savedDefault: 2 });
  assert.deepEqual(resolveConcurrency({ savedDefault: 4 }), { value: 4, source: "saved default", savedDefault: 4 });
  assert.deepEqual(resolveConcurrency(), { value: 2, source: "built-in fallback", savedDefault: null });
  assert.deepEqual(resolveConcurrency({ captured: 3, savedDefault: 4 }), { value: 3, source: "captured session", savedDefault: 4 });
  assert.throws(() => resolveConcurrency({ captured: 3, override: 2 }), /captured session concurrency cannot be changed/i);
  assert.deepEqual(config, original);
});

test("rejects unsafe concurrency values", () => {
  for (const value of ["", "0", "-1", "1.5", "four", "9", "9007199254740992"]) {
    assert.throws(() => parseConcurrency(value), /between 1 and 8/);
  }
});

test("planning and draft projections use the same temporary limit without saving it", () => {
  const config = manifest(2);
  const setting = resolveConcurrency({ override: 4, savedDefault: config.defaultConcurrency });
  const plan = computePlan(config, { concurrency: setting });
  const projection = computeExpectedWaves(config, { concurrency: setting });
  assert.equal(plan.selected.length, 4);
  assert.equal(plan.concurrencySource, "this invocation");
  assert.equal(projection.waves[0].length, 4);
  assert.equal(projection.concurrencySource, "this invocation");
  assert.equal(config.defaultConcurrency, 2);
  assert.equal(computePlan(config).selected.length, 2, "a fresh invocation returns to the saved default");
});

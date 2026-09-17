const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyRunIssue, isRecoverableValidatorRework } = require("../src/run-lifecycle");

test("validator rework remains recoverable after rework-original human disposition", () => {
  const evidence = {
    state: "awaiting-rework",
    verdict: "rework",
    review: { disposition: "rework-original" }
  };

  assert.equal(isRecoverableValidatorRework(evidence), true);
});

test("rework-original classification and rework eligibility agree", () => {
  const state = {
    runId: "20260917155803-6fcd79",
    status: "awaiting-review",
    workers: [{ issue: "19", exitCode: 0 }],
    validations: [{ issue: "19", verdict: "rework" }],
    reviews: { "19": { disposition: "rework-original" } },
    integration: []
  };

  const lifecycle = classifyRunIssue(state, state.workers[0]);
  assert.deepEqual(lifecycle, { state: "awaiting-rework", action: "maestro rework 19" });
  assert.equal(isRecoverableValidatorRework({
    state: lifecycle.state,
    verdict: "rework",
    review: state.reviews["19"]
  }), true);
});

test("other human dispositions remain non-recoverable", () => {
  assert.equal(isRecoverableValidatorRework({
    state: "awaiting-rework",
    verdict: "rework",
    review: { disposition: "discard" }
  }), false);
});

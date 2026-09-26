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

test("human-gated issue becomes recoverable after rework-original disposition", () => {
  const state = {
    runId: "20260917155803-6fcd79",
    status: "awaiting-review",
    workers: [{ issue: "19", exitCode: 0 }],
    validations: [{ issue: "19", verdict: "human_gate" }],
    reviews: { "19": { disposition: "rework-original" } },
    integration: []
  };

  const lifecycle = classifyRunIssue(state, state.workers[0]);
  assert.deepEqual(lifecycle, { state: "awaiting-rework", action: "maestro rework 19" });
  assert.equal(isRecoverableValidatorRework({
    state: lifecycle.state,
    verdict: "human_gate",
    review: state.reviews["19"]
  }), true);
});

test("unreviewed validator rework remains recoverable", () => {
  assert.equal(isRecoverableValidatorRework({
    state: "awaiting-rework",
    verdict: "rework",
    review: null
  }), true);
});

test("contextual human gate correction becomes recoverable", () => {
  const validation = { issue: "19", verdict: "human_gate", exitCode: 0, report: "Choose a fallback" };
  const review = {
    disposition: "rework",
    notes: "Use the owner-approved fallback",
    humanGateResolution: { verdict: "human_gate", exitCode: 0, report: "Choose a fallback" }
  };
  const state = {
    runId: "20260917155803-6fcd79",
    status: "awaiting-review",
    workers: [{ issue: "19", exitCode: 0 }],
    validations: [validation],
    reviews: { "19": review },
    integration: []
  };

  const lifecycle = classifyRunIssue(state, state.workers[0]);
  assert.deepEqual(lifecycle, { state: "awaiting-rework", action: "maestro rework 19" });
  assert.equal(isRecoverableValidatorRework({
    state: lifecycle.state,
    verdict: "human_gate",
    validation,
    review
  }), true);
});

test("other human dispositions remain non-recoverable", () => {
  assert.equal(isRecoverableValidatorRework({
    state: "awaiting-rework",
    verdict: "rework",
    review: { disposition: "discard" }
  }), false);
});

test("resolver ambiguity is a failed correction awaiting explicit human action", () => {
  const state = {
    runId: "20260920101010-aaaaaa",
    status: "failed",
    workers: [{ issue: "35", exitCode: 0 }],
    validations: [],
    reviews: {},
    autoRework: { "35": { status: "human-required" } }
  };
  assert.deepEqual(classifyRunIssue(state, state.workers[0]), {
    state: "failed-awaiting-retry",
    action: "maestro details 35"
  });
});

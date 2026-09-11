const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyRunItems } = require("../src/existing-run");

test("classifyRunItems allows approved work to integrate while rejected work is marked for rework", () => {
  const state = {
    runId: "run-1",
    workers: [
      { issue: "33", exitCode: 0 },
      { issue: "47", exitCode: 0 }
    ],
    validations: [
      { issue: "33", verdict: "approve" },
      { issue: "47", verdict: "rework" }
    ],
    reviews: {
      "33": { disposition: "approve" },
      "47": { disposition: "rework-original" }
    }
  };

  const result = classifyRunItems(state);
  assert.deepEqual(result.integrable.map((entry) => entry.issue), ["33"]);
  assert.deepEqual(result.rework.map((entry) => entry.issue), ["47"]);
});

test("classifyRunItems refuses non-approved work unless human review explicitly marks it for rework", () => {
  assert.throws(() => classifyRunItems({
    runId: "run-2",
    workers: [{ issue: "47", exitCode: 0 }],
    validations: [{ issue: "47", verdict: "rework" }],
    reviews: { "47": { disposition: "approve" } }
  }), /not validator-approved/);
});

test("classifyRunItems integrates an audited override and excludes discarded work", () => {
  const result = classifyRunItems({
    runId: "run-3",
    workers: [{ issue: "7" }, { issue: "8" }],
    validations: [
      { issue: "7", verdict: "rework", exitCode: 1, report: "fix this" },
      { issue: "8", verdict: "rework" }
    ],
    reviews: {
      "7": {
        disposition: "approve-override",
        validatorOverride: { verdict: "rework", exitCode: 1, report: "fix this" }
      },
      "8": { disposition: "discard" }
    }
  });

  assert.deepEqual(result.integrable.map((entry) => entry.issue), ["7"]);
  assert.deepEqual(result.discarded.map((entry) => entry.issue), ["8"]);
  assert.deepEqual(result.rework, []);
});

test("classifyRunItems refuses override approval without matching validator provenance", () => {
  assert.throws(() => classifyRunItems({
    runId: "run-4",
    workers: [{ issue: "7" }],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: { "7": { disposition: "approve-override" } }
  }), /not validator-approved/);
});

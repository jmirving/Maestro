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

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorkerPrompt } = require("../src/worker");


test("rework prompt preserves prior implementation and includes validator corrections", () => {
  const prompt = buildWorkerPrompt({
    repository: "example/repo",
    item: { id: "47", mode: "rework", requires: ["node"] },
    correctionContext: {
      sourceRunId: "20260824232553-f60a17",
      priorWorkerReport: "implemented inbox lifecycle",
      validatorReport: "VERDICT: REWORK\nload exact confirmationRequestId"
    }
  });

  assert.match(prompt, /validator-guided rework/);
  assert.match(prompt, /20260824232553-f60a17/);
  assert.match(prompt, /implemented inbox lifecycle/);
  assert.match(prompt, /load exact confirmationRequestId/);
  assert.match(prompt, /do not restart the issue from scratch/i);
  assert.match(prompt, /Mode: rework/);
});

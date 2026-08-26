const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReconcilePrompt } = require("../src/reconcile");

test("reconcile prompt bounds the agent to approved integration-conflict repair", () => {
  const prompt = buildReconcilePrompt({
    repository: "example/repo",
    worker: { issue: "56", report: "approved worker behavior" },
    validation: { report: "VERDICT: APPROVE\napproved evidence" },
    sourceRunId: "run-1",
    defaultBranch: "main"
  });

  assert.match(prompt, /already validator-approved/);
  assert.match(prompt, /active git rebase conflict/);
  assert.match(prompt, /Resolve ONLY the rebase conflict/);
  assert.match(prompt, /GIT_EDITOR=true git rebase --continue/);
  assert.match(prompt, /Do not push/);
  assert.match(prompt, /approved evidence/);
  assert.match(prompt, /approved worker behavior/);
});

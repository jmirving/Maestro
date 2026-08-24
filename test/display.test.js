const test = require("node:test");
const assert = require("node:assert/strict");
const { formatStatus } = require("../src/display");

test("formatStatus renders run and backlog state compactly", () => {
  const text = formatStatus({
    repository: "example/repo",
    runId: "20260824170000-abc123",
    runIssues: [
      { issue: "47", status: "working" },
      { issue: "56", status: "validated approve" }
    ],
    selected: ["47", "56"],
    ready: ["47", "56", "57"],
    blocked: ["46"],
    complete: ["31", "34"],
    humanGates: []
  });

  assert.match(text, /MAESTRO  example\/repo/);
  assert.match(text, /#47\s+working/);
  assert.match(text, /#56\s+validated approve/);
  assert.match(text, /NEXT\s+#47, #56/);
  assert.match(text, /COMPLETE\s+#31, #34/);
});

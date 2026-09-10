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
    deferred: [],
    recommendations: [],
    humanGates: []
  });

  assert.match(text, /MAESTRO  example\/repo/);
  assert.match(text, /#47\s+working/);
  assert.match(text, /#56\s+validated approve/);
  assert.match(text, /NEXT\s+#47, #56/);
  assert.match(text, /COMPLETE\s+#31, #34/);
});

test("formatStatus recommends settling deferred work when nothing new can start", () => {
  const text = formatStatus({
    repository: "example/repo",
    runId: "20260910010101-aaaaaa",
    runIssues: [{ issue: "7", status: "validated rework" }],
    selected: [],
    ready: [],
    blocked: [],
    complete: [],
    deferred: [{ id: "7", lifecycle: { state: "awaiting-rework" } }],
    recommendations: ["maestro rework --run 20260910010101-aaaaaa"],
    humanGates: []
  });

  assert.match(text, /IN FLIGHT\s+#7 \(awaiting-rework\)/);
  assert.match(text, /CURRENT WORK MUST BE SETTLED/);
  assert.match(text, /maestro rework --run 20260910010101-aaaaaa/);
});

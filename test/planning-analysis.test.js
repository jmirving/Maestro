const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSharedLabelAnalyzer,
  runAdvisoryAnalyzers,
  runPlanningAnalyzer,
  validateDependencyGraph,
  computeExpectedWaves
} = require("../src/planning-analysis");

test("planning analysis interface supports bounded asynchronous analyzers", async () => {
  const input = { issues: [{ id: "1" }] };
  const result = await runPlanningAnalyzer({ name: "agent", analyze: async (received) => ({ received }) }, input);
  assert.deepEqual(result, { received: input });
  await assert.rejects(() => runPlanningAnalyzer({}, input), /must expose an analyze/);
});

function ready(blockedBy = []) {
  return blockedBy.length ? { status: "ready", blockedBy } : { status: "ready" };
}

test("computes concurrency-bounded waves for independent work", () => {
  const plan = computeExpectedWaves({
    defaultConcurrency: 2,
    work: { "1": ready(), "2": ready(), "3": ready() }
  });
  assert.deepEqual(plan.waves, [["1", "2"], ["3"]]);
  assert.equal(plan.available, 3);
  assert.equal(plan.concurrency, 2);
});

test("computes dependency chains and fan-in/fan-out waves", () => {
  const plan = computeExpectedWaves({
    defaultConcurrency: 4,
    work: {
      "1": ready(),
      "2": ready(["1"]),
      "3": ready(["1"]),
      "4": ready(["2", "3"]),
      "5": ready(["4"]),
      "6": ready(["4"])
    }
  });
  assert.deepEqual(plan.waves, [["1"], ["2", "3"], ["4"], ["5", "6"]]);
  assert.match(plan.decisions.find((entry) => entry.issue === "4" && entry.state === "wave").reason, /#2, #3/);
});

test("advisory conflicts serialize work without becoming hard dependencies", () => {
  const config = {
    defaultConcurrency: 3,
    work: { "1": ready(), "2": ready(), "3": ready() },
    planning: {
      advisoryConflicts: [{
        issues: ["1", "2"], confidence: "high", source: "ownership map", reason: "Both touch src/api.", analyzer: "test"
      }]
    }
  };
  const plan = computeExpectedWaves(config);
  assert.deepEqual(plan.waves, [["1", "3"], ["2"]]);
  assert.deepEqual(config.work["2"], { status: "ready" });
  assert.deepEqual(plan.decisions.find((entry) => entry.issue === "2" && entry.state === "serialized"), {
    issue: "2",
    state: "serialized",
    reason: "Deferred from #1 due to Both touch src/api.",
    source: "ownership map",
    confidence: "high"
  });
});

test("shared-label analysis is repository-configured and reports provenance", () => {
  const relationships = runAdvisoryAnalyzers({
    analyzers: [createSharedLabelAnalyzer({ labels: ["area:api"], confidence: "medium" })],
    manifest: { work: { "1": ready(), "2": ready(), "3": ready() } },
    issues: [
      { id: "1", issue: { labels: [{ name: "area:api" }] } },
      { id: "2", issue: { labels: [{ name: "area:api" }, { name: "bug" }] } },
      { id: "3", issue: { labels: [{ name: "bug" }] } }
    ]
  });
  assert.deepEqual(relationships, [{
    issues: ["1", "2"],
    confidence: "medium",
    source: "GitHub labels: area:api",
    reason: "Both issues are mapped to area:api.",
    analyzer: "shared-label"
  }]);
});

test("detects unresolved hard references and cycles", () => {
  const diagnostics = validateDependencyGraph({
    "1": ready(["2"]),
    "2": ready(["1"]),
    "3": ready(["99"])
  });
  assert.match(diagnostics.map((entry) => entry.reason).join("\n"), /#99 is not present/);
  assert.match(diagnostics.map((entry) => entry.reason).join("\n"), /cycle detected: #1 -> #2 -> #1/);
});

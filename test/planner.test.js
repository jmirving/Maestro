const test = require("node:test");
const assert = require("node:assert/strict");
const { computePlan } = require("../src/planner");

test("selects only dependency-satisfied ready work up to concurrency", () => {
  const plan = computePlan({
    repository: "jmirving/Nexus",
    defaultConcurrency: 2,
    work: {
      "31": { status: "ready", mode: "research", requires: ["external_research"] },
      "56": { status: "ready", requires: ["node"] },
      "57": { status: "ready", requires: ["postgres"] },
      "58": { status: "blocked", blockedBy: ["57"] },
      "55": { status: "complete" }
    }
  });

  assert.deepEqual(plan.selected.map((item) => item.id), ["31", "56"]);
  assert.deepEqual(plan.blocked.map((item) => item.id), ["58"]);
});

test("explicit priority overrides numeric issue-key enumeration order", () => {
  const plan = computePlan({
    repository: "jmirving/Nexus",
    defaultConcurrency: 3,
    work: {
      "46": { status: "ready", priority: 40 },
      "57": { status: "ready", priority: 10 },
      "59": { status: "ready", priority: 20 },
      "63": { status: "ready", priority: 30 }
    }
  });

  assert.deepEqual(plan.selected.map((item) => item.id), ["57", "59", "63"]);
  assert.deepEqual(plan.ready.map((item) => item.id), ["57", "59", "63", "46"]);
});

test("a declared ready item still blocks when dependency is incomplete", () => {
  const plan = computePlan({
    repository: "example/repo",
    work: {
      "1": { status: "ready" },
      "2": { status: "ready", blockedBy: ["1"] }
    }
  });

  assert.deepEqual(plan.ready.map((item) => item.id), ["1"]);
  assert.deepEqual(plan.blocked[0].unresolved, ["1"]);
});

test("human gates are never selected", () => {
  const plan = computePlan({
    repository: "example/repo",
    work: {
      "1": { status: "human_gate", humanGate: "approve live provider smoke" }
    }
  });

  assert.equal(plan.selected.length, 0);
  assert.equal(plan.humanGates.length, 1);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { saveRunState } = require("../src/run-store");
const {
  evidenceForIssue,
  resolveFromStates,
  resolveLatestRun,
  resolveRunsForIssues
} = require("../src/run-resolver");

function run(runId, issue, {
  verdict = "approve",
  disposition = null,
  status = "awaiting-review",
  mode = "execute",
  integrated = false
} = {}) {
  return {
    runId,
    mode,
    status,
    plan: { selected: [{ id: String(issue) }] },
    workers: [{ issue: String(issue), exitCode: 0, headSha: `${issue}-${runId}` }],
    validations: verdict ? [{ issue: String(issue), verdict }] : [],
    reviews: disposition ? { [String(issue)]: { disposition } } : {},
    integration: integrated ? [{ issue: String(issue), integratedSha: `merged-${issue}` }] : []
  };
}

test("resolves the latest run globally and the latest run containing a target issue", () => {
  const olderRelevant = run("20260910010101-aaaaaa", "7", { verdict: "rework" });
  const newestUnrelated = run("20260910030303-cccccc", "12");
  const middle = run("20260910020202-bbbbbb", "5");

  assert.equal(resolveFromStates([middle, newestUnrelated, olderRelevant]).runId, newestUnrelated.runId);
  const resolved = resolveFromStates([middle, newestUnrelated, olderRelevant], { issueIds: ["7"] });
  assert.equal(resolved.runId, olderRelevant.runId);
  assert.equal(resolved.evidence[0].verdict, "rework");
});

test("semantic filters prefer the latest matching evidence instead of the literal latest run", () => {
  const rework = run("20260910010101-aaaaaa", "7", { verdict: "rework" });
  const approved = run("20260910020202-bbbbbb", "7", { verdict: "approve", disposition: "approve" });
  const humanRework = run("20260910030303-cccccc", "9", {
    verdict: "human_gate",
    disposition: "rework-original"
  });

  assert.equal(resolveFromStates([rework, approved], {
    issueIds: ["7"],
    filter: { verdict: "rework", state: "awaiting-rework" }
  }).runId, rework.runId);
  assert.equal(resolveFromStates([rework, humanRework], {
    issueIds: ["9"],
    filter: { disposition: "rework-original" }
  }).runId, humanRework.runId);
  assert.equal(resolveFromStates([approved, rework], {
    filter: { verdict: "rework" }
  }).runId, rework.runId);
});

test("filters support action alternatives and run metadata", () => {
  const validatorRework = run("20260910010101-aaaaaa", "7", { verdict: "rework" });
  const reviewRework = run("20260910020202-bbbbbb", "8", {
    verdict: "human_gate",
    disposition: "rework-original",
    mode: "rework"
  });

  const resolved = resolveFromStates([validatorRework, reviewRework], {
    filter: {
      mode: "rework",
      anyOf: [{ verdict: "rework" }, { disposition: "rework-original" }]
    }
  });
  assert.equal(resolved.runId, reviewRework.runId);
});

test("an explicit run ID forces historical resolution", () => {
  const historical = run("20260910010101-aaaaaa", "7", { verdict: "rework" });
  const current = run("20260910020202-bbbbbb", "7", { verdict: "approve" });

  const resolved = resolveFromStates([historical, current], {
    issueIds: ["7"],
    explicitRunId: historical.runId
  });
  assert.equal(resolved.runId, historical.runId);
  assert.equal(resolved.evidence[0].verdict, "rework");
});

test("multiple issues resolve together when one persisted run contains every match", () => {
  const shared = run("20260910020202-bbbbbb", "7", { verdict: "rework" });
  shared.plan.selected.push({ id: "13" });
  shared.workers.push({ issue: "13", exitCode: 0, headSha: "13-shared" });
  shared.validations.push({ issue: "13", verdict: "rework" });
  const unrelated = run("20260910030303-cccccc", "99");

  const resolved = resolveFromStates([shared, unrelated], {
    issueIds: ["7", "13"],
    filter: { verdict: "rework" }
  });
  assert.equal(resolved.runId, shared.runId);
  assert.deepEqual(resolved.evidence.map((entry) => entry.issue), ["7", "13"]);
});

test("one-run resolution explains ambiguity when requested issues have diverged", () => {
  const issue7 = run("20260910010101-aaaaaa", "7", { verdict: "rework" });
  const issue13 = run("20260910020202-bbbbbb", "13", { verdict: "rework" });

  assert.throws(() => resolveFromStates([issue7, issue13], {
    issueIds: ["7", "13"],
    filter: { verdict: "rework" }
  }), /do not share a relevant Maestro run.*#7 in 20260910010101-aaaaaa, #13 in 20260910020202-bbbbbb/);
});

test("per-issue resolution supports diverged histories", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-run-resolver-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveRunState(repoPath, "20260910010101-aaaaaa", run("20260910010101-aaaaaa", "7", { verdict: "rework" }));
  await saveRunState(repoPath, "20260910020202-bbbbbb", run("20260910020202-bbbbbb", "13", { verdict: "rework" }));
  await saveRunState(repoPath, "20260910030303-cccccc", run("20260910030303-cccccc", "99"));

  const resolved = await resolveRunsForIssues(repoPath, ["7", "13"], { filter: { verdict: "rework" } });
  assert.deepEqual(resolved.map(({ issue, runId }) => [issue, runId]), [
    ["7", "20260910010101-aaaaaa"],
    ["13", "20260910020202-bbbbbb"]
  ]);
  assert.equal((await resolveLatestRun(repoPath)).runId, "20260910030303-cccccc");
});

test("missing issues, semantic no-matches, and missing explicit runs are clear", async (t) => {
  const state = run("20260910010101-aaaaaa", "7", { verdict: "approve" });
  assert.throws(() => resolveFromStates([state], { issueIds: ["404"] }), /No relevant Maestro run for issue #404/);
  assert.throws(() => resolveFromStates([state], {
    issueIds: ["7"],
    filter: { verdict: "rework" }
  }), /No relevant Maestro run for issue #7 matching verdict="rework"/);
  assert.throws(() => resolveFromStates([state], { explicitRunId: "20260910999999-deadbe" }), /No Maestro run .* found/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-run-resolver-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveLatestRun(root), new RegExp(`No Maestro runs found for ${root}`));
  await assert.rejects(resolveRunsForIssues(root, ["7"]), new RegExp(`No Maestro runs found for ${root}`));
  await assert.rejects(resolveLatestRun(root, { runId: "20260910010101-aaaaaa" }), /No Maestro run 20260910010101-aaaaaa found/);
});

test("issue evidence includes selected-only and integrated lifecycle states", () => {
  const selected = {
    runId: "20260910010101-aaaaaa",
    status: "running",
    mode: "execute",
    plan: { selected: [{ id: "7" }] }
  };
  assert.equal(evidenceForIssue(selected, "7").state, "running");
  assert.equal(evidenceForIssue({ ...selected, mode: "rework" }, "7").state, "rework-running");
  assert.equal(evidenceForIssue(run("20260910020202-bbbbbb", "7", { integrated: true }), "7").state, "integrated-pending-manifest");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { approveIssues, formatApprovalSummary } = require("../src/approval");
const { loadRunState, saveRunState } = require("../src/run-store");

function worker(issue) {
  return { issue: String(issue), exitCode: 0, baseSha: "base", headSha: `head-${issue}` };
}

function run(runId, issues, verdicts, { parentRunId = null, reviews = {}, integration = [] } = {}) {
  return {
    runId,
    parentRunId,
    mode: parentRunId ? "rework" : "execute",
    status: "awaiting-review",
    plan: { selected: issues.map((id) => ({ id: String(id) })) },
    workers: issues.map(worker),
    validations: issues.map((issue) => ({ issue: String(issue), verdict: verdicts[String(issue)] })),
    reviews,
    integration
  };
}

async function fixture(t, work = { "2": { status: "ready" }, "5": { status: "ready" }, "7": { status: "ready" }, "12": { status: "ready" } }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-approval-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  await fs.writeFile(manifestPath, `${JSON.stringify({ repository: "example/repo", work })}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { repoPath, manifestPath };
}

test("plain approval settles passing siblings and leaves the newest rework generation actionable", async (t) => {
  const { repoPath, manifestPath } = await fixture(t);
  const originalId = "20260910010101-aaaaaa";
  const firstReworkId = "20260910020202-bbbbbb";
  const latestReworkId = "20260910030303-cccccc";
  await saveRunState(repoPath, originalId, run(originalId, [2, 5, 7, 12], {
    "2": "approve", "5": "approve", "7": "rework", "12": "approve"
  }));
  await saveRunState(repoPath, firstReworkId, run(firstReworkId, [7], { "7": "rework" }, { parentRunId: originalId }));
  await saveRunState(repoPath, latestReworkId, run(latestReworkId, [7], { "7": "rework" }, { parentRunId: firstReworkId }));

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const result = spawnSync(process.execPath, [cli, "approve", manifestPath, "--repo-path", repoPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Approved: #2 .*#5 .*#12 /);
  assert.match(result.stdout, new RegExp(`#7 \\(rework-required; run ${latestReworkId}\\)`));
  assert.match(result.stdout, /Still actionable: #7 remains rework-required/);
  assert.match(result.stdout, /Next: maestro rework 7/);

  const original = await loadRunState(repoPath, originalId);
  assert.deepEqual(Object.keys(original.reviews).sort(), ["12", "2", "5"]);
  assert.deepEqual((await loadRunState(repoPath, latestReworkId)).reviews, {});
});

test("selected issues resolve to different current runs and record provenance there", async (t) => {
  const { repoPath } = await fixture(t);
  const firstId = "20260910010101-aaaaaa";
  const secondId = "20260910020202-bbbbbb";
  await saveRunState(repoPath, firstId, run(firstId, [2], { "2": "approve" }));
  await saveRunState(repoPath, secondId, run(secondId, [5], { "5": "approve" }, { parentRunId: firstId }));

  const result = await approveIssues({ repoPath, requestedIssues: ["2", "5"] });
  assert.deepEqual(result.approved, [{ issue: "2", runId: firstId }, { issue: "5", runId: secondId }]);
  assert.equal((await loadRunState(repoPath, firstId)).reviews["2"].disposition, "approve");
  assert.equal((await loadRunState(repoPath, secondId)).reviews["5"].disposition, "approve");
});

test("selected approval refuses a newer rework state atomically instead of reviving an older approval", async (t) => {
  const { repoPath } = await fixture(t);
  const originalId = "20260910010101-aaaaaa";
  const reworkId = "20260910020202-bbbbbb";
  await saveRunState(repoPath, originalId, run(originalId, [2, 7], { "2": "approve", "7": "approve" }));
  await saveRunState(repoPath, reworkId, run(reworkId, [7], { "7": "rework" }, { parentRunId: originalId }));

  await assert.rejects(
    approveIssues({ repoPath, requestedIssues: ["2", "7"] }),
    new RegExp(`#7 \\(rework-required in run ${reworkId}\\)`)
  );
  assert.deepEqual((await loadRunState(repoPath, originalId)).reviews, {});
});

test("a passing latest rework generation is approved in the child run", async (t) => {
  const { repoPath } = await fixture(t);
  const originalId = "20260910010101-aaaaaa";
  const rejectedId = "20260910020202-bbbbbb";
  const approvedId = "20260910030303-cccccc";
  await saveRunState(repoPath, originalId, run(originalId, [7], { "7": "approve" }));
  await saveRunState(repoPath, rejectedId, run(rejectedId, [7], { "7": "rework" }, { parentRunId: originalId }));
  await saveRunState(repoPath, approvedId, run(approvedId, [7], { "7": "approve" }, { parentRunId: rejectedId }));

  const result = await approveIssues({ repoPath });
  assert.deepEqual(result.approved, [{ issue: "7", runId: approvedId }]);
  assert.deepEqual((await loadRunState(repoPath, originalId)).reviews, {});
  assert.equal((await loadRunState(repoPath, approvedId)).reviews["7"].disposition, "approve");
});

test("already-reviewed current work is skipped by plain approval and rejected when selected", async (t) => {
  const { repoPath } = await fixture(t);
  const runId = "20260910010101-aaaaaa";
  await saveRunState(repoPath, runId, run(runId, [2], { "2": "approve" }, {
    reviews: { "2": { disposition: "approve" } }
  }));

  const result = await approveIssues({ repoPath });
  assert.deepEqual(result.approved, []);
  assert.equal(result.skipped[0].reason, "already-reviewed");
  assert.match(formatApprovalSummary(result), /Approved: none/);
  await assert.rejects(approveIssues({ repoPath, requestedIssues: ["2"] }), /#2 \(already-reviewed/);
});

test("explicit run approval retains historical selection semantics", async (t) => {
  const { repoPath } = await fixture(t);
  const historicalId = "20260910010101-aaaaaa";
  const currentId = "20260910020202-bbbbbb";
  await saveRunState(repoPath, historicalId, run(historicalId, [7], { "7": "approve" }));
  await saveRunState(repoPath, currentId, run(currentId, [7], { "7": "rework" }, { parentRunId: historicalId }));

  const result = await approveIssues({ repoPath, runId: historicalId, requestedIssues: ["7"] });
  assert.deepEqual(result.approved, [{ issue: "7", runId: historicalId }]);
  assert.equal((await loadRunState(repoPath, historicalId)).reviews["7"].disposition, "approve");
  assert.deepEqual((await loadRunState(repoPath, currentId)).reviews, {});
});

test("approval reports missing runs and issue matches clearly", async (t) => {
  const { repoPath } = await fixture(t);
  await assert.rejects(approveIssues({ repoPath }), /No Maestro runs found/);
  const runId = "20260910010101-aaaaaa";
  await saveRunState(repoPath, runId, run(runId, [2], { "2": "approve" }));
  await assert.rejects(approveIssues({ repoPath, requestedIssues: ["404"] }), /No relevant Maestro run for issue #404/);
  await assert.rejects(approveIssues({ repoPath, runId, requestedIssues: ["404"] }), /Issue #404 is not part of Maestro run/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { approveIssues, formatApprovalSummary } = require("../src/approval");
const { loadRunState, saveRunState } = require("../src/run-store");

function parseLeadingJson(stdout) {
  return JSON.parse(stdout.split("\n\nIssue #", 1)[0]);
}

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

async function fakeReworkProcesses(root) {
  const binPath = path.join(root, "bin");
  await fs.mkdir(binPath);
  await fs.writeFile(path.join(binPath, "git"), `#!/usr/bin/env node
if (process.argv[2] === "rev-parse") process.stdout.write("base\\n");
`);
  await fs.writeFile(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const index = process.argv.indexOf("--output-last-message");
if (index >= 0) fs.writeFileSync(process.argv[index + 1], "Result: complete\\n");
`);
  await fs.chmod(path.join(binPath, "git"), 0o755);
  await fs.chmod(path.join(binPath, "codex"), 0o755);
  return binPath;
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
  assert.match(result.stdout, /Recommended: `maestro rework 7`/);

  const recommendation = result.stdout.match(/^Recommended: `(maestro rework .+)`$/m)[1];
  const latest = await loadRunState(repoPath, latestReworkId);
  latest.workers[0].worktreePath = repoPath;
  latest.workers[0].branch = "maestro/7";
  await saveRunState(repoPath, latestReworkId, latest);
  const binPath = await fakeReworkProcesses(path.dirname(repoPath));
  const reworked = spawnSync(process.execPath, [
    cli,
    ...recommendation.split(" ").slice(1),
    manifestPath,
    "--repo-path",
    repoPath
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` }
  });
  assert.equal(reworked.status, 0, reworked.stderr);
  const reworkRun = parseLeadingJson(reworked.stdout);
  assert.equal(reworkRun.parentRunId, latestReworkId);
  assert.deepEqual(reworkRun.plan.selected.map((entry) => entry.id), ["7"]);

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

test("explicit override approves only a selected validator-REWORK item and records provenance", async (t) => {
  const { repoPath } = await fixture(t);
  const runId = "20260910010101-aaaaaa";
  const state = run(runId, [7], { "7": "rework" });
  state.validations[0].exitCode = 3;
  state.validations[0].report = "VERDICT: REWORK\nA regression remains.";
  await saveRunState(repoPath, runId, state);

  await assert.rejects(
    approveIssues({ repoPath, override: true }),
    /requires at least one explicit issue number/
  );

  const result = await approveIssues({ repoPath, requestedIssues: ["7"], override: true });
  assert.deepEqual(result.approved, [{ issue: "7", runId, override: true }]);
  const review = (await loadRunState(repoPath, runId)).reviews["7"];
  assert.equal(review.disposition, "approve-override");
  assert.deepEqual(review.validatorOverride, {
    verdict: "rework",
    exitCode: 3,
    report: "VERDICT: REWORK\nA regression remains."
  });
});

test("approve CLI requires --override for validator-REWORK and accepts flags before the issue", async (t) => {
  const { repoPath, manifestPath } = await fixture(t);
  const runId = "20260910010101-aaaaaa";
  await saveRunState(repoPath, runId, run(runId, [7], { "7": "rework" }));
  const cli = path.resolve(__dirname, "../bin/maestro.js");

  const plain = spawnSync(process.execPath, [
    cli, "approve", manifestPath, "7", "--repo-path", repoPath
  ], { encoding: "utf8" });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /Cannot approve.*#7 \(rework-required/);
  assert.deepEqual((await loadRunState(repoPath, runId)).reviews, {});

  const override = spawnSync(process.execPath, [
    cli, "approve", manifestPath, "--override", "7", "--repo-path", repoPath
  ], { encoding: "utf8" });
  assert.equal(override.status, 0, override.stderr);
  assert.match(override.stdout, new RegExp(`Override-approved: #7 \\(run ${runId}\\)`));
  assert.equal((await loadRunState(repoPath, runId)).reviews["7"].disposition, "approve-override");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { discardIssues } = require("../src/discard");
const { statusSnapshot, formatStatus } = require("../src/display");
const { loadIssueDetails, formatDetails } = require("../src/details");
const { computeEffectivePlan } = require("../src/work-state");
const { loadRunState, saveRunState } = require("../src/run-store");

function rejectedRun(runId, issue = "7") {
  return {
    runId,
    mode: "execute",
    status: "awaiting-review",
    plan: { selected: [{ id: issue, title: "Rejected implementation" }] },
    workers: [{
      issue,
      exitCode: 0,
      baseSha: "base",
      headSha: "rejected-head",
      branch: `maestro/${issue}-${runId}`,
      worktreePath: `/preserved/${issue}-${runId}`
    }],
    validations: [{ issue, verdict: "rework", exitCode: 0 }],
    reviews: {},
    integration: []
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-discard-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  const config = {
    repository: "example/repo",
    defaultConcurrency: 1,
    work: { "7": { status: "ready" } }
  };
  await fs.mkdir(repoPath);
  await fs.writeFile(manifestPath, `${JSON.stringify(config)}\n`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { repoPath, manifestPath, config };
}

test("discard records the disposition and makes ready manifest work eligible again", async (t) => {
  const { repoPath, config } = await fixture(t);
  const runId = "20260910010101-aaaaaa";
  const state = rejectedRun(runId);
  await saveRunState(repoPath, runId, state);

  const result = await discardIssues({ repoPath, requestedIssues: ["7"] });
  assert.deepEqual(result.discarded, [{ issue: "7", runId }]);
  const persisted = await loadRunState(repoPath, runId);
  assert.equal(persisted.reviews["7"].disposition, "discard");
  assert.equal(persisted.workers[0].branch, state.workers[0].branch);
  assert.equal(persisted.workers[0].worktreePath, state.workers[0].worktreePath);
  assert.deepEqual(persisted.integration, []);

  const first = await computeEffectivePlan(config, repoPath);
  const repeated = await computeEffectivePlan(config, repoPath);
  assert.deepEqual(first.selected.map((item) => item.id), ["7"]);
  assert.deepEqual(repeated, first);
  assert.equal(config.work["7"].status, "ready");

  const status = formatStatus(await statusSnapshot(config, repoPath));
  assert.match(status, /Issue #7 — Rejected implementation — implementation discarded, ready for a fresh run/);
  assert.match(status, /Recommended: `maestro start`/);
  const details = formatDetails(await loadIssueDetails(repoPath, ["7"], { config }));
  assert.match(details, /Issue state: discarded/);
  assert.match(details, /Disposition: discard/);
});

test("discard CLI is explicit, refuses non-REWORK work, and leaves the manifest unchanged", async (t) => {
  const { repoPath, manifestPath } = await fixture(t);
  const runId = "20260910010101-aaaaaa";
  const state = rejectedRun(runId);
  state.validations[0].verdict = "approve";
  await saveRunState(repoPath, runId, state);
  const before = await fs.readFile(manifestPath, "utf8");
  const cli = path.resolve(__dirname, "../bin/maestro.js");

  const missing = spawnSync(process.execPath, [
    cli, "discard", manifestPath, "--repo-path", repoPath
  ], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires at least one explicit issue number/);

  const refused = spawnSync(process.execPath, [
    cli, "discard", manifestPath, "7", "--repo-path", repoPath
  ], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Only unreviewed validator-REWORK items can be discarded/);
  assert.equal(await fs.readFile(manifestPath, "utf8"), before);
  assert.deepEqual((await loadRunState(repoPath, runId)).reviews, {});
});

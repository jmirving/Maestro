const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { recordReview, isValidHumanGateResolution } = require("../src/reviews");
const { saveRunState, loadRunState } = require("../src/run-store");

async function humanGateFixture(t) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-gate-review-"));
  const runId = "20260910080808-bbbbbb";
  t.after(() => fs.rm(repoPath, { recursive: true, force: true }));
  await saveRunState(repoPath, runId, {
    runId,
    status: "awaiting-review",
    workers: [{ issue: "14", exitCode: 0 }],
    validations: [{ issue: "14", verdict: "human_gate", exitCode: 0, report: "Owner must choose" }],
    reviews: {}
  });
  return { repoPath, runId };
}

test("HUMAN_GATE rework resolution requires context and binds it to validator evidence", async (t) => {
  const { repoPath, runId } = await humanGateFixture(t);
  await assert.rejects(
    recordReview({ repoPath, runId, issue: "14", disposition: "rework" }),
    /requires --notes/
  );

  const review = await recordReview({
    repoPath,
    runId,
    issue: "14",
    disposition: "rework",
    notes: "Use the owner-approved fallback"
  });
  const validation = (await loadRunState(repoPath, runId)).validations[0];
  assert.equal(isValidHumanGateResolution(review, validation), true);
  assert.deepEqual(review.humanGateResolution, {
    verdict: "human_gate",
    exitCode: 0,
    report: "Owner must choose"
  });
});

test("rework disposition cannot fabricate a decision for validator REWORK", async (t) => {
  const { repoPath, runId } = await humanGateFixture(t);
  const state = await loadRunState(repoPath, runId);
  state.validations[0].verdict = "rework";
  await saveRunState(repoPath, runId, state);

  await assert.rejects(
    recordReview({ repoPath, runId, issue: "14", disposition: "rework", notes: "Redundant" }),
    /resolves validator HUMAN_GATE only/
  );
});

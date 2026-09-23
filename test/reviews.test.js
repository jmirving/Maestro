const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { recordReview, isValidHumanGateResolution } = require("../src/reviews");
const { saveRunState, loadRunState } = require("../src/run-store");

async function gateFixture(t) {
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

test("HUMAN_GATE resolution requires context and binds it to validator evidence", async (t) => {
  const { repoPath, runId } = await gateFixture(t);
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
  assert.equal(isValidHumanGateResolution(review, validation, ["rework"]), true);
  assert.deepEqual(review.humanGateResolution, {
    verdict: "human_gate",
    exitCode: 0,
    report: "Owner must choose"
  });
});

test("a recorded human decision cannot be replayed into a contradictory state", async (t) => {
  const { repoPath, runId } = await gateFixture(t);
  await recordReview({
    repoPath,
    runId,
    issue: "14",
    disposition: "discard",
    notes: "Abandon this implementation"
  });
  await assert.rejects(
    recordReview({ repoPath, runId, issue: "14", disposition: "approve", notes: "Changed my mind" }),
    /already has a human decision/
  );
  assert.equal((await loadRunState(repoPath, runId)).reviews["14"].disposition, "discard");
});

test("routine validator REWORK rejects a fabricated human rework disposition", async (t) => {
  const { repoPath, runId } = await gateFixture(t);
  const state = await loadRunState(repoPath, runId);
  state.validations[0].verdict = "rework";
  await saveRunState(repoPath, runId, state);

  await assert.rejects(
    recordReview({ repoPath, runId, issue: "14", disposition: "rework", notes: "Redundant" }),
    /validator REWORK issue #14 is directly reworkable/
  );
  assert.deepEqual((await loadRunState(repoPath, runId)).reviews, {});
});

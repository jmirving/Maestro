const { runChecked } = require("./process");
const { loadRunState, saveRunState } = require("./run-store");

const DISPOSITIONS = new Set(["approve", "rework-original", "approve-with-follow-up"]);

async function recordReview({ repoPath, runId, issue, disposition, title = null, notes = null }) {
  if (!DISPOSITIONS.has(disposition)) throw new Error(`Invalid review disposition: ${disposition}`);
  if (disposition === "approve-with-follow-up" && (!title || !notes)) {
    throw new Error("approve-with-follow-up requires --title and --notes.");
  }
  const state = await loadRunState(repoPath, runId);
  const known = state.workers?.some((worker) => String(worker.issue) === String(issue));
  if (!known) throw new Error(`Issue #${issue} is not part of run ${runId}.`);
  state.reviews = state.reviews || {};
  state.reviews[String(issue)] = { disposition, title, notes, recordedAt: new Date().toISOString() };
  await saveRunState(repoPath, runId, state);
  return state.reviews[String(issue)];
}

function followUpBody({ sourceIssue, runId, sourceCommit, notes }) {
  return `Follow-up discovered during human review of #${sourceIssue}.\n\n${notes}\n\n` +
    `Maestro provenance:\n- source issue: #${sourceIssue}\n- run: ${runId}\n- implementation commit: ${sourceCommit}\n`;
}

async function ensureFollowUp({ config, repoPath, state, issue, runner = runChecked }) {
  const review = state.reviews?.[String(issue)];
  if (review?.disposition !== "approve-with-follow-up") return null;
  if (review.followUpUrl) return review.followUpUrl;
  const worker = state.workers.find((entry) => String(entry.issue) === String(issue));
  const result = await runner("gh", [
    "issue", "create",
    "--repo", config.repository,
    "--title", review.title,
    "--body", followUpBody({ sourceIssue: issue, runId: state.runId, sourceCommit: worker.headSha, notes: review.notes })
  ], { cwd: repoPath });
  review.followUpUrl = result.stdout.trim();
  review.followUpCreatedAt = new Date().toISOString();
  await saveRunState(repoPath, state.runId, state);
  return review.followUpUrl;
}

module.exports = { DISPOSITIONS, recordReview, ensureFollowUp, followUpBody };

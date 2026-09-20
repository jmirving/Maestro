const { runChecked } = require("./process");
const { loadRunState, saveRunState } = require("./run-store");
const { commitLifecycleTransition } = require("./lifecycle-coordination");

const DISPOSITIONS = new Set([
  "approve",
  "approve-override",
  "discard",
  "rework-original",
  "approve-with-follow-up"
]);

function isValidValidatorOverride(review, validation) {
  return review?.disposition === "approve-override" &&
    validation?.verdict === "rework" &&
    review.validatorOverride?.verdict === validation.verdict &&
    review.validatorOverride?.exitCode === (validation.exitCode ?? null) &&
    review.validatorOverride?.report === (validation.report ?? null);
}

async function recordReview({
  repoPath,
  runId,
  issue,
  disposition,
  title = null,
  notes = null,
  validatorOverride = null
}) {
  if (!DISPOSITIONS.has(disposition)) throw new Error(`Invalid review disposition: ${disposition}`);
  if (disposition === "approve-with-follow-up" && (!title || !notes)) {
    throw new Error("approve-with-follow-up requires --title and --notes.");
  }
  if (disposition === "approve-override" && !validatorOverride?.verdict) {
    throw new Error("approve-override requires validator override provenance.");
  }
  const state = await commitLifecycleTransition({
    repoPath,
    runId,
    issueIds: [issue],
    mutate: (current) => {
      const known = current.workers?.some((worker) => String(worker.issue) === String(issue));
      if (!known) throw new Error(`Issue #${issue} is not part of run ${runId}.`);
      const validation = (current.validations || []).find((entry) => String(entry.issue) === String(issue));
      if (disposition === "discard" && validation?.verdict !== "rework") {
        throw new Error(`Issue #${issue} is not validator-REWORK and cannot be discarded.`);
      }
      if (disposition === "approve-override" && !isValidValidatorOverride({ disposition, validatorOverride }, validation)) {
        throw new Error(`Validator override provenance does not match issue #${issue} in run ${runId}.`);
      }
      current.reviews = current.reviews || {};
      current.reviews[String(issue)] = {
        disposition,
        title,
        notes,
        ...(validatorOverride ? { validatorOverride } : {}),
        recordedAt: new Date().toISOString()
      };
      return current;
    }
  });
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

module.exports = { DISPOSITIONS, isValidValidatorOverride, recordReview, ensureFollowUp, followUpBody };

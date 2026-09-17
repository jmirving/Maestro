const { loadPersistedRunStates, loadRunState, saveRunState } = require("./run-store");
const { effectiveIssueStates } = require("./run-resolver");
const { ensureFollowUp, isValidValidatorOverride } = require("./reviews");
const { integrateApproved } = require("./integrator");
const { captureBaseline } = require("./baseline");

function assessRunItems(state, { effectiveByIssue = null } = {}) {
  const validationByIssue = new Map((state.validations || []).map((entry) => [String(entry.issue), entry]));
  const integrable = [];
  const rework = [];
  const discarded = [];
  const completed = [];
  const superseded = [];
  const missing = [];
  const problems = [];

  const hasCurrentIntegrationWork = (state.workers || []).some((worker) => {
    const issue = String(worker.issue);
    const effective = effectiveByIssue?.get(issue);
    if (effective?.terminal || effective?.consistencyConflict) return false;
    if (effective && effective.current?.runId !== String(state.runId)) return false;
    const validation = validationByIssue.get(issue);
    const review = state.reviews?.[issue];
    return (validation?.verdict === "approve" && !["rework-original", "discard"].includes(review?.disposition)) ||
      isValidValidatorOverride(review, validation);
  });

  for (const worker of state.workers || []) {
    const issue = String(worker.issue);
    const conflict = state.conflicts?.[issue];
    if (conflict && !["completed", "manually-resolved", "resolved"].includes(conflict.operationState)) {
      problems.push({
        issue,
        kind: "Git conflict recovery",
        message: `Issue #${issue} has a preserved Git ${conflict.operation} conflict from ${conflict.interruptedStage}. Continue with ${conflict.continuationAction}.`
      });
      continue;
    }
    const validation = validationByIssue.get(issue);
    const review = state.reviews?.[issue];
    const effective = effectiveByIssue?.get(issue);
    const isCurrent = !effective || effective.current?.runId === String(state.runId);

    if (effective?.consistencyConflict) {
      problems.push({
        issue,
        kind: "manifest/run reconciliation",
        message: effective.consistencyConflict
      });
      continue;
    }

    if (effective?.terminal) {
      completed.push({ issue, worker, validation, review, integration: effective.integration });
      continue;
    }

    if (!isCurrent && !hasCurrentIntegrationWork) {
      superseded.push({ issue, worker, validation, review });
      continue;
    }

    if (!review) {
      missing.push({
        issue,
        kind: validation?.verdict === "approve"
          ? "human approval"
          : ["rework", "human_gate"].includes(validation?.verdict) ? "human rework disposition" : "validator result"
      });
      problems.push({ issue, message: `Human review is missing for issue #${issue}. Record it before integration.` });
      continue;
    }

    if (review.disposition === "discard") {
      if (validation?.verdict !== "rework") {
        problems.push({
          issue,
          kind: "consistent validator/review state",
          message: `Issue #${issue} was discarded without a validator-REWORK verdict; resolve the review disposition before integration.`
        });
        continue;
      }
      discarded.push({ issue, worker, validation, review });
      continue;
    }

    if (review.disposition === "rework-original") {
      if (validation?.verdict === "approve") {
        problems.push({
          issue,
          kind: "consistent validator/review state",
          message: `Issue #${issue} is validator-approved but human review requested rework; resolve the review disposition before integration.`
        });
        continue;
      }
      rework.push({ issue, worker, validation, review });
      continue;
    }

    const validOverride = isValidValidatorOverride(review, validation);
    if ((!validation || validation.verdict !== "approve") && !validOverride) {
      problems.push({
        issue,
        kind: "consistent validator/review state",
        message: `Run ${state.runId} issue #${issue} is not validator-approved. Use rework-original for rejected work before integrating the approved items.`
      });
      continue;
    }

    if (isCurrent) integrable.push({ issue, worker, validation, review });
    else superseded.push({ issue, worker, validation, review });
  }

  return { integrable, rework, discarded, completed, superseded, missing, problems };
}

function classifyRunItems(state, options = {}) {
  const assessment = assessRunItems(state, options);
  if (assessment.problems.length) throw new Error(assessment.problems[0].message);
  return {
    integrable: assessment.integrable,
    rework: assessment.rework,
    discarded: assessment.discarded,
    completed: assessment.completed,
    superseded: assessment.superseded
  };
}

async function integrateExistingRun(config, {
  repoPath,
  manifestPath = null,
  runId,
  closeIssues = false,
  runner,
  shellRunner
}) {
  const state = await loadRunState(repoPath, runId);
  const states = await loadPersistedRunStates(repoPath);
  const effectiveByIssue = effectiveIssueStates(config, states);
  const { integrable, rework, discarded, completed, superseded } = classifyRunItems(state, { effectiveByIssue });

  const alreadyIntegrated = new Set((state.integration || []).map((entry) => String(entry.issue)));
  const pendingEntries = integrable.filter((entry) => !alreadyIntegrated.has(entry.issue));
  const pendingWorkers = pendingEntries.map((entry) => entry.worker);
  const pendingValidations = pendingEntries.map((entry) => entry.validation);
  const pendingReviewAuthorizations = pendingEntries.map((entry) => ({
    issue: entry.issue,
    review: entry.review
  }));

  if (!pendingWorkers.length) {
    return {
      runId,
      reviews: state.reviews,
      baseline: state.baseline || null,
      integration: state.integration || [],
      rework: rework.map((entry) => ({ issue: entry.issue, verdict: entry.validation?.verdict || "missing" })),
      discarded: discarded.map((entry) => ({ issue: entry.issue, verdict: entry.validation?.verdict || "missing" })),
      completed: completed.map((entry) => ({ issue: entry.issue })),
      superseded: superseded.map((entry) => ({ issue: entry.issue })),
      resumed: true,
      nothingToDo: true
    };
  }

  for (const entry of integrable) {
    await ensureFollowUp({ config, repoPath, state, issue: entry.issue, runner });
  }

  if (!state.baseline) {
    state.baseline = await captureBaseline(config, { cwd: repoPath, runner: shellRunner });
    state.baselineRecapturedAt = new Date().toISOString();
    await saveRunState(repoPath, runId, state);
  }

  const integrationConfig = JSON.parse(JSON.stringify(config));
  integrationConfig.integration = {
    ...(integrationConfig.integration || {}),
    enabled: true,
    closeIssues: closeIssues === true || integrationConfig.integration?.closeIssues === true
  };

  state.integration = state.integration || [];
  const newlyIntegrated = await integrateApproved({
    config: integrationConfig,
    repoPath,
    manifestPath,
    workers: pendingWorkers,
    validations: pendingValidations,
    reviewAuthorizations: pendingReviewAuthorizations,
    baseline: state.baseline || null,
    runner,
    shellRunner,
    sourceRunId: runId,
    onConflict: async (conflict) => {
      state.conflicts = state.conflicts || {};
      state.conflicts[String(conflict.issue)] = conflict;
      state.status = "technical-conflict";
      state.failure = conflict.failure;
      await saveRunState(repoPath, runId, state);
    },
    onIntegrated: async (integrated) => {
      state.integration.push(integrated);
      state.lastIntegratedAt = new Date().toISOString();
      await saveRunState(repoPath, runId, state);
    }
  });

  state.integratedAt = new Date().toISOString();
  await saveRunState(repoPath, runId, state);
  return {
    runId,
    reviews: state.reviews,
    baseline: state.baseline,
    integration: state.integration,
    newlyIntegrated,
    rework: rework.map((entry) => ({ issue: entry.issue, verdict: entry.validation?.verdict || "missing" })),
    discarded: discarded.map((entry) => ({ issue: entry.issue, verdict: entry.validation?.verdict || "missing" })),
    completed: completed.map((entry) => ({ issue: entry.issue })),
    superseded: superseded.map((entry) => ({ issue: entry.issue }))
  };
}

module.exports = { assessRunItems, classifyRunItems, integrateExistingRun };

const { loadRunState, saveRunState } = require("./run-store");
const { ensureFollowUp } = require("./reviews");
const { integrateApproved } = require("./integrator");
const { captureBaseline } = require("./baseline");

function classifyRunItems(state) {
  const validationByIssue = new Map((state.validations || []).map((entry) => [String(entry.issue), entry]));
  const integrable = [];
  const rework = [];

  for (const worker of state.workers || []) {
    const issue = String(worker.issue);
    const validation = validationByIssue.get(issue);
    const review = state.reviews?.[issue];

    if (!review) {
      throw new Error(`Human review is missing for issue #${issue}. Record it before integration.`);
    }

    if (review.disposition === "rework-original") {
      if (validation?.verdict === "approve") {
        throw new Error(`Issue #${issue} is validator-approved but human review requested rework; resolve the review disposition before integration.`);
      }
      rework.push({ issue, worker, validation, review });
      continue;
    }

    if (!validation || validation.verdict !== "approve") {
      throw new Error(`Run ${state.runId} issue #${issue} is not validator-approved. Use rework-original for rejected work before integrating the approved items.`);
    }

    integrable.push({ issue, worker, validation, review });
  }

  return { integrable, rework };
}

async function integrateExistingRun(config, {
  repoPath,
  runId,
  closeIssues = false,
  runner,
  shellRunner
}) {
  const state = await loadRunState(repoPath, runId);
  const { integrable, rework } = classifyRunItems(state);

  for (const entry of integrable) {
    await ensureFollowUp({ config, repoPath, state, issue: entry.issue, runner });
  }

  if (!state.baseline) {
    state.baseline = await captureBaseline(config, { cwd: repoPath, runner: shellRunner });
    state.baselineRecapturedAt = new Date().toISOString();
    await saveRunState(repoPath, runId, state);
  }

  const alreadyIntegrated = new Set((state.integration || []).map((entry) => String(entry.issue)));
  const pendingEntries = integrable.filter((entry) => !alreadyIntegrated.has(entry.issue));
  const pendingWorkers = pendingEntries.map((entry) => entry.worker);
  const pendingValidations = pendingEntries.map((entry) => entry.validation);

  if (!pendingWorkers.length) {
    return {
      runId,
      reviews: state.reviews,
      baseline: state.baseline,
      integration: state.integration || [],
      rework: rework.map((entry) => ({ issue: entry.issue, verdict: entry.validation?.verdict || "missing" })),
      resumed: true,
      nothingToDo: true
    };
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
    workers: pendingWorkers,
    validations: pendingValidations,
    baseline: state.baseline || null,
    runner,
    shellRunner,
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
    rework: rework.map((entry) => ({ issue: entry.issue, verdict: entry.validation?.verdict || "missing" }))
  };
}

module.exports = { classifyRunItems, integrateExistingRun };

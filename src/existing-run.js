const { loadRunState, saveRunState } = require("./run-store");
const { ensureFollowUp } = require("./reviews");
const { integrateApproved } = require("./integrator");
const { captureBaseline } = require("./baseline");

async function integrateExistingRun(config, {
  repoPath,
  runId,
  closeIssues = false,
  runner,
  shellRunner
}) {
  const state = await loadRunState(repoPath, runId);
  const validationByIssue = new Map((state.validations || []).map((entry) => [String(entry.issue), entry]));

  for (const worker of state.workers || []) {
    const issue = String(worker.issue);
    const validation = validationByIssue.get(issue);
    if (!validation || validation.verdict !== "approve") {
      throw new Error(`Run ${runId} issue #${issue} is not validator-approved.`);
    }
    const review = state.reviews?.[issue];
    if (!review) throw new Error(`Human review is missing for issue #${issue}. Record it before integration.`);
    if (review.disposition === "rework-original") {
      throw new Error(`Issue #${issue} was marked rework-original and cannot be integrated.`);
    }
  }

  for (const worker of state.workers || []) {
    await ensureFollowUp({ config, repoPath, state, issue: worker.issue, runner });
  }

  if (!state.baseline) {
    state.baseline = await captureBaseline(config, { cwd: repoPath, runner: shellRunner });
    state.baselineRecapturedAt = new Date().toISOString();
    await saveRunState(repoPath, runId, state);
  }

  const alreadyIntegrated = new Set((state.integration || []).map((entry) => String(entry.issue)));
  const pendingWorkers = (state.workers || []).filter((worker) => !alreadyIntegrated.has(String(worker.issue)));
  const pendingIssues = new Set(pendingWorkers.map((worker) => String(worker.issue)));
  const pendingValidations = (state.validations || []).filter((entry) => pendingIssues.has(String(entry.issue)));

  if (!pendingWorkers.length) {
    return { runId, reviews: state.reviews, baseline: state.baseline, integration: state.integration || [], resumed: true, nothingToDo: true };
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
    newlyIntegrated
  };
}

module.exports = { integrateExistingRun };

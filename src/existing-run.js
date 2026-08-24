const { loadRunState, saveRunState } = require("./run-store");
const { ensureFollowUp } = require("./reviews");
const { integrateApproved } = require("./integrator");

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

  const integrationConfig = JSON.parse(JSON.stringify(config));
  integrationConfig.integration = {
    ...(integrationConfig.integration || {}),
    enabled: true,
    closeIssues: closeIssues === true || integrationConfig.integration?.closeIssues === true
  };

  const integration = await integrateApproved({
    config: integrationConfig,
    repoPath,
    workers: state.workers,
    validations: state.validations,
    baseline: state.baseline || null,
    runner,
    shellRunner
  });
  state.integration = integration;
  state.integratedAt = new Date().toISOString();
  await saveRunState(repoPath, runId, state);
  return { runId, reviews: state.reviews, integration };
}

module.exports = { integrateExistingRun };

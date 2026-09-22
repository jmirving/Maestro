const { discoverGitHubRepository, loadGitHubIssues } = require("./github");
const { detectExecutionDrift } = require("./draft");

async function verifyExecutionSelection(config, repoPath, issueIds, {
  repositoryResolver = discoverGitHubRepository,
  issueLoader = loadGitHubIssues
} = {}) {
  if (!issueIds.length) return [];
  const repository = await repositoryResolver(repoPath);
  if (repository !== config.repository) {
    throw new Error(`The manifest targets ${config.repository}, but the current checkout is ${repository}.`);
  }
  const issues = await issueLoader(repository, issueIds, { repoPath });
  const findings = detectExecutionDrift(config, issues, issueIds);
  if (findings.length) {
    throw new Error(
      `GitHub/manifest drift blocks execution: ${findings.map((item) => `#${item.issue} ${item.reason}`).join(" ")} ` +
      "Run `maestro draft --write` and review any conflicts before retrying."
    );
  }
  return issues;
}

module.exports = { verifyExecutionSelection };

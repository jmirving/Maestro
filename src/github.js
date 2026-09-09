const { runChecked } = require("./process");

function parseJson(result, description) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`GitHub returned invalid JSON while ${description}.`);
  }
}

async function discoverGitHubRepository(repoPath, { runner = runChecked } = {}) {
  const result = await runner("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: repoPath });
  const repository = parseJson(result, "discovering the repository").nameWithOwner;
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw new Error("GitHub did not identify a valid owner/repository for the target checkout.");
  }
  return repository;
}

async function loadGitHubIssues(repository, issueIds, { repoPath, runner = runChecked } = {}) {
  const fields = "number,title,body,state,labels";
  if (issueIds.length) {
    const issues = [];
    for (const issue of issueIds) {
      const result = await runner("gh", ["issue", "view", String(issue), "--repo", repository, "--json", fields], { cwd: repoPath });
      issues.push(parseJson(result, `reading issue #${issue}`));
    }
    return issues;
  }

  const result = await runner("gh", [
    "issue", "list", "--repo", repository, "--state", "open", "--limit", "1000", "--json", fields
  ], { cwd: repoPath });
  const issues = parseJson(result, "listing open issues");
  if (!Array.isArray(issues)) throw new Error("GitHub issue listing did not return an array.");
  return issues;
}

module.exports = { discoverGitHubRepository, loadGitHubIssues };

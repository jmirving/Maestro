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
  const fields = "number,title,body,state,closedAt,updatedAt,labels";
  const addStateReasons = async (issues) => {
    try {
      let records;
      if (issueIds.length) {
        records = await Promise.all(issueIds.map(async (id) => parseJson(
          await runner("gh", ["api", `repos/${repository}/issues/${id}`], { cwd: repoPath }),
          `reading closure reason for issue #${id}`
        )));
      } else {
        const response = parseJson(await runner("gh", [
          "api", "--paginate", "--slurp", `repos/${repository}/issues?state=all&per_page=100`
        ], { cwd: repoPath }), "reading issue closure reasons");
        records = response.flat();
      }
      const byNumber = new Map(records.filter((record) => !record.pull_request).map((record) => [String(record.number), record.state_reason || null]));
      return issues.map((issue) => ({ ...issue, stateReason: byNumber.get(String(issue.number)) || null }));
    } catch {
      return issues.map((issue) => ({ ...issue, stateReason: issue.stateReason || null }));
    }
  };
  if (issueIds.length) {
    const issues = [];
    for (const issue of issueIds) {
      const result = await runner("gh", ["issue", "view", String(issue), "--repo", repository, "--json", fields], { cwd: repoPath });
      issues.push(parseJson(result, `reading issue #${issue}`));
    }
    return addStateReasons(issues);
  }

  const result = await runner("gh", [
    "issue", "list", "--repo", repository, "--state", "all", "--limit", "1000", "--json", fields
  ], { cwd: repoPath });
  const issues = parseJson(result, "listing open and closed issues");
  if (!Array.isArray(issues)) throw new Error("GitHub issue listing did not return an array.");
  return addStateReasons(issues);
}

module.exports = { discoverGitHubRepository, loadGitHubIssues };

const { runChecked, runShellChecked } = require("./process");

async function ensureClean(repoPath, runner = runChecked) {
  const status = (await runner("git", ["status", "--porcelain"], { cwd: repoPath })).stdout.trim();
  if (status) throw new Error(`Target default-branch checkout is not clean:\n${status}`);
}

async function integrateApproved({ config, repoPath, workers, validations, runner = runChecked, shellRunner = runShellChecked }) {
  const integration = config.integration || {};
  if (integration.enabled !== true) throw new Error("Manifest does not enable integration.");
  const defaultBranch = config.defaultBranch || "main";
  const verdicts = new Map(validations.map((entry) => [String(entry.issue), entry.verdict]));
  const approved = workers.filter((worker) => worker.exitCode === 0 && verdicts.get(String(worker.issue)) === "approve");
  const results = [];

  await ensureClean(repoPath, runner);
  for (const worker of approved) {
    await runner("git", ["fetch", "origin", defaultBranch], { cwd: worker.worktreePath });
    const rebase = await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: worker.worktreePath }).catch(async (error) => {
      try { await runner("git", ["rebase", "--abort"], { cwd: worker.worktreePath }); } catch {}
      throw error;
    });
    void rebase;

    for (const command of integration.commands || []) {
      await shellRunner(command, { cwd: worker.worktreePath });
    }

    await runner("git", ["checkout", defaultBranch], { cwd: repoPath });
    await runner("git", ["pull", "--ff-only", "origin", defaultBranch], { cwd: repoPath });
    const before = (await runner("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    try {
      await runner("git", ["merge", "--ff-only", worker.branch], { cwd: repoPath });
      for (const command of integration.postMergeCommands || []) {
        await shellRunner(command, { cwd: repoPath });
      }
      await runner("git", ["push", "origin", defaultBranch], { cwd: repoPath });
    } catch (error) {
      try { await runner("git", ["reset", "--hard", before], { cwd: repoPath }); } catch {}
      throw error;
    }

    const integratedSha = (await runner("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    if (integration.closeIssues === true) {
      await runner("gh", ["issue", "close", String(worker.issue), "--repo", config.repository, "--reason", "completed", "--comment", `Integrated by Maestro at ${integratedSha}.`], { cwd: repoPath });
    }
    results.push({ issue: worker.issue, branch: worker.branch, integratedSha });
  }
  return results;
}

module.exports = { ensureClean, integrateApproved };

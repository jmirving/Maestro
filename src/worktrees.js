const fs = require("node:fs/promises");
const path = require("node:path");
const { runChecked } = require("./process");

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function resolveRepoRoot(repoPath, runner = runChecked) {
  const result = await runner("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath });
  return result.stdout.trim();
}

async function prepareWorktree({ repoPath, item, runId, defaultBranch = "main", runner = runChecked }) {
  const repoRoot = await resolveRepoRoot(repoPath, runner);
  await runner("git", ["fetch", "origin", defaultBranch], { cwd: repoRoot });
  const base = (await runner("git", ["rev-parse", `origin/${defaultBranch}`], { cwd: repoRoot })).stdout.trim();
  const workspaceRoot = path.join(path.dirname(repoRoot), ".maestro-worktrees", path.basename(repoRoot));
  await fs.mkdir(workspaceRoot, { recursive: true });
  const branch = `maestro/${safeSegment(item.id)}-${safeSegment(runId)}`;
  const worktreePath = path.join(workspaceRoot, `${safeSegment(item.id)}-${safeSegment(runId)}`);
  await runner("git", ["worktree", "add", "-b", branch, worktreePath, base], { cwd: repoRoot });
  return { repoRoot, baseSha: base, branch, worktreePath };
}

async function currentHead(worktreePath, runner = runChecked) {
  return (await runner("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
}

module.exports = { safeSegment, resolveRepoRoot, prepareWorktree, currentHead };

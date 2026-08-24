const fs = require("node:fs/promises");
const path = require("node:path");
const { runProcess } = require("./process");
const { currentHead } = require("./worktrees");

function buildWorkerPrompt({ repository, item }) {
  return `Implement ${repository} issue #${item.id} in this isolated worker branch.\n\n` +
    `Mode: ${item.mode || "execute"}.\n` +
    `Required capabilities: ${(item.requires || []).join(", ") || "none"}.\n\n` +
    `Read the issue, comments, repository AGENTS.md/instructions, current docs/specs, relevant code and tests before editing. ` +
    `Treat repository product/domain truth as authoritative. Work systemically at the correct shared boundary.\n\n` +
    `Safety constraints:\n` +
    `- Do not merge or push the default branch.\n` +
    `- Do not close the issue.\n` +
    `- Do not perform live/destructive/non-idempotent external mutations unless the issue and repository manifest explicitly authorize them.\n` +
    `- If you encounter a product/domain decision not already resolved, stop and report it instead of guessing.\n` +
    `- Run all tests required by the issue and repository instructions. Mandatory persistence tests may not be silently skipped.\n` +
    `- Commit completed work to the current worker branch.\n\n` +
    `Final report must state: result (complete|blocked|failed), important changes, tests with exact results, commit SHA, and any human decision required.`;
}

async function executeWorker({ repository, item, worktree, runId, codexCommand = "codex", runner = runProcess }) {
  const reportDir = path.join(path.dirname(worktree.worktreePath), ".maestro-reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `worker-${item.id}-${runId}.md`);
  const prompt = buildWorkerPrompt({ repository, item });
  const result = await runner(codexCommand, ["exec", "--sandbox", "danger-full-access", "--output-last-message", reportPath, "-"], {
    cwd: worktree.worktreePath,
    input: `${prompt}\n`
  });
  let report = "";
  try { report = await fs.readFile(reportPath, "utf8"); } catch {}
  const headSha = await currentHead(worktree.worktreePath);
  return {
    issue: item.id,
    mode: item.mode,
    status: result.code === 0 ? "worker-finished" : "worker-failed",
    exitCode: result.code,
    baseSha: worktree.baseSha,
    headSha,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    reportPath,
    report,
    stderr: result.stderr.trim()
  };
}

module.exports = { buildWorkerPrompt, executeWorker };

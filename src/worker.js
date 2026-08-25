const fs = require("node:fs/promises");
const path = require("node:path");
const { runProcess } = require("./process");
const { currentHead } = require("./worktrees");

function buildWorkerPrompt({ repository, item, correctionContext = null }) {
  const correction = correctionContext
    ? `\nThis is a validator-guided rework of an existing implementation from Maestro run ${correctionContext.sourceRunId}. Preserve correct prior work and address the validator findings directly; do not restart the issue from scratch unless the findings require it.\n\nPrevious worker report:\n---\n${correctionContext.priorWorkerReport || "(none)"}\n---\n\nValidator findings that MUST be corrected:\n---\n${correctionContext.validatorReport || "(none)"}\n---\n\nAfter correcting them, rerun the focused and repository-required suites and explicitly report how each validator finding was resolved.\n`
    : "";

  return `Implement ${repository} issue #${item.id} in this isolated worker branch.\n\n` +
    `Mode: ${item.mode || "execute"}.\n` +
    `Required capabilities: ${(item.requires || []).join(", ") || "none"}.\n` + correction + `\n` +
    `Read the issue, comments, repository AGENTS.md/instructions, current docs/specs, relevant code and tests before editing. ` +
    `Treat repository product/domain truth as authoritative. Work systemically at the correct shared boundary.\n\n` +
    `Safety constraints:\n` +
    `- Do not merge or push the default branch.\n` +
    `- Do not close the issue.\n` +
    `- Do not perform live/destructive/non-idempotent external mutations unless the issue and repository manifest explicitly authorize them.\n` +
    `- If you encounter a product/domain decision not already resolved, stop and report it instead of guessing.\n` +
    `- Run all tests required by the issue and repository instructions. Mandatory persistence tests may not be silently skipped.\n` +
    `- Commit completed work to the current worker branch.\n\n` +
    `Final report must state: result (complete|blocked|failed), important changes, tests with exact results, commit SHA, and any human decision required.\n\n` +
    `End with a section titled exactly \"### Human review\". Keep it concise and practical. State where a human should expect to see any visual/behavior change, which user/persona/state to use if relevant, and the highest-value place to check for catastrophic regression or unintended side effects. If no meaningful manual review exists, say so explicitly.`;
}

async function executeWorker({ repository, item, worktree, runId, correctionContext = null, codexCommand = "codex", runner = runProcess }) {
  const reportDir = path.join(path.dirname(worktree.worktreePath), ".maestro-reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `worker-${item.id}-${runId}.md`);
  const prompt = buildWorkerPrompt({ repository, item, correctionContext });
  console.error(`[Maestro] worker #${item.id} starting${correctionContext ? " rework" : ""}`);
  const result = await runner(codexCommand, ["exec", "--sandbox", "danger-full-access", "--output-last-message", reportPath, "-"], {
    cwd: worktree.worktreePath,
    input: `${prompt}\n`,
    stream: true,
    streamPrefix: `[#${item.id} worker] `
  });
  console.error(`[Maestro] worker #${item.id} finished with exit ${result.code}`);
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

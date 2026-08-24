const fs = require("node:fs/promises");
const path = require("node:path");
const { runProcess } = require("./process");

function buildValidatorPrompt({ repository, worker }) {
  return `Validate ${repository} issue #${worker.issue} after an implementation worker completed.\n\n` +
    `Base SHA: ${worker.baseSha}\nHead SHA: ${worker.headSha}\nBranch: ${worker.branch}\n\n` +
    `Read the issue and comments, repository instructions, relevant canonical docs, the worker report, and the actual diff from base to HEAD. ` +
    `Do not edit files, commit, push, merge, or close anything.\n\n` +
    `Check that the change satisfies the issue, preserves repository/domain contracts, does not cross unresolved human gates, and has tests proportional to risk. ` +
    `Treat skipped mandatory tests as a rejection unless the repository explicitly permits them.\n\n` +
    `Your final response MUST begin with exactly one line: VERDICT: APPROVE, VERDICT: REWORK, or VERDICT: HUMAN_GATE. ` +
    `Then give concise evidence and the exact correction/decision needed if not approved.\n\n` +
    `Worker report:\n---\n${worker.report || "(no worker report)"}\n---`;
}

function parseVerdict(report) {
  const match = String(report || "").match(/^VERDICT:\s*(APPROVE|REWORK|HUMAN_GATE)\b/m);
  return match ? match[1].toLowerCase() : "invalid";
}

async function validateWorker({ repository, worker, runId, codexCommand = "codex", runner = runProcess }) {
  const reportDir = path.join(path.dirname(worker.worktreePath), ".maestro-reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `validator-${worker.issue}-${runId}.md`);
  const result = await runner(codexCommand, ["exec", "--sandbox", "read-only", "--output-last-message", reportPath, "-"], {
    cwd: worker.worktreePath,
    input: `${buildValidatorPrompt({ repository, worker })}\n`
  });
  let report = "";
  try { report = await fs.readFile(reportPath, "utf8"); } catch {}
  return {
    issue: worker.issue,
    exitCode: result.code,
    verdict: result.code === 0 ? parseVerdict(report) : "failed",
    report,
    stderr: result.stderr.trim()
  };
}

module.exports = { buildValidatorPrompt, parseVerdict, validateWorker };

const fs = require("node:fs/promises");
const path = require("node:path");
const { runProcess } = require("./process");
const { summarizeBaseline } = require("./baseline");

function buildValidatorPrompt({ repository, worker, baseline }) {
  const baselinePolicy = baseline?.enabled
    ? `A clean-base validation was captured before workers started. Failing baseline is ${baseline.allowFailing ? "explicitly allowed" : "not allowed"}. A branch failure may be treated as non-regressive ONLY when the evidence shows it is the same failure already present in the captured baseline; new, changed, or broader failures require REWORK or HUMAN_GATE.\n\nCaptured baseline:\n${summarizeBaseline(baseline)}\n\n`
    : "No clean-base validation was configured; do not assume unrelated failures are acceptable.\n\n";

  return `Validate ${repository} issue #${worker.issue} after an implementation worker completed.\n\n` +
    `Base SHA: ${worker.baseSha}\nHead SHA: ${worker.headSha}\nBranch: ${worker.branch}\n\n` +
    baselinePolicy +
    `Read the issue and comments, repository instructions, relevant canonical docs, the worker report, and the actual diff from base to HEAD. ` +
    `Do not edit files, commit, push, merge, or close anything.\n\n` +
    `Check that the change satisfies the issue, preserves repository/domain contracts, does not cross unresolved human gates, and has tests proportional to risk. ` +
    `Treat skipped mandatory tests as a rejection unless the repository explicitly permits them.\n\n` +
    `Your final response MUST begin with exactly one line: VERDICT: APPROVE, VERDICT: REWORK, or VERDICT: HUMAN_GATE. ` +
    `Then give concise evidence and the exact correction/decision needed if not approved. Preserve or improve the worker's practical Human review guidance when relevant.\n\n` +
    `Worker report:\n---\n${worker.report || "(no worker report)"}\n---`;
}

function parseVerdict(report) {
  const match = String(report || "").match(/^VERDICT:\s*(APPROVE|REWORK|HUMAN_GATE)\b/m);
  return match ? match[1].toLowerCase() : "invalid";
}

async function validateWorker({ repository, worker, runId, baseline, codexCommand = "codex", runner = runProcess }) {
  const reportDir = path.join(path.dirname(worker.worktreePath), ".maestro-reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `validator-${worker.issue}-${runId}.md`);
  console.error(`[Maestro] validator #${worker.issue} starting`);
  const result = await runner(codexCommand, ["exec", "--sandbox", "read-only", "--output-last-message", reportPath, "-"], {
    cwd: worker.worktreePath,
    input: `${buildValidatorPrompt({ repository, worker, baseline })}\n`,
    stream: true,
    streamPrefix: `[#${worker.issue} validator] `
  });
  console.error(`[Maestro] validator #${worker.issue} finished with exit ${result.code}`);
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

const fs = require("node:fs/promises");
const path = require("node:path");
const { runProcess } = require("./process");

const MAX_CONTEXT_CHARS = 120000;

function boundedText(value, limit = MAX_CONTEXT_CHARS) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Maestro truncated ${text.length - limit} characters]`;
}

function buildConflictResolverPrompt({
  repository,
  issue,
  issueContext = {},
  priorWorkerReport,
  validatorReport,
  conflict
}) {
  const operation = conflict.operation || "rebase";
  const adopted = conflict.operationOwner === "user";
  const subject = issue == null ? "the explicitly adopted Git operation" : `${repository} issue #${issue}`;
  const title = issueContext.title ? ` — ${issueContext.title}` : "";
  const body = issueContext.body || "(not retained; read the issue and repository context if available)";
  return `Resolve the active Git ${operation} conflict for ${subject}${title} in the existing worktree.\n\n` +
    `This is a bounded conflict-repair task, not a new implementation or review. Preserve the intended behavior from both sides of the operation. Read repository instructions and relevant code before choosing a resolution.\n\n` +
    (adopted ? `The user explicitly adopted an operation that was already in progress. Preserve all existing staged resolutions, unstaged edits, and untracked files. Do not recreate the conflict or replace user progress.\n\n` : "") +
    `Issue context:\n---\n${boundedText(body, 16000)}\n---\n\n` +
    `Previous worker report:\n---\n${boundedText(priorWorkerReport, 24000) || "(none)"}\n---\n\n` +
    `Validator REWORK report:\n---\n${boundedText(validatorReport, 24000) || "(none)"}\n---\n\n` +
    `Git provenance:\n` +
    `- Branch: ${conflict.branch || "unknown"}\n` +
    `- Original base SHA: ${conflict.originalBaseSha || "unknown"}\n` +
    `- Source SHA before rebase: ${conflict.sourceSha || "unknown"}\n` +
    `- Intended target: ${conflict.targetRef} (${conflict.targetSha || "unknown"})\n` +
    `- Operation: ${operation}\n` +
    `- Operation HEAD: ${conflict.operationHeadSha || conflict.rebaseHeadSha || "unknown"}\n` +
    `- Conflicted files: ${conflict.conflictedFiles.join(", ")}\n` +
    `- Rebase status at capture:\n${boundedText(conflict.gitStatus, 12000) || "(not available)"}\n\n` +
    `Retained implementation diff (${conflict.originalBaseSha || "base"}..${conflict.sourceSha || "source"}):\n` +
    `---\n${boundedText(conflict.retainedDiff) || "(not available)"}\n---\n\n` +
    `Relevant current-target changes affecting the conflicted files:\n` +
    `---\n${boundedText(conflict.targetDiff) || "(not available)"}\n---\n\n` +
    `Allowed actions:\n` +
    `- Edit conflicted files and make only minimal compatibility edits required for the resolution.\n` +
    `- Stage only resolved conflict files and continue this same ${operation}. Resolve further content conflicts from this same operation if necessary.\n\n` +
    `Forbidden actions:\n` +
    `- Do not abort, skip, restart, or replace the ${operation}.\n` +
    `- Do not stage, modify, delete, or commit unrelated user files.\n` +
    `- Do not reset the branch, discard the implementation, force-push, merge, approve, integrate, close issues, or broaden issue scope.\n` +
    `- Do not guess when the two sides encode materially contradictory product behavior.\n\n` +
    `If the intent is technically reconcilable, resolve it, stage it, and finish the ${operation} with a noninteractive editor (for example GIT_EDITOR=true git ${operation} --continue). Continue through later conflict steps from this same operation. ` +
    `Then begin the final response with exactly RESOLUTION: RESOLVED and report the behaviors preserved from each side, changed files, checks and exact results, final SHA, and any remaining semantic uncertainty. ` +
    `If a product or semantic decision is genuinely required, leave the rebase recoverable and begin with exactly RESOLUTION: HUMAN_REQUIRED, followed by the ambiguity and safe manual continuation. ` +
    `If you cannot safely finish for another reason, leave the rebase recoverable and begin with exactly RESOLUTION: FAILED, followed by exact evidence.\n`;
}

function parseResolution(report) {
  const match = String(report || "").match(/^RESOLUTION:\s*(RESOLVED|HUMAN_REQUIRED|FAILED)\b/m);
  if (!match) return "invalid";
  return match[1].toLowerCase().replace("_", "-");
}

async function executeConflictResolver({
  repository,
  issue,
  issueContext,
  priorWorkerReport,
  validatorReport,
  conflict,
  worktreePath,
  runId,
  codexCommand = "codex",
  runner = runProcess,
  timeoutMs = null
}) {
  const reportDir = path.join(path.dirname(worktreePath), ".maestro-reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `conflict-resolver-${issue == null ? "adopted" : issue}-${runId}.md`);
  const prompt = buildConflictResolverPrompt({
    repository,
    issue,
    issueContext,
    priorWorkerReport,
    validatorReport,
    conflict
  });
  console.error(`[Maestro] conflict resolver ${issue == null ? "adopted operation" : `#${issue}`} starting`);
  const result = await runner(codexCommand, [
    "exec",
    "--approve-for-me",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--output-last-message", reportPath,
    "-"
  ], {
    cwd: worktreePath,
    input: `${prompt}\n`,
    stream: true,
    streamPrefix: `[${issue == null ? "adopted" : `#${issue}`} conflict resolver] `,
    timeoutMs,
    maxOutputBytes: 512 * 1024
  });
  console.error(`[Maestro] conflict resolver ${issue == null ? "adopted operation" : `#${issue}`} finished with exit ${result.code}`);
  let report = "";
  try { report = boundedText(await fs.readFile(reportPath, "utf8"), 128 * 1024); } catch {}
  const reportedStatus = parseResolution(report);
  const status = result.code === 0 && reportedStatus !== "invalid" ? reportedStatus : "failed";
  return {
    status,
    reportedStatus,
    exitCode: result.code,
    timedOut: result.timedOut === true,
    reportPath,
    report,
    stderr: String(result.stderr || "").trim()
  };
}

module.exports = {
  MAX_CONTEXT_CHARS,
  boundedText,
  buildConflictResolverPrompt,
  parseResolution,
  executeConflictResolver
};

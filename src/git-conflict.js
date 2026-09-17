const { runChecked } = require("./process");
const fs = require("node:fs/promises");
const path = require("node:path");

const RESOLVED_OPERATION_STATES = new Set(["completed", "resolved", "manually-resolved"]);

async function optionalGit(runner, args, options) {
  try {
    const result = await runner("git", args, options);
    return { ok: result.code === undefined || result.code === 0, ...result };
  } catch (error) {
    return { ok: false, stdout: error.result?.stdout || "", stderr: error.result?.stderr || "", error };
  }
}

function parseUnmerged(text) {
  const files = [];
  for (const record of String(text || "").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab >= 0) files.push(record.slice(tab + 1));
  }
  return [...new Set(files)].sort();
}

async function inspectGitOperation(worktreePath, { runner = runChecked, timeoutMs = null } = {}) {
  const options = { cwd: worktreePath, ...(timeoutMs ? { timeoutMs } : {}) };
  const [rebaseMergePath, rebaseApplyPath, mergePath, unmerged, status, head, originalHead, rebaseHead, mergeHead] = await Promise.all([
    optionalGit(runner, ["rev-parse", "--git-path", "rebase-merge"], options),
    optionalGit(runner, ["rev-parse", "--git-path", "rebase-apply"], options),
    optionalGit(runner, ["rev-parse", "--git-path", "MERGE_HEAD"], options),
    optionalGit(runner, ["ls-files", "-u", "-z"], options),
    optionalGit(runner, ["status", "--porcelain=v1", "--untracked-files=all"], options),
    optionalGit(runner, ["rev-parse", "HEAD"], options),
    optionalGit(runner, ["rev-parse", "--verify", "ORIG_HEAD"], options),
    optionalGit(runner, ["rev-parse", "--verify", "REBASE_HEAD"], options),
    optionalGit(runner, ["rev-parse", "--verify", "MERGE_HEAD"], options)
  ]);
  function gitPath(result) {
    if (!result.ok || !result.stdout.trim()) return false;
    return path.resolve(worktreePath, result.stdout.trim());
  }
  async function exists(result) {
    const candidate = gitPath(result);
    if (!candidate) return false;
    try { await fs.access(candidate); return true; } catch { return false; }
  }
  async function readOperationFile(directoryResult, name) {
    const directory = gitPath(directoryResult);
    if (!directory) return null;
    try { return (await fs.readFile(path.join(directory, name), "utf8")).trim() || null; } catch { return null; }
  }
  const rebaseMergeActive = await exists(rebaseMergePath);
  const rebaseApplyActive = await exists(rebaseApplyPath);
  const rebaseActive = rebaseMergeActive || rebaseApplyActive;
  const mergeActive = await exists(mergePath);
  const operation = rebaseActive ? "rebase" : mergeActive ? "merge" : null;
  const operationOriginalHeadSha = operation && originalHead.ok ? originalHead.stdout.trim() || null : null;
  const rebaseHeadSha = rebaseActive && rebaseHead.ok ? rebaseHead.stdout.trim() || null : null;
  const mergeHeadSha = mergeActive && mergeHead.ok ? mergeHead.stdout.trim() || null : null;
  const operationOntoSha = rebaseActive
    ? await readOperationFile(rebaseMergeActive ? rebaseMergePath : rebaseApplyPath, "onto")
    : null;
  return {
    operation,
    operationActive: rebaseActive || mergeActive,
    // ORIG_HEAD is the implementation tip on which the operation began. The
    // operation-specific head is the commit Git is applying/merging, while
    // `onto` (rebase) or MERGE_HEAD (merge) is the intended target revision.
    operationOriginalHeadSha,
    operationCurrentHeadSha: head.ok ? head.stdout.trim() || null : null,
    operationHeadSha: rebaseActive ? rebaseHeadSha : mergeHeadSha,
    operationOntoSha,
    operationMergeHeadSha: mergeHeadSha,
    operationSourceSha: operationOriginalHeadSha,
    operationTargetSha: rebaseActive ? operationOntoSha : mergeHeadSha,
    headSha: head.ok ? head.stdout.trim() || null : null,
    conflictedFiles: unmerged.ok ? parseUnmerged(unmerged.stdout) : [],
    status: status.ok ? status.stdout.trim() : null
  };
}

function conflictContinuation({ stage, issue, sourceRunId }) {
  if (issue == null) return null;
  if (stage === "integration-refresh") {
    return sourceRunId == null ? null : `maestro reconcile --run ${sourceRunId} --issue ${issue}`;
  }
  if (stage === "reconciliation-refresh") {
    return sourceRunId == null ? null : `maestro reconcile --run ${sourceRunId} --issue ${issue}`;
  }
  return sourceRunId ? `maestro rework ${issue} --run ${sourceRunId}` : `maestro rework ${issue}`;
}

function isUnresolvedConflict(conflict) {
  return Boolean(conflict) && !RESOLVED_OPERATION_STATES.has(conflict.operationState);
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

function conflictRecoveryCommands(conflict) {
  if (!conflict || RESOLVED_OPERATION_STATES.has(conflict.operationState)) return [];
  const operation = conflict.operation || "rebase";
  const commands = [];
  if (conflict.worktreePath) commands.push(`cd ${shellQuote(conflict.worktreePath)}`);
  if (conflict.operationState === "aborted") {
    if (conflict.targetBranch) commands.push(`git fetch origin ${shellQuote(conflict.targetBranch)}`);
    if (conflict.targetRef) commands.push(`git ${operation} ${shellQuote(conflict.targetRef)}`);
  }
  if (conflict.conflictedFiles?.length) {
    commands.push(`git add -A -- ${conflict.conflictedFiles.map(shellQuote).join(" ")}`);
  }
  commands.push(`GIT_EDITOR=true git ${operation} --continue`);
  if (conflict.continuationAction) commands.push(conflict.continuationAction);
  return commands;
}

async function captureConflict({
  repository = null,
  issue = null,
  sourceRunId = null,
  parentRunId = null,
  stage,
  interruptedAction,
  worktreePath,
  branch = null,
  originalBaseSha = null,
  sourceSha = null,
  targetBranch = "main",
  targetRef = null,
  targetSha = null,
  expectedOperation = "rebase",
  startedByMaestro = true,
  failure = null,
  runner = runChecked,
  timeoutMs = null
}) {
  const observed = await inspectGitOperation(worktreePath, { runner, timeoutMs });
  if (!observed.operationActive && observed.conflictedFiles.length === 0) return null;
  const operation = observed.operation || expectedOperation;
  return {
    contractVersion: 1,
    type: "content",
    repository,
    issue: issue == null ? null : String(issue),
    sourceRunId: sourceRunId == null ? null : String(sourceRunId),
    parentRunId: parentRunId == null ? null : String(parentRunId),
    operation,
    operationOwner: startedByMaestro ? "maestro" : "user",
    operationState: "active",
    resolutionState: "awaiting-technical-resolution",
    requiresSemanticHumanDecision: false,
    interruptedStage: stage,
    interruptedAction,
    worktreePath,
    branch,
    originalBaseSha,
    sourceSha: sourceSha || observed.operationSourceSha || observed.headSha,
    operationOriginalHeadSha: observed.operationOriginalHeadSha,
    operationCurrentHeadSha: observed.operationCurrentHeadSha,
    operationHeadSha: observed.operationHeadSha,
    operationOntoSha: observed.operationOntoSha,
    operationMergeHeadSha: observed.operationMergeHeadSha,
    targetBranch,
    targetRef: targetRef || `origin/${targetBranch}`,
    targetSha: targetSha || observed.operationTargetSha,
    conflictedFiles: observed.conflictedFiles,
    statusEvidence: observed.status,
    failure: failure?.message || String(failure || "Git content conflict"),
    stderr: failure?.result?.stderr?.trim() || null,
    continuationAction: conflictContinuation({ stage, issue, sourceRunId }),
    preservation: {
      existingUserEditsPreserved: !startedByMaestro,
      partialResolutionsPreserved: !startedByMaestro && observed.operationActive,
      recoveryArtifacts: []
    }
  };
}

async function safelyAbortConflict(conflict, { runner = runChecked, timeoutMs = null } = {}) {
  if (!conflict || conflict.operationOwner !== "maestro" || conflict.operationState !== "active") return conflict;
  try {
    await runner("git", [conflict.operation, "--abort"], {
      cwd: conflict.worktreePath,
      ...(timeoutMs ? { timeoutMs } : {})
    });
    conflict.operationState = "aborted";
  } catch (error) {
    conflict.abortError = error.message;
  }
  return conflict;
}

function contentConflictError(conflict, cause) {
  const files = conflict.conflictedFiles.length ? ` Conflicted files: ${conflict.conflictedFiles.join(", ")}.` : "";
  const continuation = conflict.continuationAction
    ? `Inspect \`maestro details ${conflict.issue}\`; continue with \`${conflict.continuationAction}\`.`
    : "No Maestro continuation is available for this conflict; inspect the preserved worktree state directly.";
  const error = new Error(
    `Git ${conflict.operation} content conflict interrupted ${conflict.interruptedAction} for ` +
    `${conflict.issue == null ? "an unassociated implementation" : `issue #${conflict.issue}`}.` +
    `${files} State is ${conflict.operationState} at ${conflict.worktreePath}. ${continuation}`
  );
  error.code = "GIT_CONTENT_CONFLICT";
  error.outcome = "technical-conflict";
  error.issue = conflict.issue;
  error.conflict = conflict;
  error.cause = cause;
  return error;
}

async function isAncestor(ancestor, descendant, { cwd, runner = runChecked, timeoutMs = null }) {
  if (!ancestor || !descendant) return false;
  const result = await optionalGit(runner, ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    ...(timeoutMs ? { timeoutMs } : {})
  });
  return result.ok;
}

module.exports = {
  inspectGitOperation,
  captureConflict,
  safelyAbortConflict,
  contentConflictError,
  conflictContinuation,
  conflictRecoveryCommands,
  isUnresolvedConflict,
  isAncestor
};

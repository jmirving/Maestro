const path = require("node:path");
const { runChecked, runShell } = require("./process");
const { isValidValidatorOverride } = require("./reviews");
const { inspectGitOperation, captureConflict, safelyAbortConflict, contentConflictError } = require("./git-conflict");
const { digest, validationContext, isDelegatedAssessment } = require("./authorization");
const { withRepositoryCoordination } = require("./repository-coordination");

async function ensureClean(repoPath, runner = runChecked) {
  const status = (await runner("git", ["status", "--porcelain"], { cwd: repoPath })).stdout.trim();
  if (status) throw new Error(`Target default-branch checkout is not clean:\n${status}`);
}

function repositoryRelativeManifest(repoPath, manifestPath) {
  if (!manifestPath) return null;
  const relative = path.relative(repoPath, manifestPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The resolved Maestro manifest must be a file inside the target repository before integration can preserve it safely.");
  }
  return relative;
}

async function statusFor(repoPath, pathspec, runner) {
  return (await runner("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", pathspec], { cwd: repoPath })).stdout.trim();
}

async function ignoredStatusFor(repoPath, pathspec, runner) {
  return (await runner("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--", pathspec], { cwd: repoPath })).stdout.trim();
}

async function dropStash(repoPath, stashSha, runner) {
  const list = (await runner("git", ["stash", "list", "--format=%H"], { cwd: repoPath })).stdout.trim().split("\n");
  const index = list.findIndex((sha) => sha === stashSha);
  if (index >= 0) await runner("git", ["stash", "drop", `stash@{${index}}`], { cwd: repoPath });
}

async function restoreManifest(repoPath, relativeManifest, stashSha, runner) {
  try {
    await runner("git", ["stash", "apply", "--index", stashSha], { cwd: repoPath });
    await dropStash(repoPath, stashSha, runner);
  } catch (error) {
    const recovery = new Error(
      `Maestro could not restore ${relativeManifest} after integration. Its original state remains recoverable in Git stash ${stashSha}. ` +
      `Resolve the manifest conflict, then drop that stash manually once its contents are preserved.`
    );
    recovery.cause = error;
    throw recovery;
  }
}

async function withPreservedManifest({ repoPath, manifestPath, runner = runChecked }, operation) {
  const relativeManifest = repositoryRelativeManifest(repoPath, manifestPath);
  if (!relativeManifest) {
    await ensureClean(repoPath, runner);
    return operation();
  }

  const allStatus = await statusFor(repoPath, ".", runner);
  const manifestStatus = await statusFor(repoPath, relativeManifest, runner);
  if (allStatus !== manifestStatus) {
    throw new Error(
      `Target default-branch checkout has changes outside the resolved Maestro manifest (${relativeManifest}). ` +
      `Commit, stash, or remove the unrelated working-tree state before integration:\n${allStatus}`
    );
  }

  let stashSha = null;
  const ignoredManifestStatus = await ignoredStatusFor(repoPath, relativeManifest, runner);
  if (manifestStatus || ignoredManifestStatus) {
    await runner("git", ["stash", "push", "--all", "--message", "maestro: preserve manifest during integration", "--", relativeManifest], { cwd: repoPath });
    stashSha = (await runner("git", ["rev-parse", "refs/stash"], { cwd: repoPath })).stdout.trim();
  }

  let result;
  let operationError = null;
  try {
    await ensureClean(repoPath, runner);
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  if (stashSha) {
    try {
      await restoreManifest(repoPath, relativeManifest, stashSha, runner);
    } catch (restoreError) {
      if (operationError) restoreError.integrationError = operationError;
      throw restoreError;
    }
  }
  if (operationError) throw operationError;
  return result;
}

function normalizeFailureOutput(text = "") {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "<time>")
    .replace(/\bduration_ms:\s*\d+(?:\.\d+)?/g, "duration_ms:<time>")
    .replace(/\/home\/[^\s:]+/g, "<path>")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:not ok|fail(?:ed|ure)?|error:|timeout|ERR_|✘|×)/i.test(line))
    .sort()
    .join("\n");
}

function failureSignatures(text = "") {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, "");
  const signatures = [];
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    let match = line.match(/^not ok\s+\d+\s+-\s+(.+)$/i);
    if (match) {
      signatures.push(`tap:${match[1].trim()}`);
      continue;
    }
    match = line.match(/^\d+\)\s+(?:\[[^\]]+\]\s+)?›\s+(.+)$/);
    if (match) {
      signatures.push(`playwright:${match[1].replace(/:\d+:\d+/g, ":<line>").trim()}`);
    }
  }
  return [...new Set(signatures)].sort();
}

function baselineResultForCommand(baseline, command) {
  return baseline?.results?.find((entry) => entry.command === command) || null;
}

function isAcceptedBaselineFailure({ baseline, command, result }) {
  if (baseline?.allowFailing !== true || result.code === 0) return false;
  const prior = baselineResultForCommand(baseline, command);
  if (!prior || prior.code === 0) return false;

  const priorText = `${prior.stdout || ""}\n${prior.stderr || ""}`;
  const currentText = `${result.stdout || ""}\n${result.stderr || ""}`;
  const priorSignatures = failureSignatures(priorText);
  const currentSignatures = failureSignatures(currentText);

  if (priorSignatures.length || currentSignatures.length) {
    return priorSignatures.length > 0 && JSON.stringify(priorSignatures) === JSON.stringify(currentSignatures);
  }

  const priorFingerprint = normalizeFailureOutput(priorText);
  const currentFingerprint = normalizeFailureOutput(currentText);
  return priorFingerprint.length > 0 && priorFingerprint === currentFingerprint;
}

async function runIntegrationCommand(command, { cwd, baseline, shellRunner = runShell }) {
  console.error(`[Maestro] integration check: ${command}`);
  const result = await shellRunner(command, { cwd, stream: true, streamPrefix: "[integration] " });
  if (result.code === 0) return result;
  if (isAcceptedBaselineFailure({ baseline, command, result })) return { ...result, acceptedBaselineFailure: true };

  const prior = baselineResultForCommand(baseline, command);
  const error = new Error(`integration validation failed: ${command}`);
  error.code = "INTEGRATION_CHECK_FAILED";
  error.command = command;
  error.result = result;
  error.baselineComparison = prior ? {
    baselineSignatures: failureSignatures(`${prior.stdout || ""}\n${prior.stderr || ""}`),
    currentSignatures: failureSignatures(`${result.stdout || ""}\n${result.stderr || ""}`)
  } : null;
  throw error;
}

async function integrateApproved({
  config,
  repoPath,
  manifestPath = null,
  workers,
  validations,
  reviewAuthorizations = [],
  baseline = null,
  runner = runChecked,
  shellRunner = runShell,
  onIntegrated = null,
  sourceRunId = null,
  onConflict = null,
  onCheckFailure = null,
  revalidateDelegated = null,
  coordinate = withRepositoryCoordination
}) {
  const integration = config.integration || {};
  if (integration.enabled !== true) throw new Error("Manifest does not enable integration.");
  const defaultBranch = config.defaultBranch || "main";
  const validationByIssue = new Map(validations.map((entry) => [String(entry.issue), entry]));
  const authorizationByIssue = new Map(reviewAuthorizations.map((entry) => [String(entry.issue), entry]));
  const approved = workers.filter((worker) => {
    if (worker.exitCode !== 0) return false;
    const issue = String(worker.issue);
    const validation = validationByIssue.get(issue);
    const authorization = authorizationByIssue.get(issue) || {};
    const humanApproved = validation?.verdict === "approve" &&
      ["approve", "approve-with-follow-up"].includes(authorization.review?.disposition);
    const overridden = isValidValidatorOverride(authorization.review, validation);
    return humanApproved || overridden || (
      authorization.delegated?.eligible === true && isDelegatedAssessment(authorization.delegated)
    );
  });
  const unauthorized = workers.filter((worker) => {
    const validation = validationByIssue.get(String(worker.issue));
    return worker.exitCode === 0 && validation?.verdict === "approve" && !approved.includes(worker);
  });
  if (unauthorized.length) {
    throw new Error(`Integration authorization is missing for ${unauthorized.map((worker) => `issue #${worker.issue}`).join(", ")}. Validator approval alone is not human review or delegated integration authority.`);
  }
  const results = [];

  return withPreservedManifest({ repoPath, manifestPath, runner }, async () => {
    for (const worker of approved) {
      console.error(`[Maestro] integrating #${worker.issue}`);
      const validation = validationByIssue.get(String(worker.issue));
      const currentHead = (await runner("git", ["rev-parse", "HEAD"], { cwd: worker.worktreePath })).stdout.trim();
      if (worker.headSha && currentHead !== worker.headSha) {
        throw new Error(`Implementation for issue #${worker.issue} changed after validation (${worker.headSha} -> ${currentHead}); fresh independent validation is required.`);
      }
      if (validation?.evidence?.implementationSha && validation.evidence.implementationSha !== currentHead) {
        throw new Error(`Validation for issue #${worker.issue} is stale for the current implementation; fresh independent validation is required.`);
      }
      const scopeRevision = authorizationByIssue.get(String(worker.issue))?.delegated?.scopeRevision || null;
      if (validation?.evidence && digest(validation.evidence) !== digest(validationContext(config, worker, worker.issue, scopeRevision))) {
        throw new Error(`Validation for issue #${worker.issue} was produced under a different acceptance, check, capability, or baseline context; fresh independent validation is required.`);
      }
      const beforeOperation = await inspectGitOperation(worker.worktreePath, { runner });
      if (beforeOperation.operationActive || beforeOperation.conflictedFiles.length) {
        const conflict = await captureConflict({
          repository: config.repository, issue: worker.issue, sourceRunId,
          stage: "integration-refresh", interruptedAction: "serialized integration refresh",
          worktreePath: worker.worktreePath, branch: worker.branch || null,
          originalBaseSha: worker.baseSha || null, targetBranch: defaultBranch,
          startedByMaestro: false, runner
        });
        if (onConflict) await onConflict(conflict);
        throw contentConflictError(conflict);
      }
      if (beforeOperation.status) {
        throw new Error(`Integration branch for issue #${worker.issue} is not clean:\n${beforeOperation.status}`);
      }
      await runner("git", ["fetch", "origin", defaultBranch], { cwd: worker.worktreePath });
      const targetSha = (await runner("git", ["rev-parse", `origin/${defaultBranch}`], { cwd: worker.worktreePath })).stdout.trim();
      const sourceSha = currentHead;
      const beforeRebase = currentHead;
      await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: worker.worktreePath }).catch(async (error) => {
        const conflict = await captureConflict({
          repository: config.repository,
          issue: worker.issue,
          sourceRunId,
          stage: "integration-refresh",
          interruptedAction: "serialized integration refresh",
          worktreePath: worker.worktreePath,
          branch: worker.branch || null,
          originalBaseSha: worker.baseSha || null,
          sourceSha,
          targetBranch: defaultBranch,
          targetSha,
          failure: error,
          runner
        });
        if (!conflict) throw error;
        if (onConflict) await onConflict(conflict);
        await safelyAbortConflict(conflict, { runner });
        if (onConflict) await onConflict(conflict);
        throw contentConflictError(conflict, error);
      });
      const afterRebase = (await runner("git", ["rev-parse", "HEAD"], { cwd: worker.worktreePath })).stdout.trim();
      if (afterRebase !== beforeRebase) {
        throw new Error(`Rebase changed issue #${worker.issue} from ${beforeRebase} to ${afterRebase}; delegated or human approval evidence is stale and fresh independent validation is required.`);
      }

      const relativeManifest = repositoryRelativeManifest(repoPath, manifestPath);
      if (relativeManifest) {
        const changedManifest = (await runner("git", ["diff", "--name-only", `origin/${defaultBranch}...HEAD`, "--", relativeManifest], { cwd: worker.worktreePath })).stdout.trim();
        if (changedManifest) {
          throw new Error(
            `Worker branch ${worker.branch} changes the Maestro manifest (${relativeManifest}). ` +
            "Manifest progress is owned by maestro commit and must be resolved separately before integration."
          );
        }
      }

      const validationResults = [];
      for (const command of integration.commands || []) {
        try {
          validationResults.push({ command, ...(await runIntegrationCommand(command, { cwd: worker.worktreePath, baseline, shellRunner })) });
        } catch (error) {
          if (error.code !== "INTEGRATION_CHECK_FAILED") throw error;
          Object.assign(error, {
            issue: String(worker.issue),
            worker,
            sourceRunId,
            targetSha,
            sourceSha: (await runner("git", ["rev-parse", "HEAD"], { cwd: worker.worktreePath })).stdout.trim(),
            validationResults
          });
          if (onCheckFailure) await onCheckFailure(error);
          throw error;
        }
      }

      await coordinate(repoPath, async () => {
        let permission = authorizationByIssue.get(String(worker.issue)) || {};
        if (permission.delegated) {
          if (typeof revalidateDelegated !== "function") {
            throw new Error(`Delegated integration authorization for issue #${worker.issue} cannot be revalidated at the serialized integration boundary.`);
          }
          const current = await revalidateDelegated({ worker, validation, authorization: permission.delegated });
          if (!current?.eligible || !isDelegatedAssessment(current) || current.authorizationId !== permission.delegated.authorizationId) {
            throw new Error(`Delegated integration authorization for issue #${worker.issue} is no longer eligible: ${current?.reason || "authorization evidence changed"}.`);
          }
          permission = { ...permission, delegated: current };
          authorizationByIssue.set(String(worker.issue), permission);
        }

        await runner("git", ["checkout", defaultBranch], { cwd: repoPath });
        await runner("git", ["pull", "--ff-only", "origin", defaultBranch], { cwd: repoPath });
        const before = (await runner("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
        try {
          await runner("git", ["merge", "--ff-only", worker.branch], { cwd: repoPath });
          for (const command of integration.postMergeCommands || []) {
            try {
              await runIntegrationCommand(command, { cwd: repoPath, baseline, shellRunner });
            } catch (error) {
              if (error.code === "INTEGRATION_CHECK_FAILED") {
                Object.assign(error, {
                  issue: String(worker.issue),
                  worker,
                  sourceRunId,
                  targetSha,
                  sourceSha: (await runner("git", ["rev-parse", "HEAD"], { cwd: worker.worktreePath })).stdout.trim(),
                  validationResults,
                  checkStage: "post-merge"
                });
              }
              throw error;
            }
          }
          await runner("git", ["push", "origin", defaultBranch], { cwd: repoPath });
        } catch (error) {
          try { await runner("git", ["reset", "--hard", before], { cwd: repoPath }); } catch {}
          if (error.code === "INTEGRATION_CHECK_FAILED" && onCheckFailure) await onCheckFailure(error);
          throw error;
        }

        const integratedSha = (await runner("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
        const closureAuthorized = permission.review != null || permission.delegated?.allowedActions?.closeIssue === true;
        if (integration.closeIssues === true && closureAuthorized) {
          await runner("gh", ["issue", "close", String(worker.issue), "--repo", config.repository, "--reason", "completed", "--comment", `Integrated by Maestro at ${integratedSha}.`], { cwd: repoPath });
        }
        const integrated = {
          issue: worker.issue,
          branch: worker.branch,
          integratedSha,
          validationResults,
          authorization: permission.delegated?.eligible
            ? { kind: "delegated", id: permission.delegated.authorizationId }
            : { kind: permission.review?.disposition === "approve-override" ? "human-override" : "human-review", recordedAt: permission.review?.recordedAt || null }
        };
        results.push(integrated);
        if (onIntegrated) await onIntegrated(integrated);
        console.error(`[Maestro] integrated #${worker.issue} at ${integratedSha}`);
      });
    }
    return results;
  });
}

module.exports = {
  ensureClean,
  repositoryRelativeManifest,
  withPreservedManifest,
  normalizeFailureOutput,
  failureSignatures,
  isAcceptedBaselineFailure,
  runIntegrationCommand,
  integrateApproved
};

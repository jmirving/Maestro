const { runChecked, runShell } = require("./process");

async function ensureClean(repoPath, runner = runChecked) {
  const status = (await runner("git", ["status", "--porcelain"], { cwd: repoPath })).stdout.trim();
  if (status) throw new Error(`Target default-branch checkout is not clean:\n${status}`);
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
  const result = await shellRunner(command, { cwd });
  if (result.code === 0) return result;
  if (isAcceptedBaselineFailure({ baseline, command, result })) return { ...result, acceptedBaselineFailure: true };

  const prior = baselineResultForCommand(baseline, command);
  const error = new Error(`integration validation failed: ${command}`);
  error.result = result;
  error.baselineComparison = prior ? {
    baselineSignatures: failureSignatures(`${prior.stdout || ""}\n${prior.stderr || ""}`),
    currentSignatures: failureSignatures(`${result.stdout || ""}\n${result.stderr || ""}`)
  } : null;
  throw error;
}

async function integrateApproved({ config, repoPath, workers, validations, baseline = null, runner = runChecked, shellRunner = runShell }) {
  const integration = config.integration || {};
  if (integration.enabled !== true) throw new Error("Manifest does not enable integration.");
  const defaultBranch = config.defaultBranch || "main";
  const verdicts = new Map(validations.map((entry) => [String(entry.issue), entry.verdict]));
  const approved = workers.filter((worker) => worker.exitCode === 0 && verdicts.get(String(worker.issue)) === "approve");
  const results = [];

  await ensureClean(repoPath, runner);
  for (const worker of approved) {
    await runner("git", ["fetch", "origin", defaultBranch], { cwd: worker.worktreePath });
    await runner("git", ["rebase", `origin/${defaultBranch}`], { cwd: worker.worktreePath }).catch(async (error) => {
      try { await runner("git", ["rebase", "--abort"], { cwd: worker.worktreePath }); } catch {}
      throw error;
    });

    const validationResults = [];
    for (const command of integration.commands || []) {
      validationResults.push({ command, ...(await runIntegrationCommand(command, { cwd: worker.worktreePath, baseline, shellRunner })) });
    }

    await runner("git", ["checkout", defaultBranch], { cwd: repoPath });
    await runner("git", ["pull", "--ff-only", "origin", defaultBranch], { cwd: repoPath });
    const before = (await runner("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    try {
      await runner("git", ["merge", "--ff-only", worker.branch], { cwd: repoPath });
      for (const command of integration.postMergeCommands || []) {
        await runIntegrationCommand(command, { cwd: repoPath, baseline, shellRunner });
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
    results.push({ issue: worker.issue, branch: worker.branch, integratedSha, validationResults });
  }
  return results;
}

module.exports = { ensureClean, normalizeFailureOutput, failureSignatures, isAcceptedBaselineFailure, runIntegrationCommand, integrateApproved };

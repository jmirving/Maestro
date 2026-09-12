#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parseInvocation, resolveHelp } = require("../src/help");
const { computePlan } = require("../src/planner");
const { computeEffectivePlan, loadExecutionStates } = require("../src/work-state");
const { dryRun, executeRun, executeAndIntegrate, continuousRun } = require("../src/controller");
const { latestRunBundle, copyToClipboard } = require("../src/reporter");
const { recordReview } = require("../src/reviews");
const { approveIssues, formatApprovalSummary } = require("../src/approval");
const { discardIssues, formatDiscardSummary } = require("../src/discard");
const { integrateExistingRun } = require("../src/existing-run");
const {
  resolveIssueReworkSources,
  resolveReworkParentRunId,
  executeReworkRun,
  autoRework
} = require("../src/rework");
const { executeReconcileRun } = require("../src/reconcile");
const { latestRunId } = require("../src/run-store");
const { statusSnapshot, formatStatus, watchStatus } = require("../src/display");
const { formatRecommendationFooter, appendRecommendationFooter } = require("../src/recommendations");
const { loadIssueDetails, formatDetails } = require("../src/details");
const { discoverGitHubRepository, loadGitHubIssues } = require("../src/github");
const { proposeDraft, formatDraftSummary, readManifestSnapshot, writeManifest, detectExecutionDrift } = require("../src/draft");
const { createAgentPlanner } = require("../src/agent-planner");
const { runPlanningAnalyzer } = require("../src/planning-analysis");
const {
  resolveRepoPath,
  resolveManifestPath,
  resolveDraftManifestPath,
  looksLikeManifest,
  persistManifestCompletion
} = require("../src/cli-context");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function explicitManifest(rest) {
  return looksLikeManifest(rest[0]) ? rest[0] : null;
}

function issuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const start = manifest ? 1 : 0;
  const issues = [];
  for (let index = start; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--run"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (value === "--override") continue;
    if (value.startsWith("--")) throw new Error(`Unknown review option: ${value}`);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  return [...new Set(issues)];
}

function draftIssuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const issues = [];
  for (let index = manifest ? 1 : 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--repo-path") {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    if (!/^\d+$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  return [...new Set(issues)];
}

function detailsIssuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const issues = [];
  for (let index = manifest ? 1 : 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--run"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown maestro details option: ${value}`);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  const unique = [...new Set(issues)];
  if (!unique.length) throw new Error("maestro details requires at least one issue number.");
  return unique;
}

function statusIssuePositionals(rest) {
  const manifest = explicitManifest(rest);
  const issues = [];
  for (let index = manifest ? 1 : 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--repo-path") {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error("--repo-path requires a value.");
      index += 1;
      continue;
    }
    if (value === "--watch") continue;
    if (value.startsWith("--")) throw new Error(`Unknown maestro status option: ${value}`);
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  return [...new Set(issues)];
}

function reworkPositionals(rest) {
  const issues = [];
  const manifests = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (["--repo-path", "--run"].includes(value)) {
      if (!rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error(`${value} requires a value.`);
      index += 1;
      continue;
    }
    if (value === "--allow-failing-baseline") continue;
    if (value.startsWith("--")) throw new Error(`Unknown maestro rework option: ${value}`);
    if (looksLikeManifest(value)) {
      manifests.push(value);
      continue;
    }
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid issue number: ${value}`);
    issues.push(value);
  }
  if (manifests.length > 1) {
    throw new Error(`maestro rework received multiple manifest paths: ${manifests.join(", ")}.`);
  }
  return { manifest: manifests[0] || null, issues: [...new Set(issues)] };
}

function resolveContext(rest, args, { manifest = true } = {}) {
  const repoPath = resolveRepoPath(option(args, "--repo-path"));
  if (!manifest) return { repoPath };
  const manifestPath = resolveManifestPath(explicitManifest(rest), repoPath);
  return { repoPath, manifestPath };
}

function loadConfig(manifestPath, args) {
  const config = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (args.includes("--allow-failing-baseline")) {
    config.baseline = { ...(config.baseline || {}), allowFailing: true };
  }
  return config;
}

function setResultExitCode(result) {
  if (result.status === "failed") process.exitCode = 1;
  if (result.workers?.some((worker) => worker.exitCode !== 0)) process.exitCode = 1;
  if (result.validations?.some((entry) => entry.verdict !== "approve")) process.exitCode = 1;
}

function setAutoReworkExitCode(result) {
  if (result.issues?.some((entry) => entry.outcome !== "approved")) process.exitCode = 1;
}

async function workflowFooter(config, repoPath, { includeIssues = true } = {}) {
  const snapshot = await statusSnapshot(config || { work: {} }, repoPath);
  return formatRecommendationFooter(snapshot, { includeIssues });
}

async function outputLatest(repoPath, { copy = true, print = true, config = null, recommendations = false } = {}) {
  const bundle = await latestRunBundle(repoPath);
  const text = recommendations
    ? appendRecommendationFooter(bundle.text, await workflowFooter(config, repoPath))
    : bundle.text;
  if (print) process.stdout.write(text);
  if (copy) {
    const clipboard = copyToClipboard(text);
    console.error(`Copied Maestro run ${bundle.runId} to clipboard using ${clipboard}.`);
  }
  return { ...bundle, text };
}

async function approveLatest({ config, repoPath, runId, requestedIssues, override = false }) {
  const result = await approveIssues({ config, repoPath, runId, requestedIssues, override });
  process.stdout.write(formatApprovalSummary(result));
  return result;
}

async function commitLatest({ config, repoPath, manifestPath, runId, closeIssues }) {
  const resolvedRunId = runId || await latestRunId(repoPath);
  const result = await integrateExistingRun(config, {
    repoPath,
    manifestPath,
    runId: resolvedRunId,
    closeIssues
  });
  const integratedIssues = [...new Set((result.integration || []).map((entry) => String(entry.issue)))];
  const newlyIntegratedIssues = [...new Set((result.newlyIntegrated || []).map((entry) => String(entry.issue)))];
  const newlyIntegrated = new Set(newlyIntegratedIssues);
  const alreadyIntegratedIssues = integratedIssues.filter((issue) => !newlyIntegrated.has(issue));
  const progress = persistManifestCompletion({ repoPath, manifestPath, issueIds: integratedIssues });
  const outcome = result.nothingToDo
    ? `nothing remaining${alreadyIntegratedIssues.length ? `; already integrated ${alreadyIntegratedIssues.map((issue) => `#${issue}`).join(", ")}` : ""}`
    : [
        newlyIntegratedIssues.length ? `newly integrated ${newlyIntegratedIssues.map((issue) => `#${issue}`).join(", ")}` : null,
        alreadyIntegratedIssues.length ? `already integrated ${alreadyIntegratedIssues.map((issue) => `#${issue}`).join(", ")}` : null
      ].filter(Boolean).join("; ") || "nothing remaining";
  console.log(`Committed Maestro run ${resolvedRunId}: ${outcome}`);
  if (progress.changed.length) console.log(`Advanced ${manifestPath}: ${progress.changed.map((issue) => `#${issue}`).join(", ")}`);
  return { ...result, manifestProgress: progress };
}

async function main() {
  const args = process.argv.slice(2);
  const help = resolveHelp(args);
  if (help.requested) {
    process.stdout.write(`${help.text}\n`);
    return;
  }
  const invocation = parseInvocation(args);
  const command = invocation.command;
  const rest = args.slice(1);

  if (command === "output") {
    const { repoPath } = resolveContext(rest, args, { manifest: false });
    const defaultManifestPath = path.join(repoPath, ".maestro.json");
    const config = fs.existsSync(defaultManifestPath) ? loadConfig(defaultManifestPath, args) : null;
    await outputLatest(repoPath, { copy: true, print: true, config, recommendations: true });
    return;
  }

  if (command === "report") {
    const { repoPath } = resolveContext(rest, args, { manifest: false });
    await outputLatest(repoPath, { copy: args.includes("--copy"), print: true });
    return;
  }

  if (command === "draft") {
    const repoPath = resolveRepoPath(option(args, "--repo-path"));
    const manifestPath = resolveDraftManifestPath(explicitManifest(rest), repoPath);
    const requestedIssues = draftIssuePositionals(rest);
    if (args.includes("--all") && requestedIssues.length) {
      throw new Error("maestro draft accepts either selected issue numbers or --all, not both.");
    }
    const repository = await discoverGitHubRepository(repoPath);
    const issues = await loadGitHubIssues(repository, requestedIssues, { repoPath });
    const manifestSnapshot = readManifestSnapshot(manifestPath);
    const existingConfig = manifestSnapshot.config;
    const executionStates = await loadExecutionStates(repoPath);
    const deterministicResult = proposeDraft({
      repository,
      existingConfig,
      issues,
      selectedIssueIds: requestedIssues,
      executionStates
    });
    let agentAnalysis = null;
    if (args.includes("--agent")) {
      const contextManifest = JSON.parse(JSON.stringify(deterministicResult.manifest));
      if (contextManifest.planning?.agentAnalysis) delete contextManifest.planning.agentAnalysis;
      if (contextManifest.planning?.advisoryConflicts) {
        contextManifest.planning.advisoryConflicts = contextManifest.planning.advisoryConflicts.filter((conflict) => conflict.analyzer !== "agent");
        if (!contextManifest.planning.advisoryConflicts.length) delete contextManifest.planning.advisoryConflicts;
      }
      if (contextManifest.planning && !Object.keys(contextManifest.planning).length) delete contextManifest.planning;
      agentAnalysis = await runPlanningAnalyzer(createAgentPlanner(), {
        repoPath,
        repository,
        issues,
        manifest: contextManifest,
        deterministicFindings: {
          dependencies: deterministicResult.dependencySources,
          conflicts: deterministicResult.inferredConflicts.filter((conflict) => conflict.analyzer !== "agent"),
          unresolved: deterministicResult.unresolved,
          expectedWaves: deterministicResult.planning.waves
        }
      });
    }
    const result = agentAnalysis ? proposeDraft({
      repository,
      existingConfig,
      issues,
      selectedIssueIds: requestedIssues,
      agentAnalysis,
      executionStates
    }) : deterministicResult;
    const write = args.includes("--write");
    process.stdout.write(formatDraftSummary({ repository, manifestPath, result, write }));
    if (write && !result.writable) {
      process.exitCode = 1;
      return;
    }
    if (write && result.changed) writeManifest(manifestPath, result.manifest, { expectedContents: manifestSnapshot.contents });
    return;
  }

  const reworkArgs = command === "rework" ? reworkPositionals(rest) : null;
  let context;
  if (reworkArgs) {
    const repoPath = resolveRepoPath(option(args, "--repo-path"));
    context = { repoPath, manifestPath: resolveManifestPath(reworkArgs.manifest, repoPath) };
  } else {
    context = resolveContext(rest, args);
  }
  const { repoPath, manifestPath } = context;
  const config = loadConfig(manifestPath, args);

  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(computePlan(config), null, 2)}\n`);
    return;
  }

  if (command === "status") {
    const requestedIssues = statusIssuePositionals(rest);
    if (args.includes("--watch")) await watchStatus(config, repoPath, requestedIssues);
    else process.stdout.write(formatStatus(await statusSnapshot(config, repoPath, requestedIssues)));
    return;
  }

  if (command === "details") {
    const requestedIssues = detailsIssuePositionals(rest);
    const details = await loadIssueDetails(repoPath, requestedIssues, {
      runId: option(args, "--run"),
      config
    });
    process.stdout.write(formatDetails(details, { repository: config.repository }));
    return;
  }

  if (command === "start" || command === "next") {
    const plan = args.includes("--rerun") ? computePlan(config) : await computeEffectivePlan(config, repoPath);
    const reconciledIssueIds = plan.selected.map((item) => item.id).filter((id) => config.work?.[id]?.github);
    if (reconciledIssueIds.length) {
      const repository = await discoverGitHubRepository(repoPath);
      if (repository !== config.repository) throw new Error(`The manifest targets ${config.repository}, but the current checkout is ${repository}.`);
      const issues = await loadGitHubIssues(repository, reconciledIssueIds, { repoPath });
      const findings = detectExecutionDrift(config, issues, reconciledIssueIds);
      if (findings.length) {
        throw new Error(`GitHub/manifest drift blocks execution: ${findings.map((item) => `#${item.issue} ${item.reason}`).join(" ")} Run \`maestro draft --write\` and review any conflicts before retrying.`);
      }
    }
    const result = await executeRun(config, { repoPath, plan });
    let automatic = null;
    if (args.includes("--auto-rework")) {
      const newlyExecuted = result.plan?.selected?.map((item) => String(item.id)) || [];
      const resumable = plan.deferred
        ?.filter((item) => item.lifecycle?.state === "awaiting-rework")
        .map((item) => String(item.id)) || [];
      const issueIds = newlyExecuted.length ? newlyExecuted : resumable;
      automatic = await autoRework(config, {
        repoPath,
        issueIds,
        capacity: plan.availableConcurrency ?? plan.concurrency ?? config.defaultConcurrency ?? 2
      });
    }
    process.stdout.write(`${JSON.stringify(automatic ? { ...result, autoRework: automatic } : result, null, 2)}\n`);
    process.stdout.write(await workflowFooter(config, repoPath));
    if (automatic) setAutoReworkExitCode(automatic);
    else setResultExitCode(result);
    return;
  }

  if (command === "approve") {
    await approveLatest({
      config,
      repoPath,
      runId: option(args, "--run"),
      requestedIssues: issuePositionals(rest),
      override: args.includes("--override")
    });
    process.stdout.write(await workflowFooter(config, repoPath));
    return;
  }

  if (command === "discard") {
    const result = await discardIssues({
      repoPath,
      runId: option(args, "--run"),
      requestedIssues: issuePositionals(rest)
    });
    process.stdout.write(formatDiscardSummary(result));
    process.stdout.write(await workflowFooter(config, repoPath));
    return;
  }

  if (command === "commit") {
    await commitLatest({
      config,
      repoPath,
      manifestPath,
      runId: option(args, "--run"),
      closeIssues: args.includes("--close-issues")
    });
    process.stdout.write(await workflowFooter(loadConfig(manifestPath, args), repoPath));
    return;
  }

  if (command === "rework") {
    const sourceRunId = option(args, "--run");
    const requestedIssues = reworkArgs.issues;
    let sources;
    if (sourceRunId) {
      const issueIds = requestedIssues.length ? requestedIssues : null;
      const parentRunId = await resolveReworkParentRunId(repoPath, sourceRunId, issueIds);
      sources = [{ sourceRunId, parentRunId, issueIds }];
    } else {
      sources = await resolveIssueReworkSources(repoPath, requestedIssues);
    }
    const results = [];
    for (const source of sources) {
      results.push(await executeReworkRun(config, { repoPath, ...source }));
    }
    process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
    process.stdout.write(await workflowFooter(config, repoPath));
    for (const result of results) setResultExitCode(result);
    return;
  }

  if (command === "reconcile") {
    const sourceRunId = option(args, "--run");
    const issue = option(args, "--issue");
    const result = await executeReconcileRun(config, { repoPath, sourceRunId, issueIds: issue ? [issue] : null });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    setResultExitCode(result);
    return;
  }

  if (command === "review") {
    const runId = option(args, "--run");
    const issue = option(args, "--issue");
    const disposition = option(args, "--disposition");
    const result = await recordReview({
      config,
      repoPath,
      runId,
      issue,
      disposition,
      title: option(args, "--title"),
      notes: option(args, "--notes")
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "integrate-run") {
    const runId = option(args, "--run");
    const result = await integrateExistingRun(config, { repoPath, manifestPath, runId, closeIssues: args.includes("--close-issues") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  let result;
  if (args.includes("--continuous")) result = await continuousRun(config, { repoPath });
  else if (args.includes("--integrate")) result = await executeAndIntegrate(config, { repoPath });
  else if (args.includes("--execute")) result = await executeRun(config, { repoPath });
  else result = await dryRun(config, { repoPath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  setResultExitCode(result);
}

main().catch((error) => {
  console.error(error.code === "CLI_USAGE" ? error.message : error.stack || error.message);
  if (error.baselineComparison) console.error(`Baseline comparison:\n${JSON.stringify(error.baselineComparison, null, 2)}`);
  if (error.result) {
    const combined = `${error.result.stdout || ""}\n${error.result.stderr || ""}`.trim();
    if (combined) console.error(`Command output (tail):\n${combined.split("\n").slice(-80).join("\n")}`);
  }
  if (error.results) console.error(JSON.stringify(error.results, null, 2));
  process.exitCode = 1;
});

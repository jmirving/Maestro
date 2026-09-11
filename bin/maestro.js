#!/usr/bin/env node
const fs = require("node:fs");
const { computePlan } = require("../src/planner");
const { computeEffectivePlan } = require("../src/work-state");
const { dryRun, executeRun, executeAndIntegrate, continuousRun } = require("../src/controller");
const { latestRunBundle, copyToClipboard } = require("../src/reporter");
const { recordReview } = require("../src/reviews");
const { approveIssues, formatApprovalSummary } = require("../src/approval");
const { integrateExistingRun } = require("../src/existing-run");
const { resolveIssueReworkSources, executeReworkRun } = require("../src/rework");
const { executeReconcileRun } = require("../src/reconcile");
const { latestRunId } = require("../src/run-store");
const { statusSnapshot, formatStatus, watchStatus } = require("../src/display");
const { loadIssueDetails, formatDetails } = require("../src/details");
const { discoverGitHubRepository, loadGitHubIssues } = require("../src/github");
const { proposeDraft, formatDraftSummary, readExistingManifest, writeManifest } = require("../src/draft");
const { createAgentPlanner } = require("../src/agent-planner");
const { runPlanningAnalyzer } = require("../src/planning-analysis");
const {
  normalizeCommand,
  resolveRepoPath,
  resolveManifestPath,
  resolveDraftManifestPath,
  looksLikeManifest,
  persistManifestCompletion
} = require("../src/cli-context");

function usage() {
  console.error(`Usage:
  maestro plan [manifest.json] [--repo-path <path>]
  maestro draft [manifest.json] [issue ...] [--repo-path <path>] [--all] [--agent] [--write]
  maestro start [manifest.json] [--repo-path <path>] [--rerun]
  maestro status [manifest.json] [--repo-path <path>] [--watch]
  maestro details [manifest.json] <issue ...> [--repo-path <path>] [--run <run-id>]
  maestro output [--repo-path <path>]
  maestro approve [issue ...] [manifest.json] [--repo-path <path>] [--run <run-id>]
  maestro commit [manifest.json] [--repo-path <path>] [--run <run-id>] [--close-issues]
  maestro next [manifest.json] [--repo-path <path>] [--rerun]

Short aliases: s=start, st=status, o=output, a=approve, c=commit, n=next

Advanced commands:
  maestro run [manifest.json] [--repo-path <path>] [--execute|--integrate|--continuous] [--allow-failing-baseline]
  maestro rework [issue ...] [manifest.json] [--repo-path <path>] [--run <source-run-id>] [--allow-failing-baseline]
  maestro reconcile [manifest.json] [--repo-path <path>] --run <source-run-id> [--issue <number>] [--allow-failing-baseline]
  maestro report [--repo-path <path>] [--copy]
  maestro review [manifest.json] [--repo-path <path>] --run <run-id> --issue <number> --disposition <approve|rework-original|approve-with-follow-up> [--title <title>] [--notes <notes>]
  maestro integrate-run [manifest.json] [--repo-path <path>] --run <run-id> [--close-issues]`);
  process.exit(2);
}

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
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    if (/^\d+$/.test(value)) issues.push(value);
  }
  return issues;
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
  if (result.workers?.some((worker) => worker.exitCode !== 0)) process.exitCode = 1;
  if (result.validations?.some((entry) => entry.verdict !== "approve")) process.exitCode = 1;
}

async function outputLatest(repoPath, { copy = true, print = true } = {}) {
  const bundle = await latestRunBundle(repoPath);
  if (print) process.stdout.write(bundle.text);
  if (copy) {
    const clipboard = copyToClipboard(bundle.text);
    console.error(`Copied Maestro run ${bundle.runId} to clipboard using ${clipboard}.`);
  }
  return bundle;
}

async function approveLatest({ config, repoPath, runId, requestedIssues }) {
  const result = await approveIssues({ config, repoPath, runId, requestedIssues });
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
  const progress = persistManifestCompletion({ repoPath, manifestPath, issueIds: integratedIssues });
  console.log(`Committed Maestro run ${resolvedRunId}: ${integratedIssues.length ? integratedIssues.map((issue) => `#${issue}`).join(", ") : "nothing new"}`);
  if (progress.changed.length) console.log(`Advanced ${manifestPath}: ${progress.changed.map((issue) => `#${issue}`).join(", ")}`);
  return { ...result, manifestProgress: progress };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || ["-h", "--help", "help"].includes(args[0])) usage();
  const command = normalizeCommand(args[0]);
  const rest = args.slice(1);

  if (command === "output") {
    const { repoPath } = resolveContext(rest, args, { manifest: false });
    await outputLatest(repoPath, { copy: true, print: true });
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
    const existingConfig = readExistingManifest(manifestPath);
    const deterministicResult = proposeDraft({
      repository,
      existingConfig,
      issues,
      selectedIssueIds: requestedIssues
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
      agentAnalysis
    }) : deterministicResult;
    const write = args.includes("--write");
    process.stdout.write(formatDraftSummary({ repository, manifestPath, result, write }));
    if (write && !result.writable) {
      process.exitCode = 1;
      return;
    }
    if (write && result.changed) writeManifest(manifestPath, result.manifest);
    return;
  }

  const { repoPath, manifestPath } = resolveContext(rest, args);
  const config = loadConfig(manifestPath, args);

  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(computePlan(config), null, 2)}\n`);
    return;
  }

  if (command === "status") {
    if (args.includes("--watch")) await watchStatus(config, repoPath);
    else process.stdout.write(formatStatus(await statusSnapshot(config, repoPath)));
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
    const result = await executeRun(config, { repoPath, plan });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    setResultExitCode(result);
    return;
  }

  if (command === "approve") {
    await approveLatest({
      config,
      repoPath,
      runId: option(args, "--run"),
      requestedIssues: issuePositionals(rest)
    });
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
    return;
  }

  if (command === "rework") {
    const sourceRunId = option(args, "--run");
    const requestedIssues = issuePositionals(rest);
    if (!sourceRunId && !requestedIssues.length) usage();
    const sources = sourceRunId
      ? [{ sourceRunId, issueIds: requestedIssues.length ? requestedIssues : null }]
      : await resolveIssueReworkSources(repoPath, requestedIssues);
    const results = [];
    for (const source of sources) {
      results.push(await executeReworkRun(config, { repoPath, ...source }));
    }
    process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
    for (const result of results) setResultExitCode(result);
    return;
  }

  if (command === "reconcile") {
    const sourceRunId = option(args, "--run");
    if (!sourceRunId) usage();
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
    if (!runId || !issue || !disposition) usage();
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
    if (!runId) usage();
    const result = await integrateExistingRun(config, { repoPath, manifestPath, runId, closeIssues: args.includes("--close-issues") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command !== "run") usage();

  let result;
  if (args.includes("--continuous")) result = await continuousRun(config, { repoPath });
  else if (args.includes("--integrate")) result = await executeAndIntegrate(config, { repoPath });
  else if (args.includes("--execute")) result = await executeRun(config, { repoPath });
  else result = await dryRun(config, { repoPath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  setResultExitCode(result);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.baselineComparison) console.error(`Baseline comparison:\n${JSON.stringify(error.baselineComparison, null, 2)}`);
  if (error.result) {
    const combined = `${error.result.stdout || ""}\n${error.result.stderr || ""}`.trim();
    if (combined) console.error(`Command output (tail):\n${combined.split("\n").slice(-80).join("\n")}`);
  }
  if (error.results) console.error(JSON.stringify(error.results, null, 2));
  process.exitCode = 1;
});

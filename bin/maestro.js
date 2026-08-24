#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { computePlan } = require("../src/planner");
const { dryRun, executeRun, executeAndIntegrate, continuousRun } = require("../src/controller");
const { latestRunBundle, copyToClipboard } = require("../src/reporter");
const { recordReview } = require("../src/reviews");
const { integrateExistingRun } = require("../src/existing-run");

function usage() {
  console.error("Usage:\n" +
    "  maestro plan <manifest.json>\n" +
    "  maestro run <manifest.json> --repo-path <path> [--execute|--integrate|--continuous] [--allow-failing-baseline]\n" +
    "  maestro report --repo-path <path> [--copy]\n" +
    "  maestro review <manifest.json> --repo-path <path> --run <id> --issue <n> --disposition <approve|rework-original|approve-with-follow-up> [--title <title> --notes <notes>]\n" +
    "  maestro integrate-run <manifest.json> --repo-path <path> --run <id> [--close-issues]");
  process.exit(2);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function loadConfig(manifestPath) {
  const absolute = path.resolve(process.cwd(), manifestPath);
  const config = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (process.argv.includes("--allow-failing-baseline")) {
    config.baseline = { ...(config.baseline || {}), allowFailing: true };
  }
  return config;
}

async function main() {
  const [, , command, manifestPath] = process.argv;

  if (command === "report") {
    const repoPath = option("--repo-path");
    if (!repoPath) usage();
    const bundle = await latestRunBundle(path.resolve(process.cwd(), repoPath));
    if (process.argv.includes("--copy")) {
      const clipboard = copyToClipboard(bundle.text);
      console.error(`Copied Maestro run ${bundle.runId} to clipboard using ${clipboard}.`);
    } else {
      process.stdout.write(bundle.text);
    }
    return;
  }

  if (!manifestPath || !["plan", "run", "review", "integrate-run"].includes(command)) usage();
  const config = loadConfig(manifestPath);
  const repoPath = option("--repo-path");
  const resolvedRepoPath = repoPath ? path.resolve(process.cwd(), repoPath) : null;

  if (command === "review") {
    if (!resolvedRepoPath) usage();
    const runId = option("--run");
    const issue = option("--issue");
    const disposition = option("--disposition");
    if (!runId || !issue || !disposition) usage();
    const review = await recordReview({
      repoPath: resolvedRepoPath,
      runId,
      issue,
      disposition,
      title: option("--title"),
      notes: option("--notes")
    });
    process.stdout.write(`${JSON.stringify({ runId, issue, review }, null, 2)}\n`);
    return;
  }

  if (command === "integrate-run") {
    if (!resolvedRepoPath) usage();
    const runId = option("--run");
    if (!runId) usage();
    const result = await integrateExistingRun(config, {
      repoPath: resolvedRepoPath,
      runId,
      closeIssues: process.argv.includes("--close-issues")
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(computePlan(config), null, 2)}\n`);
    return;
  }

  if (!resolvedRepoPath) usage();
  let result;
  if (process.argv.includes("--continuous")) {
    result = await continuousRun(config, { repoPath: resolvedRepoPath });
  } else if (process.argv.includes("--integrate")) {
    result = await executeAndIntegrate(config, { repoPath: resolvedRepoPath });
  } else if (process.argv.includes("--execute")) {
    result = await executeRun(config, { repoPath: resolvedRepoPath });
  } else {
    result = await dryRun(config, { repoPath: resolvedRepoPath });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.workers?.some((worker) => worker.exitCode !== 0)) process.exitCode = 1;
  if (result.validations?.some((entry) => entry.verdict !== "approve")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.results) console.error(JSON.stringify(error.results, null, 2));
  process.exitCode = 1;
});

#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { computePlan } = require("../src/planner");
const { dryRun, executeRun, executeAndIntegrate, continuousRun } = require("../src/controller");

function usage() {
  console.error("Usage:\n  maestro plan <manifest.json>\n  maestro run <manifest.json> --repo-path <path> [--execute|--integrate|--continuous] [--allow-failing-baseline]");
  process.exit(2);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const [, , command, manifestPath] = process.argv;
  if (!manifestPath || !["plan", "run"].includes(command)) usage();
  const absolute = path.resolve(process.cwd(), manifestPath);
  const config = JSON.parse(fs.readFileSync(absolute, "utf8"));

  if (process.argv.includes("--allow-failing-baseline")) {
    config.baseline = { ...(config.baseline || {}), allowFailing: true };
  }

  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(computePlan(config), null, 2)}\n`);
    return;
  }

  const repoPath = option("--repo-path");
  if (!repoPath) usage();
  const resolvedRepoPath = path.resolve(process.cwd(), repoPath);
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

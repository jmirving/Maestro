const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const COMMAND_ALIASES = new Map([
  ["s", "start"],
  ["st", "status"],
  ["o", "output"],
  ["a", "approve"],
  ["c", "commit"],
  ["n", "next"]
]);

function normalizeCommand(command) {
  return COMMAND_ALIASES.get(command) || command;
}

function gitRoot(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error("Maestro could not find a Git repository from the current directory. Use --repo-path explicitly.");
  }
  return path.resolve(result.stdout.trim());
}

function resolveRepoPath(explicitRepoPath, cwd = process.cwd()) {
  return explicitRepoPath ? path.resolve(cwd, explicitRepoPath) : gitRoot(cwd);
}

function resolveManifestPath(explicitManifestPath, repoPath, cwd = process.cwd()) {
  const manifestPath = explicitManifestPath
    ? path.resolve(cwd, explicitManifestPath)
    : path.join(repoPath, ".maestro.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Maestro manifest not found: ${manifestPath}. Pass an explicit manifest path or add .maestro.json to the target repository.`);
  }
  return manifestPath;
}

function looksLikeManifest(value) {
  return Boolean(value && !value.startsWith("--") && (value.endsWith(".json") || value.includes("/")));
}

function markManifestComplete(manifestPath, issueIds) {
  const config = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const changed = [];
  for (const issue of issueIds.map(String)) {
    if (!config.work?.[issue]) continue;
    if (config.work[issue].status !== "complete") {
      config.work[issue].status = "complete";
      changed.push(issue);
    }
  }
  if (changed.length) fs.writeFileSync(manifestPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return changed;
}

module.exports = {
  COMMAND_ALIASES,
  normalizeCommand,
  gitRoot,
  resolveRepoPath,
  resolveManifestPath,
  looksLikeManifest,
  markManifestComplete
};

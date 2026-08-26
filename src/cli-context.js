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

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function gitRoot(cwd = process.cwd()) {
  try {
    return path.resolve(run("git", ["rev-parse", "--show-toplevel"], cwd));
  } catch {
    throw new Error("Maestro could not find a Git repository from the current directory. Use --repo-path explicitly.");
  }
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

function persistManifestCompletion({ repoPath, manifestPath, issueIds }) {
  const relativeManifest = path.relative(repoPath, manifestPath);
  if (relativeManifest.startsWith("..") || path.isAbsolute(relativeManifest)) {
    throw new Error("The inferred Maestro manifest is outside the target repository and cannot be committed automatically.");
  }

  const changed = markManifestComplete(manifestPath, issueIds);
  if (!changed.length) return { changed, committed: false };

  run("git", ["add", "--", relativeManifest], repoPath);
  const message = `Advance Maestro work state: ${changed.map((issue) => `#${issue}`).join(", ")}`;
  run("git", ["commit", "-m", message, "--", relativeManifest], repoPath);
  run("git", ["push", "origin", "HEAD"], repoPath);
  return { changed, committed: true };
}

module.exports = {
  COMMAND_ALIASES,
  normalizeCommand,
  gitRoot,
  resolveRepoPath,
  resolveManifestPath,
  looksLikeManifest,
  markManifestComplete,
  persistManifestCompletion
};

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { COMMAND_ALIASES } = require("./command-registry");

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

function resolveDraftManifestPath(explicitManifestPath, repoPath, cwd = process.cwd()) {
  return explicitManifestPath
    ? path.resolve(cwd, explicitManifestPath)
    : path.join(repoPath, ".maestro.json");
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

  // The manifest is an explicitly resolved Maestro input, so it remains safe
  // to persist even when a repository-wide ignore rule matches its path.
  run("git", ["add", "--force", "--", relativeManifest], repoPath);
  const message = `Advance Maestro work state: ${changed.map((issue) => `#${issue}`).join(", ")}`;
  run("git", ["commit", "-m", message, "--", relativeManifest], repoPath);
  run("git", ["push", "origin", "HEAD"], repoPath);
  return { changed, committed: true };
}

function output(command, args, cwd) {
  return run(command, args, cwd);
}

function manifestCompletionContents(manifestPath, issueIds) {
  const config = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const changed = [];
  for (const issue of issueIds.map(String)) {
    if (config.work?.[issue] && config.work[issue].status !== "complete") {
      config.work[issue].status = "complete";
      changed.push(issue);
    }
  }
  return { changed, contents: `${JSON.stringify(config, null, 2)}\n` };
}

function remoteHead(repoPath, remote, branch) {
  const line = output("git", ["ls-remote", remote, `refs/heads/${branch}`], repoPath);
  return line.split(/\s+/)[0] || null;
}

async function persistManifestCompletionDurably({
  repoPath,
  manifestPath,
  issueIds,
  checkpoint = null,
  onCheckpoint = async () => {}
}) {
  const relativeManifest = path.relative(repoPath, manifestPath);
  if (relativeManifest.startsWith("..") || path.isAbsolute(relativeManifest)) {
    throw new Error("The inferred Maestro manifest is outside the target repository and cannot be committed automatically.");
  }
  const remote = checkpoint?.remote || "origin";
  const branch = checkpoint?.branch || output("git", ["branch", "--show-current"], repoPath);
  let current = checkpoint;
  if (current?.state === "recorded") {
    const recorded = new Set((current.issueIds || []).map(String));
    const additional = issueIds.map(String).filter((issue) => !recorded.has(issue));
    if (!additional.length) return { changed: [], committed: false, checkpoint: current, recovered: true };
    issueIds = additional;
    current = null;
  }

  if (current && current.state !== "recorded") {
    // A crash can occur between the commit and its result checkpoint.  The
    // intent's before SHA makes that local commit discoverable without using
    // the editable manifest as proof that publication succeeded.
    if (!current.candidateSha) {
      const head = output("git", ["rev-parse", "HEAD"], repoPath);
      if (head !== current.beforeSha) {
        const parent = output("git", ["rev-parse", "HEAD^"], repoPath);
        const paths = output("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], repoPath).split("\n").filter(Boolean);
        if (parent !== current.beforeSha || paths.length !== 1 || paths[0] !== relativeManifest) {
          const error = new Error("Manifest publication intent is followed by an unrelated or non-linear local commit; preserved it for explicit inspection.");
          error.code = "MANIFEST_PUBLICATION_UNCERTAIN";
          throw error;
        }
        current = { ...current, candidateSha: head, state: "committed" };
        await onCheckpoint(current);
      }
    }
    if (current.candidateSha) {
      const observed = remoteHead(repoPath, remote, branch);
      if (observed === current.candidateSha) {
        current = { ...current, state: "recorded", remoteSha: observed, recordedAt: new Date().toISOString() };
        await onCheckpoint(current);
        return { changed: current.issueIds || issueIds.map(String), committed: true, checkpoint: current, recovered: true };
      }
      if (observed !== current.beforeSha) {
        const error = new Error(`Manifest publication is uncertain: ${remote}/${branch} moved to ${observed || "an unknown SHA"}; preserved local HEAD for inspection.`);
        error.code = "MANIFEST_PUBLICATION_UNCERTAIN";
        throw error;
      }
      output("git", ["push", remote, `${current.candidateSha}:refs/heads/${branch}`], repoPath);
      current = { ...current, state: "recorded", remoteSha: current.candidateSha, recordedAt: new Date().toISOString() };
      await onCheckpoint(current);
      return { changed: current.issueIds || issueIds.map(String), committed: true, checkpoint: current, recovered: true };
    }
  }

  const intendedIssues = current?.state === "intent" ? current.issueIds : issueIds;
  const desired = manifestCompletionContents(manifestPath, intendedIssues);
  if (!current && !desired.changed.length) return { changed: [], committed: false, checkpoint: current };
  if (!current) {
    const beforeSha = output("git", ["rev-parse", "HEAD"], repoPath);
    current = {
      version: 1,
      state: "intent",
      issueIds: desired.changed,
      manifestPath: relativeManifest,
      remote,
      branch,
      beforeSha,
      preparedAt: new Date().toISOString()
    };
    await onCheckpoint(current);
  }
  if (desired.changed.length) fs.writeFileSync(manifestPath, desired.contents, "utf8");
  output("git", ["add", "--force", "--", relativeManifest], repoPath);
  output("git", ["commit", "-m", `Advance Maestro work state: ${current.issueIds.map((issue) => `#${issue}`).join(", ")}`, "--", relativeManifest], repoPath);
  const candidateSha = output("git", ["rev-parse", "HEAD"], repoPath);
  current = { ...current, state: "committed", candidateSha, committedAt: new Date().toISOString() };
  await onCheckpoint(current);
  try {
    output("git", ["push", remote, `${candidateSha}:refs/heads/${branch}`], repoPath);
  } catch (pushError) {
    const observed = remoteHead(repoPath, remote, branch);
    if (observed !== candidateSha) {
      current = { ...current, state: observed === current.beforeSha ? "not-published" : "uncertain", remoteSha: observed, reconciledAt: new Date().toISOString() };
      await onCheckpoint(current);
      if (observed !== current.beforeSha) pushError.code = "MANIFEST_PUBLICATION_UNCERTAIN";
      throw pushError;
    }
  }
  current = { ...current, state: "recorded", remoteSha: candidateSha, recordedAt: new Date().toISOString() };
  await onCheckpoint(current);
  return { changed: current.issueIds, committed: true, checkpoint: current };
}

module.exports = {
  COMMAND_ALIASES,
  normalizeCommand,
  gitRoot,
  resolveRepoPath,
  resolveManifestPath,
  resolveDraftManifestPath,
  looksLikeManifest,
  markManifestComplete,
  persistManifestCompletion,
  persistManifestCompletionDurably
};

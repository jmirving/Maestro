const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function reportRootForRepo(repoPath) {
  const repoRoot = path.resolve(repoPath);
  return path.join(path.dirname(repoRoot), ".maestro-worktrees", path.basename(repoRoot), ".maestro-reports");
}

function parseReportName(name) {
  const match = name.match(/^(worker|validator)-([^-]+)-(\d{14}-[a-f0-9]+)\.md$/);
  if (!match) return null;
  return { kind: match[1], issue: match[2], runId: match[3], name };
}

async function latestRunBundle(repoPath) {
  const reportRoot = reportRootForRepo(repoPath);
  const names = await fs.readdir(reportRoot);
  const reports = names.map(parseReportName).filter(Boolean);
  if (!reports.length) throw new Error(`No Maestro reports found in ${reportRoot}`);
  const latestRunId = reports.map((entry) => entry.runId).sort().at(-1);
  const selected = reports
    .filter((entry) => entry.runId === latestRunId)
    .sort((a, b) => a.issue.localeCompare(b.issue, undefined, { numeric: true }) || a.kind.localeCompare(b.kind));

  const sections = [`# Maestro run ${latestRunId}`];
  for (const entry of selected) {
    const content = await fs.readFile(path.join(reportRoot, entry.name), "utf8");
    sections.push(`\n## ${entry.kind} #${entry.issue}\n\n${content.trim()}`);
  }
  return { runId: latestRunId, reportRoot, text: `${sections.join("\n")}\n` };
}

function copyToClipboard(text) {
  const candidates = process.platform === "win32"
    ? [["clip.exe", []]]
    : [["clip.exe", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { input: text, encoding: "utf8" });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error("Could not find a supported clipboard command (clip.exe, wl-copy, or xclip).");
}

module.exports = { reportRootForRepo, parseReportName, latestRunBundle, copyToClipboard };

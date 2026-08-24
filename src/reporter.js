const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
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
  if (process.platform !== "win32") {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "maestro-clipboard-"));
    const file = path.join(dir, "report.txt");
    try {
      fsSync.writeFileSync(file, text, "utf8");
      const converted = spawnSync("wslpath", ["-w", file], { encoding: "utf8" });
      if (!converted.error && converted.status === 0) {
        const winPath = converted.stdout.trim().replace(/'/g, "''");
        const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-Content -Raw -Encoding UTF8 '${winPath}' | Set-Clipboard`], { encoding: "utf8" });
        if (!ps.error && ps.status === 0) return "powershell.exe/Set-Clipboard";
      }
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  }

  const candidates = process.platform === "win32"
    ? [["powershell.exe", ["-NoProfile", "-Command", "$input | Set-Clipboard"]], ["clip.exe", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { input: text, encoding: "utf8" });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error("Could not find a supported Unicode-safe clipboard command.");
}

module.exports = { reportRootForRepo, parseReportName, latestRunBundle, copyToClipboard };

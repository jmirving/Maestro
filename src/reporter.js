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

function formatRunLifecycle(state) {
  if (!state) return "";
  const reviews = state.reviews || {};
  const integrationByIssue = new Map((state.integration || []).map((entry) => [String(entry.issue), entry]));
  const validationByIssue = new Map((state.validations || []).map((entry) => [String(entry.issue), entry]));
  const issues = [...new Set([
    ...(state.workers || []).map((entry) => String(entry.issue)),
    ...Object.keys(reviews),
    ...integrationByIssue.keys()
  ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!issues.length) return "";

  const lines = ["## Run lifecycle", ""];
  for (const issue of issues) {
    const validation = validationByIssue.get(issue);
    const review = reviews[issue];
    const integrated = integrationByIssue.get(issue);
    const parts = [];
    if (validation?.verdict) parts.push(`validator=${validation.verdict}`);
    if (review?.disposition) parts.push(`review=${review.disposition}`);
    if (review?.followUp?.issueNumber) parts.push(`follow-up=#${review.followUp.issueNumber}`);
    if (integrated?.integratedSha) parts.push(`integrated=${integrated.integratedSha}`);
    else if (integrated) parts.push("integrated=yes");
    lines.push(`- #${issue}: ${parts.join(", ") || "recorded"}`);
  }
  if (state.integratedAt) lines.push(`- integration completed at ${state.integratedAt}`);
  else if ((state.integration || []).length) lines.push(`- integration partially completed (${state.integration.length} item(s))`);
  return `${lines.join("\n")}\n`;
}

async function latestRunBundle(repoPath) {
  const reportRoot = reportRootForRepo(repoPath);
  const names = await fs.readdir(reportRoot);
  const reports = names.map(parseReportName).filter(Boolean);
  const stateRunIds = names
    .map((name) => name.match(/^run-(\d{14}-[a-f0-9]+)\.json$/)?.[1])
    .filter(Boolean);
  const runIds = [...new Set([...reports.map((entry) => entry.runId), ...stateRunIds])];
  if (!runIds.length) throw new Error(`No Maestro reports found in ${reportRoot}`);
  const latestRunId = runIds.sort().at(-1);
  const selected = reports
    .filter((entry) => entry.runId === latestRunId)
    .sort((a, b) => a.issue.localeCompare(b.issue, undefined, { numeric: true }) || a.kind.localeCompare(b.kind));

  let state = null;
  try {
    state = JSON.parse(await fs.readFile(path.join(reportRoot, `run-${latestRunId}.json`), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const sections = [`# Maestro run ${latestRunId}`];
  const lifecycle = formatRunLifecycle(state);
  if (lifecycle) sections.push(`\n${lifecycle.trimEnd()}`);
  for (const entry of selected) {
    const content = await fs.readFile(path.join(reportRoot, entry.name), "utf8");
    sections.push(`\n## ${entry.kind} #${entry.issue}\n\n${content.trim()}`);
  }
  return { runId: latestRunId, reportRoot, state, text: `${sections.join("\n")}\n` };
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

module.exports = { reportRootForRepo, parseReportName, formatRunLifecycle, latestRunBundle, copyToClipboard };

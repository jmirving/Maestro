const fs = require("node:fs/promises");
const path = require("node:path");
const { computePlan } = require("./planner");
const { reportRootForRepo, parseReportName } = require("./reporter");
const { statePath } = require("./run-store");

function worktreeRootForRepo(repoPath) {
  return path.dirname(reportRootForRepo(repoPath));
}

async function safeReadDir(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function runIdFromWorktreeName(name) {
  const match = name.match(/^.+-(\d{14}-[a-f0-9]+)$/);
  return match ? match[1] : null;
}

async function discoverRuns(repoPath) {
  const reportRoot = reportRootForRepo(repoPath);
  const worktreeRoot = worktreeRootForRepo(repoPath);
  const runIds = new Set();

  for (const entry of await safeReadDir(reportRoot)) {
    const report = parseReportName(entry.name);
    if (report) runIds.add(report.runId);
    const state = entry.name.match(/^run-(\d{14}-[a-f0-9]+)\.json$/);
    if (state) runIds.add(state[1]);
  }
  for (const entry of await safeReadDir(worktreeRoot)) {
    if (!entry.isDirectory() || entry.name === ".maestro-reports") continue;
    const runId = runIdFromWorktreeName(entry.name);
    if (runId) runIds.add(runId);
  }
  return [...runIds].sort();
}

async function readStateIfPresent(repoPath, runId) {
  try { return JSON.parse(await fs.readFile(statePath(repoPath, runId), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function runIssueStatus(repoPath, runId) {
  const reportRoot = reportRootForRepo(repoPath);
  const worktreeRoot = worktreeRootForRepo(repoPath);
  const state = await readStateIfPresent(repoPath, runId);
  const entries = await safeReadDir(reportRoot);
  const reports = entries.map((entry) => parseReportName(entry.name)).filter((entry) => entry?.runId === runId);
  const dirs = (await safeReadDir(worktreeRoot)).filter((entry) => entry.isDirectory() && runIdFromWorktreeName(entry.name) === runId);
  const issues = new Set([
    ...reports.map((entry) => String(entry.issue)),
    ...dirs.map((entry) => entry.name.slice(0, -1 * (`-${runId}`).length)),
    ...((state?.workers || []).map((entry) => String(entry.issue)))
  ]);
  const validations = new Map((state?.validations || []).map((entry) => [String(entry.issue), entry.verdict]));
  for (const report of reports.filter((entry) => entry.kind === "validator")) {
    if (!validations.has(String(report.issue))) {
      try {
        const text = await fs.readFile(path.join(reportRoot, report.name), "utf8");
        const match = text.match(/^VERDICT:\s*(APPROVE|REWORK|HUMAN_GATE)\b/m);
        validations.set(String(report.issue), match ? match[1].toLowerCase() : "invalid");
      } catch {}
    }
  }
  const integrated = new Set((state?.integration || []).map((entry) => String(entry.issue)));

  return [...issues].sort((a, b) => Number(a) - Number(b)).map((issue) => {
    const hasWorkerReport = reports.some((entry) => entry.kind === "worker" && String(entry.issue) === issue);
    const review = state?.reviews?.[issue];
    let status = "working";
    if (hasWorkerReport) status = "worker done";
    if (validations.has(issue)) status = `validated ${validations.get(issue)}`;
    if (review) status = `reviewed ${review.disposition}`;
    if (integrated.has(issue)) status = "integrated";
    return { issue, status };
  });
}

async function statusSnapshot(config, repoPath) {
  const plan = computePlan(config);
  const runs = await discoverRuns(repoPath);
  const runId = runs.at(-1) || null;
  const runIssues = runId ? await runIssueStatus(repoPath, runId) : [];
  const complete = Object.entries(config.work || {}).filter(([, item]) => item.status === "complete").map(([id]) => id);
  const ready = plan.ready?.map((item) => item.id) || [];
  const selected = plan.selected?.map((item) => item.id) || [];
  const blocked = plan.blocked?.map((item) => item.id) || [];
  return { repository: config.repository, runId, runIssues, selected, ready, blocked, complete, humanGates: plan.humanGates || [] };
}

function formatStatus(snapshot) {
  const lines = [];
  lines.push(`MAESTRO  ${snapshot.repository || "repository"}`);
  lines.push("=".repeat(Math.max(24, lines[0].length)));
  lines.push(`Latest run: ${snapshot.runId || "none"}`);
  if (snapshot.runIssues.length) {
    lines.push("");
    lines.push("RUN");
    for (const item of snapshot.runIssues) lines.push(`  #${item.issue.padEnd(4)} ${item.status}`);
  }
  lines.push("");
  lines.push(`NEXT       ${snapshot.selected.length ? snapshot.selected.map((id) => `#${id}`).join(", ") : "none"}`);
  lines.push(`READY      ${snapshot.ready.length ? snapshot.ready.map((id) => `#${id}`).join(", ") : "none"}`);
  lines.push(`BLOCKED    ${snapshot.blocked.length ? snapshot.blocked.map((id) => `#${id}`).join(", ") : "none"}`);
  lines.push(`COMPLETE   ${snapshot.complete.length ? snapshot.complete.map((id) => `#${id}`).join(", ") : "none"}`);
  if (snapshot.humanGates.length) lines.push(`HUMAN GATE ${snapshot.humanGates.map((item) => `#${item.id}`).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

async function watchStatus(config, repoPath, { intervalMs = 2000 } = {}) {
  const interactive = Boolean(process.stdout.isTTY);
  let first = true;
  for (;;) {
    const text = formatStatus(await statusSnapshot(config, repoPath));
    if (interactive && !first) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(text);
    first = false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { discoverRuns, statusSnapshot, formatStatus, watchStatus };

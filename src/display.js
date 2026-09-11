const { loadExecutionStates, reconcilePlan } = require("./work-state");
const { currentIssueEvidenceFromStates } = require("./run-resolver");
const { assessRunItems } = require("./existing-run");
const { buildRecommendations, formatRecommendations } = require("./recommendations");

function numericSort(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

function titleFor(config, issue, evidence) {
  return [evidence?.selected?.title, evidence?.worker?.title, config.work?.[issue]?.title]
    .find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function describeIssue(config, issue, evidence, plan) {
  const manifest = config.work?.[issue] || null;
  const deferred = plan.deferred?.find((entry) => String(entry.id) === issue);
  const selected = plan.selected?.some((entry) => String(entry.id) === issue);
  const validation = evidence?.validation || null;
  const review = evidence?.review || null;
  const integration = evidence?.integration || null;
  let state;
  let integrationState = "not eligible";
  let action = null;

  if (manifest?.status === "complete" || integration) {
    state = "integrated/complete";
    integrationState = "integrated";
  } else if (review?.disposition === "rework-original") {
    state = "human rework disposition recorded, excluded from integration";
    integrationState = "excluded; will be reworked";
    action = `maestro rework ${issue}`;
  } else if (review && validation?.verdict === "approve") {
    state = "human approved, ready to integrate";
    integrationState = "eligible when every item in its run has a human disposition";
  } else if (review) {
    state = `blocked: human ${review.disposition} conflicts with validator ${validation?.verdict || "state"}`;
    integrationState = "blocked by inconsistent review state";
  } else if (validation?.verdict === "approve") {
    state = "validator approved, awaiting human approval";
    integrationState = "not eligible until human approval";
    action = `maestro approve ${issue}`;
  } else if (validation?.verdict === "rework") {
    state = "validator requested rework, awaiting human rework disposition";
    integrationState = "not eligible; record rework-original to exclude it";
  } else if (validation?.verdict === "human_gate") {
    state = "validator requested a human decision, awaiting human disposition";
    integrationState = "not eligible until human disposition";
  } else if (evidence?.state === "running" || evidence?.state === "rework-running") {
    state = evidence.state === "rework-running" ? "rework in progress" : "worker in progress";
    action = "maestro status --watch";
  } else if (evidence?.state === "failed-awaiting-retry" || evidence?.worker?.exitCode > 0) {
    state = "failed, awaiting explicit retry";
    action = "maestro start --rerun";
  } else if (evidence) {
    state = "pending validation or review";
    action = "maestro status --watch";
  } else if (manifest?.status === "human_gate") {
    state = `blocked by human gate${manifest.humanGate ? `: ${manifest.humanGate}` : ""}`;
  } else if (manifest?.status === "blocked" || plan.blocked?.some((entry) => String(entry.id) === issue)) {
    const waiting = (manifest?.blockedBy || []).filter((dependency) => config.work?.[dependency]?.status !== "complete");
    state = `blocked${waiting.length ? `, waiting on ${waiting.map((id) => `#${id}`).join(", ")}` : ""}`;
  } else if (deferred) {
    state = deferred.lifecycle?.state || "in flight";
    action = deferred.lifecycle?.action || null;
  } else if (manifest?.status === "ready") {
    state = selected ? "ready to start next" : "ready";
    action = selected ? "maestro start" : null;
  } else {
    state = manifest?.status || "unknown";
  }

  return {
    issue,
    title: titleFor(config, issue, evidence),
    state,
    action,
    workerCommit: evidence?.worker?.headSha || null,
    validator: validation?.verdict || null,
    humanReview: review?.disposition || null,
    integrationState,
    runId: evidence?.runId || null
  };
}

function runReadiness(states, currentByIssue) {
  const latestRunId = [...states].map((state) => String(state.runId)).sort().at(-1) || null;
  const summaries = [];

  for (const state of [...states].sort((a, b) => String(b.runId).localeCompare(String(a.runId)))) {
    const issues = [...new Set((state.workers || []).map((worker) => String(worker.issue)))];
    if (!issues.length || !issues.some((issue) => currentByIssue.get(issue)?.runId === String(state.runId))) continue;
    if (["running", "failed"].includes(state.status)) continue;
    const integrated = new Set((state.integration || []).map((entry) => String(entry.issue)));
    const assessment = assessRunItems(state);
    const integrate = assessment.integrable.map((entry) => entry.issue).filter((issue) => !integrated.has(issue));
    const skip = assessment.rework.map((entry) => entry.issue);
    const missing = assessment.missing;
    const blocked = assessment.problems
      .filter((problem) => !missing.some((entry) => entry.issue === problem.issue))
      .map((problem) => ({ issue: problem.issue, kind: problem.kind || "valid integration state" }));

    if (integrate.length || skip.length || missing.length || blocked.length) {
      summaries.push({
        runId: String(state.runId),
        integrate,
        skip,
        missing,
        blocked,
        ready: !missing.length && !blocked.length && integrate.length > 0,
        command: String(state.runId) === latestRunId ? "maestro commit" : `maestro commit --run ${state.runId}`
      });
    }
  }
  return summaries;
}

async function statusSnapshot(config, repoPath, requestedIssues = [], {
  stateLoader = loadExecutionStates
} = {}) {
  const states = await stateLoader(repoPath);
  const plan = reconcilePlan(config, states);
  const requested = [...new Set(requestedIssues.map(String))];
  const current = states.length ? currentIssueEvidenceFromStates(states) : [];
  const currentByIssue = new Map(current.map((entry) => [entry.issue, entry]));
  const allIssues = [...new Set([...Object.keys(config.work || {}), ...currentByIssue.keys()])].sort(numericSort);
  const issueIds = requested.length ? requested : allIssues;
  const missing = requested.filter((issue) => !allIssues.includes(issue));
  if (missing.length) throw new Error(`No Maestro workflow state for ${missing.map((issue) => `issue #${issue}`).join(", ")}.`);

  const items = issueIds.map((issue) => {
    const resolved = currentByIssue.get(issue);
    const evidence = resolved ? { ...resolved.evidence, runId: resolved.runId } : null;
    return describeIssue(config, issue, evidence, plan);
  });
  const readiness = runReadiness(states, currentByIssue);
  return {
    repository: config.repository,
    focused: requested.length > 0,
    items,
    readiness,
    recommendations: buildRecommendations(items, readiness, plan.selected || [], { states }),
    selected: plan.selected?.map((item) => String(item.id)) || []
  };
}

function issueHeading(item) {
  return `Issue #${item.issue}${item.title ? ` — ${item.title}` : ""}`;
}

function formatCommit(lines, run) {
  if (run.ready) {
    lines.push(`Commit: ready — integrates ${run.integrate.map((issue) => `#${issue}`).join(", ")}${run.skip.length ? `; skips ${run.skip.map((issue) => `#${issue}`).join(", ")} for rework` : ""}`);
    return;
  }
  const requirements = [
    ...run.missing.map((entry) => `#${entry.issue} needs ${entry.kind}`),
    ...run.blocked.map((entry) => `#${entry.issue} needs ${entry.kind}`)
  ];
  if (requirements.length) lines.push(`Commit: not ready — ${requirements.join("; ")}`);
}

function formatStatus(snapshot) {
  const heading = `MAESTRO  ${snapshot.repository || "repository"}`;
  const lines = [heading, "=".repeat(Math.max(24, heading.length))];

  if (snapshot.focused) {
    for (const item of snapshot.items) {
      lines.push("", `${issueHeading(item)} — ${item.state}`);
      lines.push(`  Worker commit: ${item.workerCommit || "none"}`);
      lines.push(`  Validator: ${item.validator || "none"}`);
      lines.push(`  Human review: ${item.humanReview || "none"}`);
      lines.push(`  Integration: ${item.integrationState}`);
    }
  } else {
    lines.push("");
    for (const item of snapshot.items) lines.push(`${issueHeading(item)} — ${item.state}`);
  }

  for (const run of snapshot.readiness) formatCommit(lines, run);
  if (snapshot.selected.length && !snapshot.items.some((item) => item.action && item.action !== "maestro start")) {
    lines.push(`Next wave: ${snapshot.selected.map((issue) => `#${issue}`).join(", ")}`);
  }
  const recommendations = formatRecommendations(snapshot.recommendations);
  if (recommendations) lines.push("", recommendations.trimEnd());
  return `${lines.join("\n")}\n`;
}

async function watchStatus(config, repoPath, requestedIssues = [], { intervalMs = 2000 } = {}) {
  const interactive = Boolean(process.stdout.isTTY);
  let first = true;
  for (;;) {
    const text = formatStatus(await statusSnapshot(config, repoPath, requestedIssues));
    if (interactive && !first) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(text);
    first = false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { describeIssue, runReadiness, statusSnapshot, formatStatus, watchStatus };

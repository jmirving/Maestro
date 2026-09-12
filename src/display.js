const { loadExecutionStates, reconcilePlan } = require("./work-state");
const { currentIssueEvidenceFromStates, effectiveIssueStates } = require("./run-resolver");
const { assessRunItems } = require("./existing-run");
const { buildRecommendations, formatRecommendations } = require("./recommendations");
const { isValidValidatorOverride } = require("./reviews");
const { capacitySnapshot } = require("./scheduler");
const { formatConcurrency } = require("./concurrency");

function numericSort(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

function titleFor(config, issue, evidence) {
  return [evidence?.selected?.title, evidence?.worker?.title, config.work?.[issue]?.title]
    .find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function planEntry(entries, issue) {
  return entries?.find((entry) => String(entry.id) === issue) || null;
}

function discardedManifestState(issue, manifest, plan, selected) {
  const humanGate = planEntry(plan.humanGates, issue);
  if (humanGate) {
    return `implementation discarded; blocked by human gate${humanGate.humanGate ? `: ${humanGate.humanGate}` : ""}`;
  }

  const blocked = planEntry(plan.blocked, issue);
  if (blocked) {
    return `implementation discarded; blocked${blocked.unresolved?.length
      ? `, waiting on ${blocked.unresolved.map((id) => `#${id}`).join(", ")}`
      : ""}`;
  }

  if (planEntry(plan.ready, issue)) {
    return selected
      ? "implementation discarded, ready for a fresh run"
      : "implementation discarded, eligible for a fresh run";
  }

  return `implementation discarded; manifest state ${manifest?.status || "unknown"} is not eligible for a fresh run`;
}

function describeIssue(config, issue, evidence, plan, effective = null) {
  const manifest = config.work?.[issue] || null;
  const deferred = plan.deferred?.find((entry) => String(entry.id) === issue);
  const selected = plan.selected?.some((entry) => String(entry.id) === issue);
  const validation = evidence?.validation || null;
  const review = evidence?.review || null;
  const integration = evidence?.integration || null;
  let state;
  let integrationState = "not eligible";
  let action = null;

  if (effective?.consistencyConflict) {
    state = "consistency conflict: manifest says complete, but execution history has no integration record";
    integrationState = "blocked pending manifest/run reconciliation";
  } else if (effective?.terminal || manifest?.status === "complete" || integration) {
    state = "integrated/complete";
    integrationState = "integrated";
  } else if (review?.disposition === "discard") {
    state = discardedManifestState(issue, manifest, plan, selected);
    integrationState = "discarded; branch/worktree preserved and excluded from integration";
    action = selected ? "maestro start" : null;
  } else if (review?.disposition === "rework-original") {
    state = "human rework disposition recorded, excluded from integration";
    integrationState = "excluded; will be reworked";
    action = `maestro rework ${issue}`;
  } else if (isValidValidatorOverride(review, validation)) {
    state = "human override approved, ready to integrate";
    integrationState = "eligible when every item in its run has a human disposition";
  } else if (evidence?.autoRework?.status === "retry-exhausted") {
    const attempts = evidence.autoRework.attemptsUsed;
    const limit = evidence.autoRework.retryLimit;
    state = `automatic rework exhausted after ${attempts} of ${limit} correction attempts; human review required`;
    integrationState = "not eligible; inspect the correction lineage and decide whether to rework manually, override, or discard";
    action = `maestro details ${issue}`;
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
    integrationState = "not eligible; correct, override, or discard it";
  } else if (validation?.verdict === "human_gate") {
    state = "validator requested a human decision, awaiting human disposition";
    integrationState = "not eligible until human disposition";
  } else if (["worker-failure", "validator-failure", "infrastructure-failure", "technical-conflict", "timeout", "no-progress"].includes(evidence?.autoRework?.status || evidence?.correction?.outcome)) {
    const outcome = evidence.autoRework?.status || evidence.correction.outcome;
    const attempt = evidence.autoRework?.attemptsUsed ?? evidence.correction?.number ?? 0;
    const conflict = evidence.correction?.conflict;
    state = outcome === "technical-conflict"
      ? `automatic correction stopped after charged attempt ${attempt}: rebase content conflict (${conflict?.operationState || "state unknown"}); resolve safely, then run ${conflict?.continuationAction || `maestro rework ${issue}`}`
      : outcome === "timeout"
        ? `automatic correction stopped${attempt ? ` after charged attempt ${attempt}` : " before a correction attempt"}: session timeout during ${evidence.autoRework?.timeoutStage || evidence.correction?.timeoutStage || "activity"}; human attention required`
        : outcome === "no-progress"
          ? `automatic correction stopped after charged attempt ${attempt}: worker completed without a new commit; human attention required`
      : `automatic correction stopped${attempt ? ` after attempt ${attempt}` : " before a correction attempt"}: ${outcome}; human attention required`;
    integrationState = outcome === "technical-conflict"
      ? "not eligible; conflicted implementation and recovery evidence are preserved"
      : "not eligible; failure evidence is preserved";
    action = outcome === "technical-conflict"
      ? (evidence.autoRework?.action || `maestro details ${issue}`)
      : `maestro details ${issue}`;
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
    autoReworkStatus: evidence?.autoRework?.status || null,
    correctionAttempt: evidence?.correction?.number || null,
    integrationState,
    runId: evidence?.runId || null,
    terminal: Boolean(effective?.terminal),
    consistencyConflict: effective?.consistencyConflict || null,
    actionable: !effective?.terminal && !effective?.consistencyConflict
  };
}

function runReadiness(states, currentByIssue, effectiveByIssue = null) {
  const latestRunId = [...states].map((state) => String(state.runId)).sort().at(-1) || null;
  const summaries = [];

  for (const state of [...states].sort((a, b) => String(b.runId).localeCompare(String(a.runId)))) {
    const issues = [...new Set((state.workers || []).map((worker) => String(worker.issue)))];
    if (!issues.length || !issues.some((issue) => currentByIssue.get(issue)?.runId === String(state.runId))) continue;
    if (["running", "failed"].includes(state.status)) continue;
    const assessment = assessRunItems(state, { effectiveByIssue });
    const integrate = assessment.integrable.map((entry) => entry.issue);
    const skip = assessment.rework.map((entry) => entry.issue);
    const discard = assessment.discarded.map((entry) => entry.issue);
    const missing = assessment.missing;
    const blocked = assessment.problems
      .filter((problem) => !missing.some((entry) => entry.issue === problem.issue))
      .map((problem) => ({ issue: problem.issue, kind: problem.kind || "valid integration state" }));

    if (integrate.length || skip.length || discard.length || missing.length || blocked.length) {
      summaries.push({
        runId: String(state.runId),
        integrate,
        skip,
        discard,
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
  stateLoader = loadExecutionStates,
  concurrency
} = {}) {
  const states = await stateLoader(repoPath);
  const capacity = capacitySnapshot(config, states, { concurrency });
  const plan = capacity.plan;
  const requested = [...new Set(requestedIssues.map(String))];
  const current = states.length ? currentIssueEvidenceFromStates(states) : [];
  const currentByIssue = new Map(current.map((entry) => [entry.issue, entry]));
  const effectiveByIssue = effectiveIssueStates(config, states);
  const allIssues = [...effectiveByIssue.keys()].sort(numericSort);
  const issueIds = requested.length ? requested : allIssues;
  const missing = requested.filter((issue) => !allIssues.includes(issue));
  if (missing.length) throw new Error(`No Maestro workflow state for ${missing.map((issue) => `issue #${issue}`).join(", ")}.`);

  const items = issueIds.map((issue) => {
    const resolved = currentByIssue.get(issue);
    const evidence = resolved ? { ...resolved.evidence, runId: resolved.runId } : null;
    return describeIssue(config, issue, evidence, plan, effectiveByIssue.get(issue));
  });
  const readiness = runReadiness(states, currentByIssue, effectiveByIssue);
  return {
    repository: config.repository,
    concurrency: {
      value: plan.concurrency,
      source: plan.concurrencySource,
      savedDefault: plan.savedDefaultConcurrency
    },
    focused: requested.length > 0,
    items,
    readiness,
    recommendations: buildRecommendations(items, readiness, plan.selected || [], { states }),
    selected: plan.selected?.map((item) => String(item.id)) || [],
    capacity: {
      limit: capacity.limit,
      used: capacity.used,
      available: capacity.available,
      requestedLimit: capacity.requestedLimit,
      idle: capacity.idle
    }
  };
}

function issueHeading(item) {
  return `Issue #${item.issue}${item.title ? ` — ${item.title}` : ""}`;
}

function formatCommit(lines, run) {
  if (run.ready) {
    lines.push(`Commit: ready — integrates ${run.integrate.map((issue) => `#${issue}`).join(", ")}${run.skip.length ? `; skips ${run.skip.map((issue) => `#${issue}`).join(", ")} for rework` : ""}${run.discard.length ? `; excludes discarded ${run.discard.map((issue) => `#${issue}`).join(", ")}` : ""}`);
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
  const lines = [heading, "=".repeat(Math.max(24, heading.length)), formatConcurrency(snapshot.concurrency)];

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

  if (snapshot.capacity) {
    const inherited = snapshot.capacity.requestedLimit !== snapshot.capacity.limit
      ? `; invocation requested ${snapshot.capacity.requestedLimit}, active session keeps ${snapshot.capacity.limit}`
      : "";
    lines.push(`Capacity: ${snapshot.capacity.used}/${snapshot.capacity.limit} worker slots active${inherited}`);
    if (snapshot.capacity.idle && snapshot.capacity.available > 0) {
      lines.push(`Idle capacity: ${snapshot.capacity.available} slot(s) intentional — ${snapshot.capacity.idle.reason} (${snapshot.capacity.idle.kind})`);
    }
  }

  for (const run of snapshot.readiness) formatCommit(lines, run);
  if (snapshot.selected.length && !snapshot.items.some((item) => item.action && item.action !== "maestro start")) {
    lines.push(`Next wave: ${snapshot.selected.map((issue) => `#${issue}`).join(", ")}`);
  }
  const recommendations = formatRecommendations(snapshot.recommendations);
  if (recommendations) lines.push("", recommendations.trimEnd());
  return `${lines.join("\n")}\n`;
}

async function watchStatus(config, repoPath, requestedIssues = [], { intervalMs = 2000, concurrency } = {}) {
  const interactive = Boolean(process.stdout.isTTY);
  let first = true;
  for (;;) {
    const text = formatStatus(await statusSnapshot(config, repoPath, requestedIssues, { concurrency }));
    if (interactive && !first) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(text);
    first = false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { describeIssue, runReadiness, statusSnapshot, formatStatus, watchStatus };

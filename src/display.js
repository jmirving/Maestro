const { loadExecutionStates } = require("./work-state");
const { currentIssueEvidenceFromStates, effectiveIssueStates } = require("./run-resolver");
const { assessRunItems } = require("./existing-run");
const { buildRecommendations, formatRecommendations } = require("./recommendations");
const { isValidValidatorOverride } = require("./reviews");
const { capacitySnapshot } = require("./scheduler");
const { formatConcurrency } = require("./concurrency");
const { loadAuthorization, assessCurrentScope, assessDelegatedAuthorization } = require("./authorization");

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

function describeIssue(config, issue, evidence, plan, effective = null, delegated = null) {
  const manifest = config.work?.[issue] || null;
  const deferred = plan.deferred?.find((entry) => String(entry.id) === issue);
  const selected = plan.selected?.some((entry) => String(entry.id) === issue);
  const validation = evidence?.validation || null;
  const review = evidence?.review || null;
  const integration = evidence?.integration || null;
  const conflict = evidence?.conflict || evidence?.correction?.conflict || null;
  let state;
  let group;
  let integrationState = "not eligible";
  let action = null;

  if (effective?.consistencyConflict) {
    state = "consistency conflict: manifest says complete, but execution history has no integration record";
    group = "attention";
    integrationState = "blocked pending manifest/run reconciliation";
  } else if (effective?.terminal || manifest?.status === "complete" || integration) {
const external = effective?.completion?.source === "external";
    state = external ? "complete (external)" : "integrated/complete";
    group = "complete";
    integrationState = external ? "external completion adopted during reconciliation" : "integrated";
  } else if (conflict && !evidence?.correction?.conflict && !["completed", "resolved", "manually-resolved"].includes(conflict.operationState)) {
    state = `Git ${conflict.operation} content conflict during ${conflict.interruptedStage} (${conflict.operationState}); preserved at ${conflict.worktreePath}`;
    integrationState = "not eligible; conflict recovery and fresh evidence are required";
    action = conflict.continuationAction || `maestro details ${issue}`;
  } else if (review?.disposition === "discard") {
    state = discardedManifestState(issue, manifest, plan, selected);
    group = planEntry(plan.humanGates, issue) ? "attention" : planEntry(plan.blocked, issue) ? "blocked" : "ready";
    integrationState = "discarded; branch/worktree preserved and excluded from integration";
    action = selected ? "maestro start" : null;
  } else if (review?.disposition === "rework-original") {
    state = "human rework disposition recorded, excluded from integration";
    group = "attention";
    integrationState = "excluded; will be reworked";
    action = `maestro rework ${issue}`;
  } else if (isValidValidatorOverride(review, validation)) {
    state = "human override approved, ready to integrate";
    group = "ready-integrate";
    integrationState = "eligible when every item in its run has a human disposition";
  } else if (evidence?.autoRework?.status === "retry-exhausted") {
    const attempts = evidence.autoRework.attemptsUsed;
    const limit = evidence.autoRework.retryLimit;
    state = `automatic rework exhausted after ${attempts} of ${limit} correction attempts; human review required`;
    group = "attention";
    integrationState = "not eligible; inspect the correction lineage and decide whether to rework manually, override, or discard";
    action = `maestro details ${issue}`;
  } else if (delegated?.eligible && validation?.verdict === "approve") {
    state = "validator approved, eligible under delegated policy";
    integrationState = `eligible under delegated authorization ${delegated.authorizationId}`;
  } else if (delegated && validation?.verdict === "approve") {
    state = `validator approved, not eligible under delegated policy: ${delegated.reason || "authorization evidence is invalid"}`;
    integrationState = "not eligible under delegated policy";
  } else if (review && validation?.verdict === "approve") {
    state = "human approved, ready to integrate";
    group = "ready-integrate";
    integrationState = "eligible when every item in its run has a human disposition";
  } else if (review) {
    state = `blocked: human ${review.disposition} conflicts with validator ${validation?.verdict || "state"}`;
    group = "attention";
    integrationState = "blocked by inconsistent review state";
  } else if (validation?.verdict === "approve") {
    state = "validator approved, awaiting human approval";
    group = "awaiting-approval";
    integrationState = "not eligible until human approval";
    action = `maestro approve ${issue}`;
  } else if (validation?.verdict === "rework") {
    state = "validator requested rework, awaiting human rework disposition";
    group = "attention";
    integrationState = "not eligible; correct, override, or discard it";
  } else if (validation?.verdict === "human_gate") {
    state = "validator requested a human decision, awaiting human disposition";
    group = "attention";
    integrationState = "not eligible until human disposition";
  } else if (["worker-failure", "validator-failure", "infrastructure-failure", "technical-conflict", "human-required", "timeout", "no-progress"].includes(evidence?.autoRework?.status || evidence?.correction?.outcome)) {
    const outcome = evidence.autoRework?.status || evidence.correction.outcome;
    const attempt = evidence.autoRework?.attemptsUsed ?? evidence.correction?.number ?? 0;
    const conflict = evidence.correction?.conflict;
    group = "attention";
    state = outcome === "technical-conflict"
      ? `automatic correction stopped after charged attempt ${attempt}: rebase content conflict (${conflict?.operationState || "state unknown"}); resolve safely, then run ${conflict?.continuationAction || `maestro rework ${issue}`}`
      : outcome === "human-required"
        ? `automatic correction stopped after charged attempt ${attempt}: rebase conflict requires human resolution (${conflict?.operationState || "state unknown"}); inspect preserved resolver evidence and Git state`
      : outcome === "timeout"
        ? `automatic correction stopped${attempt ? ` after charged attempt ${attempt}` : " before a correction attempt"}: session timeout during ${evidence.autoRework?.timeoutStage || evidence.correction?.timeoutStage || "activity"}; human attention required`
        : outcome === "no-progress"
          ? `automatic correction stopped after charged attempt ${attempt}: worker completed without a new commit; human attention required`
      : `automatic correction stopped${attempt ? ` after attempt ${attempt}` : " before a correction attempt"}: ${outcome}; human attention required`;
    integrationState = ["technical-conflict", "human-required"].includes(outcome)
      ? "not eligible; conflicted implementation and recovery evidence are preserved"
      : "not eligible; failure evidence is preserved";
    action = ["technical-conflict", "human-required"].includes(outcome)
      ? (evidence.autoRework?.action || `maestro details ${issue}`)
      : `maestro details ${issue}`;
  } else if (evidence?.state === "running" || evidence?.state === "rework-running") {
    state = evidence.state === "rework-running" ? "rework in progress" : "worker in progress";
    group = "in-progress";
    action = "maestro status --watch";
  } else if (evidence?.state === "failed-awaiting-retry" || evidence?.worker?.exitCode > 0) {
    state = "failed, awaiting explicit retry";
    group = "attention";
    action = "maestro start --rerun";
  } else if (evidence) {
    state = "pending validation or review";
    group = "in-progress";
    action = "maestro status --watch";
  } else if (manifest?.status === "human_gate") {
    state = `blocked by human gate${manifest.humanGate ? `: ${manifest.humanGate}` : ""}`;
    group = "attention";
  } else if (manifest?.status === "blocked" || plan.blocked?.some((entry) => String(entry.id) === issue)) {
    const waiting = (manifest?.blockedBy || []).filter((dependency) => config.work?.[dependency]?.status !== "complete");
    state = `blocked${waiting.length ? `, waiting on ${waiting.map((id) => `#${id}`).join(", ")}` : ""}`;
    group = "blocked";
  } else if (deferred) {
    state = deferred.lifecycle?.state || "in flight";
    group = ["running", "rework-running"].includes(deferred.lifecycle?.state) ? "in-progress" : "ready";
    action = deferred.lifecycle?.action || null;
  } else if (manifest?.status === "ready") {
    state = selected ? "ready to start next" : "ready";
    group = "ready";
    action = selected ? "maestro start" : null;
  } else {
    state = manifest?.status || "unknown";
    group = "other";
  }

  return {
    issue,
    title: titleFor(config, issue, evidence),
    state,
    group,
    action,
    workerCommit: evidence?.worker?.headSha || null,
    validator: validation?.verdict || null,
    humanReview: review?.disposition || null,
    autoReworkStatus: evidence?.autoRework?.status || null,
    technicalConflict: !effective?.terminal && !effective?.consistencyConflict && conflict && !["completed", "resolved", "manually-resolved"].includes(conflict.operationState) ? conflict : null,
    correctionAttempt: evidence?.correction?.number || null,
    integrationState,
    completionSource: effective?.completion?.source || null,
    runId: evidence?.runId || null,
    terminal: Boolean(effective?.terminal),
    consistencyConflict: effective?.consistencyConflict || null,
    actionable: !effective?.terminal && !effective?.consistencyConflict
  };
}

function runReadiness(states, currentByIssue, effectiveByIssue = null, delegatedByRun = new Map()) {
  const latestRunId = [...states].map((state) => String(state.runId)).sort().at(-1) || null;
  const summaries = [];

  for (const state of [...states].sort((a, b) => String(b.runId).localeCompare(String(a.runId)))) {
    const issues = [...new Set((state.workers || []).map((worker) => String(worker.issue)))];
    if (!issues.length || !issues.some((issue) => currentByIssue.get(issue)?.runId === String(state.runId))) continue;
    if (["running", "failed"].includes(state.status)) continue;
    const assessment = assessRunItems(state, { effectiveByIssue, delegatedByIssue: delegatedByRun.get(String(state.runId)) || new Map() });
    const integrate = assessment.integrable.map((entry) => entry.issue);
    const skip = [...assessment.rework, ...assessment.gated, ...assessment.failed].map((entry) => entry.issue);
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
  concurrency,
  scopeAssessmentOptions = {},
  view = "default"
} = {}) {
  if (!["default", "all", "completed"].includes(view)) throw new Error(`Unknown status view: ${view}.`);
  const states = await stateLoader(repoPath);
  const capacity = capacitySnapshot(config, states, { concurrency });
  const plan = capacity.plan;
  const requested = [...new Set(requestedIssues.map(String))];
  if (requested.length && view !== "default") {
    throw new Error("Focused status issue selections cannot be combined with --all or --completed.");
  }
  const current = states.length ? currentIssueEvidenceFromStates(states) : [];
  const currentByIssue = new Map(current.map((entry) => [entry.issue, entry]));
  const effectiveByIssue = effectiveIssueStates(config, states);
  const statesById = new Map(states.map((state) => [String(state.runId), state]));
  const delegatedByRun = new Map();
  for (const state of states) {
    if (!state.authorization?.id) continue;
    let persisted = null;
    try { persisted = await loadAuthorization(repoPath, state.authorization.id); } catch {}
    const scopeAssessment = state.authorization?.kind === "delegated"
      ? await assessCurrentScope({ config, repoPath, authorization: state.authorization, ...scopeAssessmentOptions })
      : null;
    delegatedByRun.set(String(state.runId), new Map((state.workers || []).map((worker) => {
      const issue = String(worker.issue);
      const validation = (state.validations || []).find((entry) => String(entry.issue) === issue);
      return [issue, assessDelegatedAuthorization({ config, repoPath, state, issue, worker, validation, authorization: state.authorization, persistedAuthorization: persisted, statesById, scopeAssessment })];
    })));
  }
  const allIssues = [...effectiveByIssue.keys()].sort(numericSort);
  const issueIds = requested.length ? requested : allIssues;
  const missing = requested.filter((issue) => !allIssues.includes(issue));
  if (missing.length) throw new Error(`No Maestro workflow state for ${missing.map((issue) => `issue #${issue}`).join(", ")}.`);

  const items = issueIds.map((issue) => {
    const resolved = currentByIssue.get(issue);
    const evidence = resolved ? { ...resolved.evidence, runId: resolved.runId } : null;
    const delegated = resolved ? delegatedByRun.get(String(resolved.runId))?.get(issue) : null;
    return describeIssue(config, issue, evidence, plan, effectiveByIssue.get(issue), delegated);
  });
  const readiness = runReadiness(states, currentByIssue, effectiveByIssue, delegatedByRun);
  for (const item of items.filter((entry) => entry.group === "ready-integrate")) {
    const commitReady = readiness.some((run) => run.ready && run.integrate.includes(item.issue));
    if (!commitReady) item.group = "awaiting-integration";
  }
  return {
    repository: config.repository,
    concurrency: {
      value: plan.concurrency,
      source: plan.concurrencySource,
      savedDefault: plan.savedDefaultConcurrency
    },
    focused: requested.length > 0,
    view,
    items,
    readiness,
    recommendations: buildRecommendations(items, readiness, plan.selected || [], {
      states,
      issueLimit: !requested.length && view === "default" ? 5 : Number.POSITIVE_INFINITY,
      actionLimit: !requested.length && view === "default" ? 8 : Number.POSITIVE_INFINITY,
      expansionCommand: !requested.length && view === "default" ? "maestro status --all" : null
    }),
    selected: plan.selected?.map((item) => String(item.id)) || [],
    scheduler: {
      selected: (plan.selected || []).map((item) => String(item.id)),
      ready: (plan.ready || []).map((item) => String(item.id)),
      blocked: (plan.blocked || []).map((item) => String(item.id)),
      humanGates: (plan.humanGates || []).map((item) => String(item.id)),
      advisoryDeferred: (plan.advisoryDeferred || []).map((item) => ({
        issue: String(item.id),
        conflictsWith: item.conflictsWith ? String(item.conflictsWith) : null,
        reason: item.reason || null
      })),
      priority: Object.fromEntries((plan.ready || []).map((item) => [String(item.id), item.priority]))
    },
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

function issueList(issues, expanded) {
  const limit = expanded ? Number.POSITIVE_INFINITY : 5;
  const shown = issues.slice(0, limit).map((issue) => `#${issue}`).join(", ");
  const hidden = issues.length - Math.min(issues.length, limit);
  return `${shown}${hidden ? ` (+${hidden} more; use maestro status --all)` : ""}`;
}

function formatCommit(lines, run, { expanded = false } = {}) {
  if (run.ready) {
    lines.push(`Commit: ready — integrates ${issueList(run.integrate, expanded)}${run.skip.length ? `; skips ${issueList(run.skip, expanded)} for rework` : ""}${run.discard.length ? `; excludes discarded ${issueList(run.discard, expanded)}` : ""}; run \`${run.command}\``);
    return;
  }
  const requirements = [
    ...run.missing.map((entry) => `#${entry.issue} needs ${entry.kind}`),
    ...run.blocked.map((entry) => `#${entry.issue} needs ${entry.kind}`)
  ];
  if (requirements.length) {
    const limit = expanded ? Number.POSITIVE_INFINITY : 5;
    const hidden = requirements.length - Math.min(requirements.length, limit);
    lines.push(`Commit: not ready — ${requirements.slice(0, limit).join("; ")}${hidden ? `; ${hidden} more requirements (use maestro status --all)` : ""}; inspect run ${run.runId}`);
  }
}

function formatReadiness(lines, snapshot) {
  const expanded = snapshot.focused || snapshot.view === "all";
  const ordered = [
    ...snapshot.readiness.filter((run) => run.ready),
    ...snapshot.readiness.filter((run) => !run.ready)
  ];
  const displayed = expanded ? ordered : ordered.slice(0, 5);
  for (const run of displayed) formatCommit(lines, run, { expanded });
  if (displayed.length === ordered.length) return;

  const hidden = ordered.slice(displayed.length);
  const ready = hidden.filter((run) => run.ready).length;
  const notReady = hidden.length - ready;
  lines.push(`Run readiness: ${hidden.length} more ${hidden.length === 1 ? "run" : "runs"} hidden (${ready} ready, ${notReady} not ready; use maestro status --all)`);
}

function wrapLine(line, columns, continuation = "  ") {
  if (!Number.isFinite(columns) || columns < 20 || line.length <= columns) return [line];
  const output = [];
  let remaining = line;
  while (remaining.length > columns) {
    let split = remaining.lastIndexOf(" ", columns);
    if (split <= continuation.length) split = columns;
    output.push(remaining.slice(0, split));
    remaining = `${continuation}${remaining.slice(split).trimStart()}`;
  }
  output.push(remaining);
  return output;
}

function issueLabel(item) {
  return `#${item.issue}${item.title ? ` ${item.title}` : ""}`;
}

function formatGroupedStatus(lines, snapshot, { columns = Number.POSITIVE_INFINITY } = {}) {
  const itemByIssue = new Map(snapshot.items.map((item) => [String(item.issue), item]));
  const scheduler = snapshot.scheduler || { selected: snapshot.selected || [], ready: [], blocked: [] };
  const selected = new Set(scheduler.selected || []);
  const all = snapshot.view === "all";
  const previewLimit = all ? Number.POSITIVE_INFINITY : 5;
  const rendered = new Set();

  function addGroup(label, items, { detail = true, limit = previewLimit } = {}) {
    if (!items.length) return;
    lines.push("", `${label} (${items.length})`);
    for (const item of items.slice(0, limit)) {
      rendered.add(String(item.issue));
      const displayedState = item.group === "awaiting-integration"
        ? item.state.replace("ready to integrate", "awaiting other run dispositions")
        : item.state;
      const row = detail ? `  ${issueLabel(item)} - ${displayedState}` : `  ${issueLabel(item)}`;
      lines.push(...wrapLine(row, columns, "    "));
    }
    if (items.length > limit) {
      lines.push(`  ... ${items.length - limit} more (use maestro status --all)`);
    }
  }

  if (snapshot.view === "completed") {
    const completed = snapshot.items.filter((item) => item.group === "complete").sort((a, b) => numericSort(a.issue, b.issue));
    if (!completed.length) lines.push("", "Complete (0)", "  No completed work.");
    else addGroup("Complete", completed, { limit: Number.POSITIVE_INFINITY });
    return;
  }

  if (!snapshot.items.length) lines.push("", "No known work.");

  const byGroup = (group) => snapshot.items
    .filter((item) => item.group === group)
    .sort((a, b) => numericSort(a.issue, b.issue));
  addGroup("Needs attention", byGroup("attention"), { limit: all ? Number.POSITIVE_INFINITY : 8 });
  addGroup("Awaiting human approval", byGroup("awaiting-approval"));
  addGroup("Ready to integrate", byGroup("ready-integrate"));
  addGroup("Awaiting integration readiness", byGroup("awaiting-integration"));
  addGroup("In progress", byGroup("in-progress"));

  const next = (scheduler.selected || []).map((issue) => itemByIssue.get(String(issue))).filter(Boolean);
  if (next.length) {
    lines.push("", `Next (${next.length}, scheduler order)`);
    for (const item of next) {
      rendered.add(String(item.issue));
      const priority = scheduler.priority?.[item.issue];
      const reason = priority == null ? "selected by dependency, conflict, and capacity rules" : `priority ${priority}; dependency, conflict, and capacity rules satisfied`;
      lines.push(...wrapLine(`  ${issueLabel(item)} - ${item.state}; ${reason}`, columns, "    "));
    }
  }

  const remainingReady = (scheduler.ready || [])
    .filter((issue) => !selected.has(String(issue)))
    .map((issue) => itemByIssue.get(String(issue)))
    .filter(Boolean)
    .map((item) => {
      const deferred = (scheduler.advisoryDeferred || []).find((entry) => entry.issue === String(item.issue));
      return {
        ...item,
        state: deferred
          ? `ready; scheduled separately from #${deferred.conflictsWith}${deferred.reason ? ` (${deferred.reason})` : ""}`
          : "ready after the selected wave"
      };
    });
  addGroup("Remaining ready", remainingReady);

  addGroup("Blocked", byGroup("blocked"));

  const other = byGroup("other").filter((item) => !rendered.has(String(item.issue)));
  addGroup("Other", other);

  const completed = byGroup("complete");
  if (all) addGroup("Complete", completed, { limit: Number.POSITIVE_INFINITY });
  else if (completed.length) lines.push("", `Complete: ${completed.length} (history collapsed; use maestro status --completed)`);
}

function formatStatus(snapshot, { columns = Number.POSITIVE_INFINITY } = {}) {
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
    formatGroupedStatus(lines, snapshot, { columns });
  }

  if (snapshot.view === "completed") {
    return `${lines.flatMap((line) => wrapLine(line, columns)).join("\n")}\n`;
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

  formatReadiness(lines, snapshot);
  const recommendations = formatRecommendations(snapshot.recommendations);
  if (recommendations) lines.push("", recommendations.trimEnd());
  return `${lines.flatMap((line) => wrapLine(line, columns)).join("\n")}\n`;
}

async function watchStatus(config, repoPath, requestedIssues = [], { intervalMs = 2000, concurrency, view = "default", columns } = {}) {
  const interactive = Boolean(process.stdout.isTTY);
  let first = true;
  for (;;) {
    const text = formatStatus(await statusSnapshot(config, repoPath, requestedIssues, { concurrency, view }), { columns });
    if (interactive && !first) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(text);
    first = false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = { describeIssue, runReadiness, statusSnapshot, formatStatus, watchStatus };

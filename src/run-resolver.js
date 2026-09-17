const path = require("node:path");
const { loadPersistedRunStates, loadRunState } = require("./run-store");
const { classifyRunIssue } = require("./run-lifecycle");
const { isValidValidatorOverride } = require("./reviews");

const FILTER_KEYS = new Set([
  "state",
  "verdict",
  "disposition",
  "runStatus",
  "mode",
  "integrated",
  "predicate",
  "anyOf",
  "allOf"
]);

function issueIdsForRun(state) {
  return [...new Set([
    ...(state.plan?.selected || []).map((entry) => String(entry.id)),
    ...(state.workers || []).map((entry) => String(entry.issue)),
    ...(state.validations || []).map((entry) => String(entry.issue)),
    ...Object.keys(state.reviews || {}).map(String),
    ...(state.integration || []).map((entry) => String(entry.issue)),
    ...Object.keys(state.conflicts || {}).map(String)
  ])];
}

function lifecycleState(state, { worker, validation, review, integration, selected, conflict }) {
  if (conflict && !["completed", "resolved", "manually-resolved"].includes(conflict.operationState)) return "technical-conflict";
  if (worker) return classifyRunIssue(state, worker).state;
  if (integration) return "integrated-pending-manifest";
  if (review?.disposition === "discard") return "discarded";
  if (isValidValidatorOverride(review, validation)) return "awaiting-integration";
  if (review?.disposition === "rework-original" || validation?.verdict === "rework") return "awaiting-rework";
  if (review && validation?.verdict === "approve") return "awaiting-integration";
  if (["approve", "human_gate"].includes(validation?.verdict)) return "awaiting-human-review";
  if (selected && state.status === "running") return state.mode === "rework" ? "rework-running" : "running";
  if (selected && state.status === "failed") return "failed-awaiting-retry";
  if (selected) return state.status || "selected";
  return null;
}

function evidenceForIssue(state, issueId) {
  const issue = String(issueId);
  const worker = (state.workers || []).find((entry) => String(entry.issue) === issue) || null;
  const validation = (state.validations || []).find((entry) => String(entry.issue) === issue) || null;
  const review = state.reviews?.[issue] || null;
  const integration = (state.integration || []).find((entry) => String(entry.issue) === issue) || null;
  const autoRework = state.autoRework?.[issue] || null;
  const correction = state.correction?.attempts?.[issue] || null;
  const conflict = state.conflicts?.[issue] || correction?.conflict || null;
  const selected = (state.plan?.selected || []).find((entry) => String(entry.id) === issue) || null;
  if (!worker && !validation && !review && !integration && !selected && !conflict) return null;
  const evidence = { issue, worker, validation, review, integration, selected, autoRework, correction, conflict, runFailure: state.failure || null };
  return {
    ...evidence,
    state: lifecycleState(state, evidence),
    verdict: validation?.verdict || null,
    disposition: review?.disposition || null,
    integrated: Boolean(integration)
  };
}

function valuesMatch(actual, expected) {
  if (expected instanceof Set) return expected.has(actual);
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

function validateFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new Error("Run resolution filter must be an object.");
  }
  const unknown = Object.keys(filter).filter((key) => !FILTER_KEYS.has(key));
  if (unknown.length) throw new Error(`Unknown run resolution filter: ${unknown.join(", ")}.`);
  for (const key of ["anyOf", "allOf"]) {
    if (filter[key] !== undefined && (!Array.isArray(filter[key]) || !filter[key].length)) {
      throw new Error(`Run resolution filter ${key} must be a non-empty array.`);
    }
    for (const nested of filter[key] || []) validateFilter(nested);
  }
  if (filter.predicate !== undefined && typeof filter.predicate !== "function") {
    throw new Error("Run resolution filter predicate must be a function.");
  }
}

function matchesFilter(state, evidence, filter = {}) {
  if (Object.hasOwn(filter, "state") && !valuesMatch(evidence?.state ?? null, filter.state)) return false;
  if (Object.hasOwn(filter, "verdict") && !valuesMatch(evidence?.verdict ?? null, filter.verdict)) return false;
  if (Object.hasOwn(filter, "disposition") && !valuesMatch(evidence?.disposition ?? null, filter.disposition)) return false;
  if (Object.hasOwn(filter, "runStatus") && !valuesMatch(state.status ?? null, filter.runStatus)) return false;
  if (Object.hasOwn(filter, "mode") && !valuesMatch(state.mode ?? null, filter.mode)) return false;
  if (Object.hasOwn(filter, "integrated") && !valuesMatch(evidence?.integrated ?? false, filter.integrated)) return false;
  if (filter.predicate && !filter.predicate({ state, evidence })) return false;
  if (filter.allOf && !filter.allOf.every((entry) => matchesFilter(state, evidence, entry))) return false;
  if (filter.anyOf && !filter.anyOf.some((entry) => matchesFilter(state, evidence, entry))) return false;
  return true;
}

function normalizeIssueIds(issueIds) {
  if (issueIds === null || issueIds === undefined) return [];
  if (!Array.isArray(issueIds)) throw new Error("Run resolution issueIds must be an array.");
  return [...new Set(issueIds.map(String))];
}

function filterDescription(filter) {
  const parts = [];
  for (const key of ["state", "verdict", "disposition", "runStatus", "mode", "integrated"]) {
    if (!Object.hasOwn(filter, key)) continue;
    const value = filter[key] instanceof Set ? [...filter[key]] : filter[key];
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  if (filter.anyOf) parts.push("one of the requested semantic filters");
  if (filter.allOf) parts.push("all requested semantic filters");
  if (filter.predicate) parts.push("the requested predicate");
  return parts.length ? ` matching ${parts.join(", ")}` : "";
}

function newestFirst(states) {
  return [...states].sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

function matchingEvidence(state, issueIds, filter) {
  const targets = issueIds.length ? issueIds : issueIdsForRun(state);
  return targets
    .map((issue) => evidenceForIssue(state, issue))
    .filter((evidence) => evidence && matchesFilter(state, evidence, filter));
}

function currentIssueEvidenceFromStates(states, issueIds = []) {
  const requested = normalizeIssueIds(issueIds);
  const requestedSet = requested.length ? new Set(requested) : null;
  const current = new Map();
  const byRunId = new Map(states.map((state) => [String(state.runId), state]));
  const issues = [...new Set(states.flatMap(issueIdsForRun))]
    .filter((issue) => !requestedSet || requestedSet.has(issue));

  function descendsFrom(state, ancestorRunId) {
    const seen = new Set();
    let parentRunId = state.parentRunId ? String(state.parentRunId) : null;
    while (parentRunId && !seen.has(parentRunId)) {
      if (parentRunId === ancestorRunId) return true;
      seen.add(parentRunId);
      parentRunId = byRunId.get(parentRunId)?.parentRunId
        ? String(byRunId.get(parentRunId).parentRunId)
        : null;
    }
    return false;
  }

  for (const issue of issues) {
    const candidates = newestFirst(states).filter((state) => (
      state.status !== "cancelled" && evidenceForIssue(state, issue)
    ));
    const integrated = candidates.find((candidate) => evidenceForIssue(candidate, issue)?.integration);
    const leaves = candidates.filter((candidate) => !candidates.some((other) => (
      other !== candidate && descendsFrom(other, String(candidate.runId))
    )));
    const state = integrated || leaves[0];
    if (state) {
      current.set(issue, {
        issue,
        runId: String(state.runId),
        state,
        evidence: evidenceForIssue(state, issue)
      });
    }
  }

  if (requested.length) {
    const missing = requested.filter((issue) => !current.has(issue));
    if (missing.length) {
      throw new Error(`No relevant Maestro run for ${missing.map((issue) => `issue #${issue}`).join(", ")}.`);
    }
    return requested.map((issue) => current.get(issue));
  }

  return [...current.values()].sort((a, b) => a.issue.localeCompare(b.issue, undefined, { numeric: true }));
}

function effectiveIssueStates(config, states, issueIds = []) {
  const requested = normalizeIssueIds(issueIds);
  const current = new Map(currentIssueEvidenceFromStates(states)
    .filter((entry) => !requested.length || requested.includes(entry.issue))
    .map((entry) => [entry.issue, entry]));
  const allIssues = requested.length
    ? requested
    : [...new Set([...Object.keys(config?.work || {}).map(String), ...states.flatMap(issueIdsForRun)])];
  const ordered = newestFirst(states);

  return new Map(allIssues.map((issue) => {
    const manifest = config?.work?.[issue] || null;
    const resolved = current.get(issue) || null;
    const evidenceRuns = ordered.filter((state) => evidenceForIssue(state, issue));
    const integratedRun = evidenceRuns.find((state) => (
      (state.integration || []).some((entry) => String(entry.issue) === issue)
    ));
    const integration = integratedRun
      ? evidenceForIssue(integratedRun, issue).integration
      : null;
    const manifestComplete = manifest?.status === "complete";
    const externalCompletion = manifestComplete && manifest?.completion?.source === "external"
      ? manifest.completion
      : null;
    const consistencyConflict = manifestComplete && evidenceRuns.length > 0 && !integration && !externalCompletion
      ? `Issue #${issue} is complete in the manifest, but persisted execution history has no integration record. Reconcile the manifest and run evidence before integration.`
      : null;

    return [issue, {
      issue,
      manifest,
      current: resolved,
      evidence: resolved?.evidence || null,
      integration,
      integrationRunId: integratedRun ? String(integratedRun.runId) : null,
      completion: integration ? { source: "maestro", integration } : externalCompletion,
      terminal: Boolean(integration) || Boolean(externalCompletion) || (manifestComplete && !consistencyConflict),
      consistencyConflict,
      state: consistencyConflict
        ? "consistency-conflict"
        : integration
          ? manifestComplete ? "complete" : "integrated-pending-manifest"
          : externalCompletion ? "complete-external"
            : manifestComplete ? "complete" : resolved?.evidence?.state || manifest?.status || "unknown"
    }];
  }));
}

function resolveFromStates(states, { issueIds = [], filter = {}, explicitRunId = null } = {}) {
  validateFilter(filter);
  const issues = normalizeIssueIds(issueIds);
  const ordered = newestFirst(states);
  const candidates = explicitRunId
    ? ordered.filter((state) => String(state.runId) === String(explicitRunId))
    : ordered.filter((state) => state.status !== "cancelled");

  if (explicitRunId && !candidates.length) throw new Error(`No Maestro run ${explicitRunId} found.`);
  if (!ordered.length) throw new Error("No persisted Maestro runs are available for resolution.");

  for (const state of candidates) {
    const evidence = matchingEvidence(state, issues, filter);
    const matches = issues.length ? evidence.length === issues.length : matchesFilter(state, null, filter) || evidence.length > 0;
    if (matches) return { runId: String(state.runId), state, evidence };
  }

  if (issues.length > 1 && !explicitRunId) {
    const individual = issues.map((issue) => {
      const match = ordered.find((state) => matchingEvidence(state, [issue], filter).length === 1);
      return { issue, runId: match ? String(match.runId) : null };
    });
    if (individual.every((entry) => entry.runId)) {
      const locations = individual.map((entry) => `#${entry.issue} in ${entry.runId}`).join(", ");
      throw new Error(`Issues ${issues.map((issue) => `#${issue}`).join(", ")} do not share a relevant Maestro run${filterDescription(filter)}; latest matches are ${locations}. Resolve them separately or pass --run <id>.`);
    }
  }

  const scope = issues.length
    ? ` for ${issues.map((issue) => `issue #${issue}`).join(", ")}`
    : "";
  const explicit = explicitRunId ? ` in explicit run ${explicitRunId}` : "";
  throw new Error(`No relevant Maestro run${scope}${filterDescription(filter)}${explicit}.`);
}

async function resolveLatestRun(repoPath, options = {}) {
  const explicitRunId = options.explicitRunId || options.runId || null;
  let states;
  try {
    states = explicitRunId
      ? [await loadRunState(repoPath, explicitRunId)]
      : await loadPersistedRunStates(repoPath);
  } catch (error) {
    if (explicitRunId && (error.code === "ENOENT" || /No Maestro run/.test(error.message))) {
      throw new Error(`No Maestro run ${explicitRunId} found.`);
    }
    throw error;
  }
  try {
    return resolveFromStates(states, { ...options, explicitRunId });
  } catch (error) {
    if (error.message === "No persisted Maestro runs are available for resolution.") {
      throw new Error(`No Maestro runs found for ${path.resolve(repoPath)}.`);
    }
    throw error;
  }
}

async function resolveRunsForIssues(repoPath, issueIds, options = {}) {
  const issues = normalizeIssueIds(issueIds);
  if (!issues.length) throw new Error("At least one issue ID is required for per-issue run resolution.");
  const explicitRunId = options.explicitRunId || options.runId || null;
  let states;
  try {
    states = explicitRunId
      ? [await loadRunState(repoPath, explicitRunId)]
      : await loadPersistedRunStates(repoPath);
  } catch (error) {
    if (explicitRunId && (error.code === "ENOENT" || /No Maestro run/.test(error.message))) {
      throw new Error(`No Maestro run ${explicitRunId} found.`);
    }
    throw error;
  }
  try {
    return issues.map((issue) => {
      const resolved = resolveFromStates(states, { ...options, issueIds: [issue], explicitRunId });
      return { issue, ...resolved, evidence: resolved.evidence[0] };
    });
  } catch (error) {
    if (error.message === "No persisted Maestro runs are available for resolution.") {
      throw new Error(`No Maestro runs found for ${path.resolve(repoPath)}.`);
    }
    throw error;
  }
}

async function resolveCurrentIssueStates(repoPath, issueIds = []) {
  const states = await loadPersistedRunStates(repoPath);
  if (!states.length) throw new Error(`No Maestro runs found for ${path.resolve(repoPath)}.`);
  return currentIssueEvidenceFromStates(states, issueIds);
}

async function runDescendsFrom(repoPath, state, ancestorRunId, stateLoader = loadRunState) {
  const ancestor = String(ancestorRunId);
  const seen = new Set();
  let parentRunId = state?.parentRunId ? String(state.parentRunId) : null;
  while (parentRunId && !seen.has(parentRunId)) {
    if (parentRunId === ancestor) return true;
    seen.add(parentRunId);
    const parent = await stateLoader(repoPath, parentRunId);
    parentRunId = parent.parentRunId ? String(parent.parentRunId) : null;
  }
  return false;
}

module.exports = {
  issueIdsForRun,
  evidenceForIssue,
  currentIssueEvidenceFromStates,
  effectiveIssueStates,
  matchesFilter,
  resolveFromStates,
  resolveLatestRun,
  resolveRunsForIssues,
  resolveCurrentIssueStates,
  runDescendsFrom
};

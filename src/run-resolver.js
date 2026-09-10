const path = require("node:path");
const { loadPersistedRunStates, loadRunState } = require("./run-store");
const { classifyRunIssue } = require("./run-lifecycle");

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
    ...(state.integration || []).map((entry) => String(entry.issue))
  ])];
}

function lifecycleState(state, { worker, validation, review, integration, selected }) {
  if (worker) return classifyRunIssue(state, worker).state;
  if (integration) return "integrated-pending-manifest";
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
  const selected = (state.plan?.selected || []).find((entry) => String(entry.id) === issue) || null;
  if (!worker && !validation && !review && !integration && !selected) return null;
  const evidence = { issue, worker, validation, review, integration, selected };
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

function resolveFromStates(states, { issueIds = [], filter = {}, explicitRunId = null } = {}) {
  validateFilter(filter);
  const issues = normalizeIssueIds(issueIds);
  const ordered = newestFirst(states);
  const candidates = explicitRunId
    ? ordered.filter((state) => String(state.runId) === String(explicitRunId))
    : ordered;

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

module.exports = {
  issueIdsForRun,
  evidenceForIssue,
  matchesFilter,
  resolveFromStates,
  resolveLatestRun,
  resolveRunsForIssues
};

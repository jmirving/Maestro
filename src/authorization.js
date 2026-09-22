const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { coordinatedRepoPath, reportRootForRepo } = require("./reporter");
const { withRepositoryCoordination } = require("./repository-coordination");
const { loadScopeSnapshot } = require("./scope-store");
const { resolveWorksetScope, assertExecutableScope } = require("./worksets");

const EXECUTION_POLICY_VERSION = "delegated-integration-v2";
const DEFAULT_ACTIONS = Object.freeze({
  implement: true,
  correct: true,
  integrate: true,
  pushDefaultBranch: true,
  closeIssue: false,
  createFollowUp: false,
  admitFollowUp: false
});
const delegatedAssessments = new WeakSet();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function normalizeLimits(limits = {}) {
  return {
    concurrency: Number(limits.concurrency),
    correction: {
      enabled: limits.correction?.enabled === true,
      retryLimit: Number(limits.correction?.retryLimit || 0),
      deadlineMs: Number(limits.correction?.deadlineMs || 0)
    }
  };
}

function issuePolicy(config, issueIds, limits = {}) {
  const ids = [...new Set(issueIds.map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    version: EXECUTION_POLICY_VERSION,
    defaultBranch: config.defaultBranch || "main",
    baseline: {
      commands: config.baseline?.commands || config.integration?.commands || [],
      allowFailing: config.baseline?.allowFailing === true
    },
    integration: {
      enabled: config.integration?.enabled === true,
      commands: config.integration?.commands || [],
      postMergeCommands: config.integration?.postMergeCommands || [],
      closeIssues: config.integration?.closeIssues === true
    },
    limits: normalizeLimits(limits),
    capabilities: ids.map((issue) => ({
      issue,
      requires: [...(config.work?.[issue]?.requires || [])].sort(),
      definitions: Object.fromEntries((config.work?.[issue]?.requires || []).sort().map((name) => [name, config.capabilities?.[name] || null]))
    }))
  };
}

function scopeMaterial(config, issueIds, scope = null) {
  const ids = [...new Set(issueIds.map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    type: scope?.workset ? "workset" : "issues",
    workset: scope?.workset || null,
    revision: scope?.revision || digest(ids.map((issue) => [issue, config.work?.[issue] || null])),
    issueIds: ids
  };
}

function availableActor(env = process.env) {
  const actor = env.GITHUB_ACTOR || env.USER || env.USERNAME || null;
  return actor ? { name: actor, source: env.GITHUB_ACTOR ? "GITHUB_ACTOR" : env.USER ? "USER" : "USERNAME" } : null;
}

function createDelegatedAuthorization({ config, repoPath, runId, issueIds, scope = null, limits = {}, invocation = process.argv, actor = availableActor(), now = new Date(), renews = null }) {
  if (!issueIds?.length) throw new Error("Delegated authorization requires at least one resolved issue.");
  const protectedLimits = normalizeLimits(limits);
  if (!Number.isInteger(protectedLimits.concurrency) || protectedLimits.concurrency < 1) {
    throw new Error("Delegated authorization requires a protected positive concurrency limit.");
  }
  if (protectedLimits.correction.enabled && (
    !Number.isInteger(protectedLimits.correction.retryLimit) || protectedLimits.correction.retryLimit < 1 ||
    !Number.isFinite(protectedLimits.correction.deadlineMs) || protectedLimits.correction.deadlineMs <= 0
  )) {
    throw new Error("Delegated automatic correction requires protected retry and deadline limits.");
  }
  const policy = issuePolicy(config, issueIds, protectedLimits);
  if (!policy.integration.enabled) throw new Error("Delegated integration requires integration.enabled=true in the repository manifest.");
  const resolvedScope = scopeMaterial(config, issueIds, scope);
  const repositoryRoot = coordinatedRepoPath(repoPath);
  const id = `delegation-${String(runId)}-${digest({ repository: config.repository, repositoryRoot, resolvedScope, now: now.toISOString() }).slice(0, 12)}`;
  return {
    id,
    kind: "delegated",
    status: "active",
    policyVersion: EXECUTION_POLICY_VERSION,
    repository: config.repository,
    repositoryRoot,
    targetBranch: config.defaultBranch || "main",
    runId: String(runId),
    lineageRootRunId: String(runId),
    scope: resolvedScope,
    limits: protectedLimits,
    policyDigest: digest(policy),
    policy,
    allowedActions: { ...DEFAULT_ACTIONS, closeIssue: config.integration?.closeIssues === true },
    createdAt: now.toISOString(),
    ...(actor ? { actor } : {}),
    invocation: Array.isArray(invocation) ? invocation.map(String) : [String(invocation)],
    ...(renews ? { renews: String(renews) } : {})
  };
}

function authorizationPath(repoPath, id) {
  if (!/^delegation-[A-Za-z0-9._-]+$/.test(id)) throw new Error("Invalid delegated authorization id.");
  return path.join(reportRootForRepo(repoPath), `authorization-${id}.json`);
}

async function saveAuthorization(repoPath, authorization) {
  const file = authorizationPath(repoPath, authorization.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(authorization, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
  return file;
}

async function loadAuthorization(repoPath, id) {
  try {
    return JSON.parse(await fs.readFile(authorizationPath(repoPath, id), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Delegated authorization ${id} is not available in this repository session.`);
    throw error;
  }
}

async function revokeAuthorization(repoPath, id, { invocation = process.argv, actor = availableActor(), now = new Date() } = {}) {
  return withRepositoryCoordination(repoPath, async () => {
    const authorization = await loadAuthorization(repoPath, id);
    const revoked = {
      ...authorization,
      status: "revoked",
      revokedAt: now.toISOString(),
      revocation: { invocation: invocation.map(String), ...(actor ? { actor } : {}) }
    };
    await saveAuthorization(repoPath, revoked);
    return revoked;
  });
}

function validationContext(config, worker, issue) {
  return {
    implementationSha: worker.headSha || null,
    baseSha: worker.baseSha || null,
    acceptanceDigest: digest({
      issue: String(issue),
      work: config.work?.[String(issue)] || null,
      policy: issuePolicy(config, [String(issue)])
    })
  };
}

function bindValidation(config, worker, validation) {
  return { ...validation, evidence: validationContext(config, worker, worker.issue) };
}

function lineageIncludes(statesById, state, ancestorRunId) {
  const seen = new Set();
  let current = state;
  while (current) {
    if (String(current.runId) === String(ancestorRunId)) return true;
    const parent = current.parentRunId ? String(current.parentRunId) : null;
    if (!parent || seen.has(parent)) return false;
    seen.add(parent);
    current = statesById?.get(parent);
  }
  return false;
}

async function assessCurrentScope({ config, repoPath, authorization, snapshotLoader = loadScopeSnapshot, scopeResolver = resolveWorksetScope }) {
  const fail = (reason) => ({ current: false, reason });
  if (!authorization?.scope) return fail("authorization scope is missing");
  const authorizedIds = authorization.scope.issueIds?.map(String) || [];
  if (authorization.scope.type !== "workset") {
    const current = scopeMaterial(config, authorizedIds);
    return current.revision === authorization.scope.revision
      ? { current: true }
      : fail("explicit issue scope or requirements changed; explicit renewal is required");
  }

  const name = authorization.scope.workset;
  const definition = config.worksets?.[name];
  if (!definition) return fail(`authorized workset '${name}' is no longer defined`);
  let saved;
  let live;
  try {
    saved = assertExecutableScope(await snapshotLoader(repoPath, name));
    live = assertExecutableScope(await scopeResolver(name, definition, { repository: config.repository, repoPath }));
  } catch (error) {
    return fail(`workset scope cannot be revalidated: ${error.message}`);
  }
  const sameIds = (value) => digest((value || []).map(String).sort()) === digest([...authorizedIds].sort());
  if (digest(saved.definition) !== digest(definition) || saved.revision !== authorization.scope.revision || !sameIds(saved.issueIds)) {
    return fail("saved workset scope changed; explicit renewal is required");
  }
  if (live.revision !== authorization.scope.revision || !sameIds(live.issueIds)) {
    return fail("current workset scope drifted; refresh the scope and explicitly renew authorization");
  }
  return { current: true, revision: live.revision };
}

function assessDelegatedAuthorization({ config, repoPath, state, issue, worker, validation, authorization, persistedAuthorization, statesById = null, scopeAssessment = null }) {
  const fail = (reason) => ({ eligible: false, reason });
  if (!authorization || authorization.kind !== "delegated") return fail("no delegated authorization is recorded");
  if (!persistedAuthorization || persistedAuthorization.id !== authorization.id) return fail("authorization provenance is missing");
  if (persistedAuthorization.status !== "active") return fail(`authorization is ${persistedAuthorization.status || "invalid"}`);
  if (digest(persistedAuthorization) !== digest(authorization)) return fail("the run authorization differs from the persisted authorization record");
  if (authorization.policyVersion !== EXECUTION_POLICY_VERSION) return fail("execution-policy version changed");
  if (authorization.repository !== config.repository) return fail("repository identity changed");
  if (authorization.repositoryRoot !== coordinatedRepoPath(repoPath)) return fail("repository checkout/session identity changed");
  if (authorization.targetBranch !== (config.defaultBranch || "main")) return fail("target branch changed");
  if (scopeAssessment && scopeAssessment.current !== true) return fail(scopeAssessment.reason || "authorized scope is stale");
  if (!authorization.scope?.issueIds?.map(String).includes(String(issue))) return fail("issue is outside the authorized scope");
  if (authorization.policyDigest !== digest(issuePolicy(config, authorization.scope.issueIds, authorization.limits))) return fail("protected execution policy, checks, capabilities, baseline policy, or operational limits changed");
  if (state.plan?.concurrency !== authorization.limits?.concurrency) return fail("run concurrency differs from the authorized operational limit");
  for (const attempt of Object.values(state.correction?.attempts || {})) {
    if (attempt.automatic === true && attempt.retryLimit !== authorization.limits?.correction?.retryLimit) {
      return fail("correction retry policy differs from the authorized operational limit");
    }
  }
  if (!authorization.allowedActions?.integrate || !authorization.allowedActions?.pushDefaultBranch) return fail("default-branch integration/push was not authorized");
  if (String(state.runId) !== authorization.runId && !lineageIncludes(statesById, state, authorization.lineageRootRunId)) return fail("run is outside the authorized session lineage");
  const requiredCapabilities = config.work?.[String(issue)]?.requires || [];
  for (const capability of requiredCapabilities) {
    const preflight = (state.preflights || []).find((entry) => entry.capability === capability);
    if (!preflight || !["passed", "available-no-command"].includes(preflight.status)) return fail(`required capability '${capability}' has no successful preflight evidence`);
  }
  const expectedBaseline = policyForBaseline(config);
  if (!state.baseline || digest({ commands: state.baseline.commands || [], allowFailing: state.baseline.allowFailing === true }) !== digest(expectedBaseline)) {
    return fail("baseline evidence is missing or does not match the protected baseline policy");
  }
  if ((state.baseline.results || []).length !== expectedBaseline.commands.length) return fail("baseline evidence is incomplete");
  if (state.baseline.passing !== true && state.baseline.allowFailing !== true) return fail("baseline failed without an authorized known-failure policy");
  if (!worker || worker.exitCode !== 0 || !worker.headSha || worker.headSha === worker.baseSha) return fail("worker result is not a current successful implementation");
  if (!validation || validation.exitCode !== 0 || validation.verdict !== "approve") return fail("independent validation is missing, invalid, or not approving");
  const expectedEvidence = validationContext(config, worker, issue);
  if (digest(validation.evidence || null) !== digest(expectedEvidence)) return fail("validation evidence is stale or bound to a different implementation/policy context");
  const assessment = { eligible: true, authorizationId: authorization.id, kind: "delegated", allowedActions: authorization.allowedActions };
  delegatedAssessments.add(assessment);
  return assessment;
}

function isDelegatedAssessment(value) {
  return Boolean(value && delegatedAssessments.has(value));
}

function policyForBaseline(config) {
  return {
    commands: config.baseline?.commands || config.integration?.commands || [],
    allowFailing: config.baseline?.allowFailing === true
  };
}

module.exports = {
  EXECUTION_POLICY_VERSION,
  DEFAULT_ACTIONS,
  digest,
  issuePolicy,
  normalizeLimits,
  scopeMaterial,
  createDelegatedAuthorization,
  saveAuthorization,
  loadAuthorization,
  revokeAuthorization,
  validationContext,
  bindValidation,
  assessCurrentScope,
  assessDelegatedAuthorization,
  isDelegatedAssessment
};

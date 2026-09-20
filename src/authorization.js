const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { coordinatedRepoPath, reportRootForRepo } = require("./reporter");

const EXECUTION_POLICY_VERSION = "delegated-integration-v1";
const DEFAULT_ACTIONS = Object.freeze({
  implement: true,
  correct: true,
  integrate: true,
  pushDefaultBranch: true,
  closeIssue: false,
  createFollowUp: false,
  admitFollowUp: false
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function issuePolicy(config, issueIds) {
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

function createDelegatedAuthorization({ config, repoPath, runId, issueIds, scope = null, invocation = process.argv, actor = availableActor(), now = new Date(), renews = null }) {
  if (!issueIds?.length) throw new Error("Delegated authorization requires at least one resolved issue.");
  const policy = issuePolicy(config, issueIds);
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
  const authorization = await loadAuthorization(repoPath, id);
  const revoked = {
    ...authorization,
    status: "revoked",
    revokedAt: now.toISOString(),
    revocation: { invocation: invocation.map(String), ...(actor ? { actor } : {}) }
  };
  await saveAuthorization(repoPath, revoked);
  return revoked;
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

function assessDelegatedAuthorization({ config, repoPath, state, issue, worker, validation, authorization, persistedAuthorization, statesById = null }) {
  const fail = (reason) => ({ eligible: false, reason });
  if (!authorization || authorization.kind !== "delegated") return fail("no delegated authorization is recorded");
  if (!persistedAuthorization || persistedAuthorization.id !== authorization.id) return fail("authorization provenance is missing");
  if (persistedAuthorization.status !== "active") return fail(`authorization is ${persistedAuthorization.status || "invalid"}`);
  if (digest(persistedAuthorization) !== digest(authorization)) return fail("the run authorization differs from the persisted authorization record");
  if (authorization.policyVersion !== EXECUTION_POLICY_VERSION) return fail("execution-policy version changed");
  if (authorization.repository !== config.repository) return fail("repository identity changed");
  if (authorization.repositoryRoot !== coordinatedRepoPath(repoPath)) return fail("repository checkout/session identity changed");
  if (authorization.targetBranch !== (config.defaultBranch || "main")) return fail("target branch changed");
  if (!authorization.scope?.issueIds?.map(String).includes(String(issue))) return fail("issue is outside the authorized scope");
  if (authorization.policyDigest !== digest(issuePolicy(config, authorization.scope.issueIds))) return fail("protected execution policy, checks, capabilities, or baseline policy changed");
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
  return { eligible: true, authorizationId: authorization.id, kind: "delegated", allowedActions: authorization.allowedActions };
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
  scopeMaterial,
  createDelegatedAuthorization,
  saveAuthorization,
  loadAuthorization,
  revokeAuthorization,
  validationContext,
  bindValidation,
  assessDelegatedAuthorization
};

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createDelegatedAuthorization,
  saveAuthorization,
  loadAuthorization,
  revokeAuthorization,
  bindValidation,
  assessDelegatedAuthorization
} = require("../src/authorization");
const { classifyRunItems } = require("../src/existing-run");
const { integrateApproved } = require("../src/integrator");

function config() {
  return {
    repository: "owner/repo",
    defaultBranch: "main",
    baseline: { commands: ["npm test"], allowFailing: false },
    capabilities: { node: { preflight: "node --version", required: true } },
    integration: { enabled: true, commands: ["npm test"], closeIssues: false },
    work: {
      "7": { status: "ready", requires: ["node"], github: { state: "OPEN", labels: [], blockedBy: [], updatedAt: "2026-09-20" } },
      "8": { status: "ready", requires: [] }
    }
  };
}

async function fixture(t) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-authorization-"));
  t.after(() => fs.rm(repoPath, { recursive: true, force: true }));
  const current = config();
  const authorization = createDelegatedAuthorization({
    config: current,
    repoPath,
    runId: "20260920010101-aaaaaa",
    issueIds: ["7"],
    invocation: ["maestro", "start", "7", "--delegate"],
    actor: { name: "reviewer", source: "test" }
  });
  await saveAuthorization(repoPath, authorization);
  const worker = { issue: "7", exitCode: 0, baseSha: "base", headSha: "head", branch: "worker/7", worktreePath: "/worker/7" };
  const validation = bindValidation(current, worker, { issue: "7", exitCode: 0, verdict: "approve", report: "VERDICT: APPROVE" });
  const state = {
    runId: authorization.runId,
    status: "awaiting-review",
    authorization,
    preflights: [{ capability: "node", status: "passed" }],
    baseline: { enabled: true, allowFailing: false, commands: ["npm test"], results: [{ command: "npm test", code: 0 }], passing: true },
    workers: [worker], validations: [validation], reviews: {}, integration: []
  };
  return { repoPath, config: current, authorization, worker, validation, state };
}

test("delegated authorization records real provenance and admits only matching current evidence", async (t) => {
  const value = await fixture(t);
  const persisted = await loadAuthorization(value.repoPath, value.authorization.id);
  const assessment = assessDelegatedAuthorization({
    ...value,
    issue: "7",
    persistedAuthorization: persisted,
    statesById: new Map([[value.state.runId, value.state]])
  });

  assert.equal(assessment.eligible, true);
  assert.equal(value.authorization.actor.name, "reviewer");
  assert.deepEqual(value.authorization.scope.issueIds, ["7"]);
  assert.equal(value.authorization.allowedActions.integrate, true);
  assert.equal(value.authorization.allowedActions.closeIssue, false);
  assert.deepEqual(classifyRunItems(value.state, { delegatedByIssue: new Map([["7", assessment]]) }).integrable.map((entry) => entry.issue), ["7"]);
});

test("scope, repository, lineage, validation freshness, policy tampering, and revocation fail closed", async (t) => {
  const value = await fixture(t);
  const persisted = await loadAuthorization(value.repoPath, value.authorization.id);
  const assess = (changes = {}) => assessDelegatedAuthorization({
    ...value,
    issue: "7",
    persistedAuthorization: persisted,
    statesById: new Map([[value.state.runId, value.state]]),
    ...changes
  });

  assert.match(assess({ issue: "8" }).reason, /outside/);
  assert.match(assess({ config: { ...value.config, repository: "other/repo" } }).reason, /repository identity/);
  assert.match(assess({ state: { ...value.state, runId: "unrelated" } }).reason, /lineage/);
  assert.match(assess({ worker: { ...value.worker, headSha: "edited" } }).reason, /stale|different/);
  assert.match(assess({ state: { ...value.state, preflights: [] } }).reason, /capability/);
  assert.match(assess({ state: { ...value.state, baseline: null } }).reason, /baseline/);
  assert.match(assess({ config: { ...value.config, baseline: { commands: ["npm test"], allowFailing: true } } }).reason, /policy|baseline/);

  const revoked = await revokeAuthorization(value.repoPath, value.authorization.id, { invocation: ["maestro", "revoke"], actor: null });
  assert.match(assess({ persistedAuthorization: revoked }).reason, /revoked/);
});

test("delegated mixed outcomes integrate the passing sibling without fabricating review for REWORK", async (t) => {
  const value = await fixture(t);
  const second = { issue: "8", exitCode: 0, baseSha: "base", headSha: "head-8" };
  const state = {
    ...value.state,
    workers: [value.worker, second],
    validations: [value.validation, bindValidation(value.config, second, { issue: "8", exitCode: 0, verdict: "rework" })]
  };
  const result = classifyRunItems(state, { delegatedByIssue: new Map([["7", { eligible: true, authorizationId: value.authorization.id }], ["8", { eligible: false, reason: "rework" }]]) });
  assert.deepEqual(result.integrable.map((entry) => entry.issue), ["7"]);
  assert.deepEqual(result.rework.map((entry) => entry.issue), ["8"]);
  assert.deepEqual(state.reviews, {});
});

test("delegated human gates and invalid validation stay excluded without blocking a passing sibling", async (t) => {
  const value = await fixture(t);
  const gatedWorker = { issue: "8", exitCode: 0, baseSha: "base", headSha: "gate" };
  const invalidWorker = { issue: "9", exitCode: 0, baseSha: "base", headSha: "invalid" };
  const state = {
    ...value.state,
    workers: [value.worker, gatedWorker, invalidWorker],
    validations: [
      value.validation,
      { issue: "8", exitCode: 0, verdict: "human_gate" },
      { issue: "9", exitCode: 1, verdict: "failed" }
    ]
  };
  const result = classifyRunItems(state, { delegatedByIssue: new Map([["7", { eligible: true, authorizationId: value.authorization.id }]]) });
  assert.deepEqual(result.integrable.map((entry) => entry.issue), ["7"]);
  assert.deepEqual(result.gated.map((entry) => entry.issue), ["8"]);
  assert.deepEqual(result.failed.map((entry) => entry.issue), ["9"]);
  assert.deepEqual(state.reviews, {});
});

test("the low-level integrator rejects validator approval without human or delegated authority", async () => {
  let invoked = false;
  await assert.rejects(integrateApproved({
    config: { integration: { enabled: true } },
    repoPath: "/target",
    workers: [{ issue: "7", exitCode: 0, headSha: "head", worktreePath: "/worker" }],
    validations: [{ issue: "7", exitCode: 0, verdict: "approve" }],
    runner: async () => { invoked = true; return { stdout: "" }; }
  }), /Validator approval alone/);
  assert.equal(invoked, false);
});

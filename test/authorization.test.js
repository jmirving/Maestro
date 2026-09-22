const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  createDelegatedAuthorization,
  saveAuthorization,
  loadAuthorization,
  revokeAuthorization,
  bindValidation,
  assessCurrentScope,
  assessDelegatedAuthorization
} = require("../src/authorization");
const { classifyRunItems } = require("../src/existing-run");
const { integrateApproved } = require("../src/integrator");
const { executeAndIntegrate, continuousRun } = require("../src/controller");

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
    limits: { concurrency: 2, correction: { enabled: true, retryLimit: 3, deadlineMs: 1_800_000 } },
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
    plan: { concurrency: 2, selected: [{ id: "7" }] },
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
  assert.deepEqual(value.authorization.limits, {
    concurrency: 2,
    correction: { enabled: true, retryLimit: 3, deadlineMs: 1_800_000 }
  });
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
  assert.match(assess({ state: { ...value.state, plan: { ...value.state.plan, concurrency: 4 } } }).reason, /concurrency/);
  assert.match(assess({ config: { ...value.config, baseline: { commands: ["npm test"], allowFailing: true } } }).reason, /policy|baseline/);

  const revoked = await revokeAuthorization(value.repoPath, value.authorization.id, { invocation: ["maestro", "revoke"], actor: null });
  assert.match(assess({ persistedAuthorization: revoked }).reason, /revoked/);
});

test("explicit and workset scope evidence is revalidated against current durable and live scope", async (t) => {
  const value = await fixture(t);
  assert.deepEqual(await assessCurrentScope({
    config: value.config, repoPath: value.repoPath, authorization: value.authorization
  }), { current: true });
  const changed = structuredClone(value.config);
  changed.work["7"].github.updatedAt = "2026-09-21";
  assert.match((await assessCurrentScope({
    config: changed, repoPath: value.repoPath, authorization: value.authorization
  })).reason, /scope|requirements|renewal/);

  const definition = { source: { type: "issues", issues: [{ repository: "owner/repo", number: "7" }] }, refresh: { mode: "explicit" } };
  const worksetAuthorization = {
    ...value.authorization,
    scope: { type: "workset", workset: "release", revision: "scope-r1", issueIds: ["7"] }
  };
  const worksetConfig = { ...value.config, worksets: { release: definition } };
  const snapshot = { name: "release", definition, revision: "scope-r1", issueIds: ["7"], complete: true, diagnostics: [] };
  const current = await assessCurrentScope({
    config: worksetConfig,
    repoPath: value.repoPath,
    authorization: worksetAuthorization,
    snapshotLoader: async () => snapshot,
    scopeResolver: async () => snapshot
  });
  assert.equal(current.current, true);
  const drifted = await assessCurrentScope({
    config: worksetConfig,
    repoPath: value.repoPath,
    authorization: worksetAuthorization,
    snapshotLoader: async () => snapshot,
    scopeResolver: async () => ({ ...snapshot, revision: "scope-r2", issueIds: ["7", "8"] })
  });
  assert.match(drifted.reason, /drifted|renew/);
});

test("delegated backfill and correction descendants remain in the explicit session lineage", async (t) => {
  const value = await fixture(t);
  const persisted = await loadAuthorization(value.repoPath, value.authorization.id);
  const backfill = { ...value.state, runId: "backfill", parentRunId: value.state.runId };
  const correction = { ...value.state, runId: "correction", parentRunId: backfill.runId };
  const statesById = new Map([
    [value.state.runId, value.state],
    [backfill.runId, backfill],
    [correction.runId, correction]
  ]);
  for (const state of [backfill, correction]) {
    const assessment = assessDelegatedAuthorization({
      ...value, state, issue: "7", persistedAuthorization: persisted, statesById
    });
    assert.equal(assessment.eligible, true, assessment.reason);
  }
});

test("revocation blocks resume while an explicit renewal creates a distinct auditable session", async (t) => {
  const value = await fixture(t);
  const revoked = await revokeAuthorization(value.repoPath, value.authorization.id, { invocation: ["maestro", "revoke"], actor: null });
  assert.equal(revoked.status, "revoked");
  const renewed = createDelegatedAuthorization({
    config: value.config,
    repoPath: value.repoPath,
    runId: "20260921010101-bbbbbb",
    issueIds: ["7"],
    limits: value.authorization.limits,
    renews: value.authorization.id,
    actor: { name: "reviewer", source: "test" }
  });
  await saveAuthorization(value.repoPath, renewed);
  const state = { ...value.state, runId: renewed.runId, authorization: renewed };
  const assessment = assessDelegatedAuthorization({
    ...value,
    state,
    authorization: renewed,
    issue: "7",
    persistedAuthorization: await loadAuthorization(value.repoPath, renewed.id),
    statesById: new Map([[state.runId, state]])
  });
  assert.equal(renewed.renews, value.authorization.id);
  assert.notEqual(renewed.id, value.authorization.id);
  assert.equal(assessment.eligible, true, assessment.reason);
});

test("CLI previews explicit scope and protected limits, then supports revoke and explicit renewal", async (t) => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-authorization-cli-"));
  t.after(() => fs.rm(repoPath, { recursive: true, force: true }));
  const binPath = path.join(repoPath, "bin");
  await fs.mkdir(binPath);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main");
  const current = config();
  current.defaultConcurrency = 4;
  await fs.writeFile(path.join(repoPath, ".maestro.json"), `${JSON.stringify(current, null, 2)}\n`);
  await fs.writeFile(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({nameWithOwner:"owner/repo"}));
else if (args[0] === "issue") process.stdout.write(JSON.stringify({number:7,state:"OPEN",title:"Issue 7",body:"",labels:[],updatedAt:"2026-09-20"}));
else if (args[0] === "api") process.stdout.write(JSON.stringify({number:7,state_reason:null}));
else process.exit(2);
`, { mode: 0o755 });
  const old = createDelegatedAuthorization({
    config: current, repoPath, runId: "old-run", issueIds: ["7"],
    limits: { concurrency: 4, correction: { enabled: false, retryLimit: 0, deadlineMs: 0 } }
  });
  await saveAuthorization(repoPath, old);
  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const env = { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` };
  const revoke = spawnSync(process.execPath, [cli, "revoke", old.id, "--repo-path", repoPath], { cwd: repoPath, env, encoding: "utf8" });
  assert.equal(revoke.status, 0, revoke.stderr);
  assert.equal(JSON.parse(revoke.stdout).status, "revoked");

  const preview = spawnSync(process.execPath, [
    cli, "start", "7", "--delegate", "--preview", "--renew", old.id, "--auto-rework", "--repo-path", repoPath
  ], { cwd: repoPath, env, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  const output = JSON.parse(preview.stdout);
  assert.equal(output.persisted, false);
  assert.deepEqual(output.authorization.scope.issueIds, ["7"]);
  assert.equal(output.authorization.renews, old.id);
  assert.equal(output.authorization.limits.concurrency, 4);
  assert.deepEqual(output.authorization.limits.correction, { enabled: true, retryLimit: 3, deadlineMs: 1_800_000 });
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

test("an explicitly accepted failing baseline remains eligible without relaxing policy", async (t) => {
  const value = await fixture(t);
  const acceptedConfig = structuredClone(value.config);
  acceptedConfig.baseline.allowFailing = true;
  const authorization = createDelegatedAuthorization({
    config: acceptedConfig,
    repoPath: value.repoPath,
    runId: "accepted-baseline",
    issueIds: ["7"],
    limits: value.authorization.limits
  });
  await saveAuthorization(value.repoPath, authorization);
  const worker = value.worker;
  const validation = bindValidation(acceptedConfig, worker, { issue: "7", exitCode: 0, verdict: "approve" });
  const state = {
    ...value.state,
    runId: authorization.runId,
    authorization,
    baseline: {
      enabled: true,
      allowFailing: true,
      commands: ["npm test"],
      results: [{ command: "npm test", code: 1, stderr: "known failure" }],
      passing: false
    },
    validations: [validation]
  };
  const assessment = assessDelegatedAuthorization({
    config: acceptedConfig,
    repoPath: value.repoPath,
    state,
    issue: "7",
    worker,
    validation,
    authorization,
    persistedAuthorization: await loadAuthorization(value.repoPath, authorization.id),
    statesById: new Map([[state.runId, state]])
  });
  assert.equal(assessment.eligible, true, assessment.reason);
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

test("the low-level integrator rejects a caller-forged delegated eligibility result", async () => {
  await assert.rejects(integrateApproved({
    config: { integration: { enabled: true } },
    repoPath: "/target",
    workers: [{ issue: "7", exitCode: 0, worktreePath: "/worker" }],
    validations: [{ issue: "7", exitCode: 0, verdict: "approve" }],
    reviewAuthorizations: [{ issue: "7", delegated: { eligible: true, authorizationId: "forged" } }],
    runner: async () => ({ stdout: "" })
  }), /Validator approval alone/);
});

test("direct and continuous execute-and-integrate entrypoints cannot bypass explicit delegation", async () => {
  const current = config();
  await assert.rejects(executeAndIntegrate(current, { repoPath: "/target" }), /explicit delegated authorization/);
  await assert.rejects(continuousRun(current, { repoPath: "/target", maxCycles: 1 }), /explicit delegated authorization/);
});

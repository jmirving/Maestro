const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDelegatedAuthorization, saveAuthorization } = require("../src/authorization");
const {
  createSession,
  resolveSession,
  verifySessionContext,
  driveSession,
  requestSessionState
} = require("../src/autonomous-controller");
const { loadSession, saveSession, claimSession, releaseSession } = require("../src/session-store");
const { driveAutonomous } = require("../bin/maestro");

async function fixture(t, issueIds = ["1", "2"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-session-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    repository: "example/repo",
    defaultBranch: "main",
    integration: { enabled: true },
    work: Object.fromEntries(issueIds.map((id) => [id, { status: "ready" }]))
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(config, null, 2)}\n`);
  const scope = { type: "issues", issueIds, revision: "scope-revision" };
  const authorization = createDelegatedAuthorization({
    config,
    repoPath,
    runId: "session-root",
    issueIds,
    scope,
    limits: { concurrency: 2, correction: { enabled: true, retryLimit: 3, deadlineMs: 60_000 } },
    invocation: ["maestro", "start", ...issueIds, "--delegate", "--continuous"]
  });
  await saveAuthorization(repoPath, authorization);
  const session = await createSession({
    config,
    repoPath,
    manifestPath,
    scope,
    authorization,
    settings: { concurrency: 2, correction: authorization.limits.correction }
  });
  return { config, repoPath, manifestPath, scope, authorization, session };
}

test("a durable session drives several waves and preserves run, attempt, recovery, and integration lineage", async (t) => {
  const context = await fixture(t);
  let observation = 0;
  const result = await driveSession({
    ...context,
    observe: async () => {
      observation += 1;
      if (observation === 1) return { readyIssueIds: ["1"], unresolved: [{ issue: "2", reason: "blocked by #1" }] };
      if (observation === 2) return { readyIssueIds: ["2"], unresolved: [] };
      return { verifiedComplete: true, readyIssueIds: [], remainingIssueIds: [] };
    },
    advance: async ({ observation: current }) => current.readyIssueIds[0] === "1"
      ? { runIds: ["run-1", "rework-1"], recoveryRunIds: ["rework-1"], issueAttempts: { "1": 2 }, integratedIssueIds: ["1"], progressed: true }
      : { runIds: ["run-2"], issueAttempts: { "2": 1 }, integratedIssueIds: ["2"], progressed: true }
  });

  assert.equal(result.status, "complete");
  assert.equal(result.stopReason, "verified-complete");
  assert.deepEqual(result.lineage.runIds, ["run-1", "rework-1", "run-2"]);
  assert.deepEqual(result.lineage.issueAttempts, { "1": 2, "2": 1 });
  assert.deepEqual(result.lineage.recoveryRunIds, ["rework-1"]);
  assert.deepEqual(result.progress.integratedIssueIds, ["1", "2"]);
  assert.equal(result.terminal.verifiedComplete, true);
  assert.equal(result.owner, undefined);
  assert.ok(result.checkpoints.some((entry) => entry.kind === "advance-intent"));
  assert.ok(result.checkpoints.some((entry) => entry.kind === "advance-result"));
});

test("quiescence reports unresolved work and never claims completion", async (t) => {
  const context = await fixture(t);
  const result = await driveSession({
    ...context,
    observe: async () => ({
      readyIssueIds: [],
      unresolved: [{ issue: "2", reason: "human gate", nextAction: "maestro details 2" }],
      stopReason: "human-gate"
    }),
    advance: async () => { throw new Error("must not advance"); }
  });
  assert.equal(result.status, "quiescent");
  assert.equal(result.stopReason, "human-gate");
  assert.equal(result.terminal.verifiedComplete, false);
  assert.deepEqual(result.terminal.remainingIssueIds, ["2"]);
  assert.equal(result.terminal.unresolved[0].nextAction, "maestro details 2");
});

test("live ownership excludes a competing controller and orphaned ownership is reclaimed", async (t) => {
  const { repoPath, session } = await fixture(t);
  const first = await claimSession(repoPath, session.id, { pid: 123, kill: () => {} });
  await assert.rejects(claimSession(repoPath, session.id, { pid: 456, kill: () => {} }), /owned by live process 123/);
  await releaseSession(repoPath, session.id, first.token, { status: "paused", stopReason: "test" });

  const second = await claimSession(repoPath, session.id, { pid: 789, kill: () => { const error = new Error("gone"); error.code = "ESRCH"; throw error; } });
  assert.equal(second.session.owner.pid, 789);
  assert.ok(second.session.ownershipHistory.some((entry) => entry.pid === 123));
  await releaseSession(repoPath, session.id, second.token, { status: "paused", stopReason: "test" });
});

test("resume is scope-oriented, ambiguity is explicit, and policy drift fails closed", async (t) => {
  const context = await fixture(t);
  assert.equal((await resolveSession(context.repoPath, { issue: "1" })).id, context.session.id);
  await assert.rejects(resolveSession(context.repoPath, {}), /will not guess the latest session/);

  const secondAuthorization = { ...context.authorization, id: `${context.authorization.id}-second`, runId: "other", lineageRootRunId: "other" };
  await saveAuthorization(context.repoPath, secondAuthorization);
  await createSession({
    ...context,
    id: "session-second",
    authorization: secondAuthorization,
    settings: { concurrency: 2, correction: secondAuthorization.limits.correction }
  });
  await assert.rejects(resolveSession(context.repoPath, { issue: "1" }), /More than one resumable/);

  const loaded = await loadSession(context.repoPath, context.session.id);
  const changedConfig = { ...context.config, repository: "other/repo" };
  await assert.rejects(verifySessionContext({ ...context, config: changedConfig, session: loaded }), /repository identity changed/);
});

test("pause and stop requests preserve evidence and are observed at checkpoints", async (t) => {
  const context = await fixture(t);
  await requestSessionState(context.repoPath, context.session, "pause");
  const paused = await loadSession(context.repoPath, context.session.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.stopReason, "user-paused");
  assert.deepEqual(paused.lineage.runIds, []);

  const result = await driveSession({
    ...context,
    session: paused,
    observe: async (active) => {
      await requestSessionState(context.repoPath, active, "stop");
      return { readyIssueIds: ["1"] };
    },
    advance: async () => { throw new Error("stop must be honored before another mutable transition"); }
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "user-stopped");
});

test("autonomous reservation reloads the manifest and drift prevents any further mutation", async (t) => {
  const context = await fixture(t, ["1"]);
  let reserved = false;
  let integrated = false;
  let injected = false;

  await assert.rejects(driveAutonomous(context, {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => {
      if (!injected) {
        injected = true;
        const changed = structuredClone(context.config);
        changed.work["1"].humanGate = "security-owner approval";
        await fs.writeFile(context.manifestPath, `${JSON.stringify(changed, null, 2)}\n`);
      }
      return { selected: [{ id: "1" }], humanGates: [], blocked: [], deferred: [] };
    },
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => [],
    reserveReadyWork: async () => { reserved = true; throw new Error("must not reserve"); },
    integrateExistingRun: async () => { integrated = true; throw new Error("must not integrate"); }
  }), (error) => error.code === "SESSION_CONTEXT_DRIFT" && /human gates.*reservation/.test(error.message));

  assert.equal(reserved, false);
  assert.equal(integrated, false);
  const persisted = await loadSession(context.repoPath, context.session.id);
  assert.equal(persisted.stopReason, "SESSION_CONTEXT_DRIFT");
});

test("resumed validation REWORK enters bounded correction, approval, and integration with the original deadline", async (t) => {
  const context = await fixture(t, ["1"]);
  const session = await loadSession(context.repoPath, context.session.id);
  session.startedAt = new Date(Date.now() - 20_000).toISOString();
  session.lineage.runIds = [context.authorization.runId];
  await saveSession(context.repoPath, session);

  const source = {
    runId: context.authorization.runId,
    mode: "autonomous",
    status: "running",
    authorization: context.authorization,
    plan: { concurrency: 2, selected: [{ id: "1", status: "ready" }] },
    operations: { "1": { stage: "validation", processId: 999999 } },
    workers: [{ issue: "1", exitCode: 0, baseSha: "base", headSha: "implementation" }],
    validations: [],
    reviews: {},
    integration: []
  };
  const correctionRunId = "correction-approved";
  let executionCalls = 0;
  let correctedIntegrated = false;
  let correctionOptions = null;
  const integrationCalls = [];

  const result = await driveAutonomous({ ...context, session }, {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => correctedIntegrated ? [] : [source],
    loadRunState: async () => source,
    processIsRunning: () => false,
    executeRun: async (_config, options) => {
      executionCalls += 1;
      assert.ok(options.reservedState.operations["1"].resumedAt);
      source.status = "awaiting-review";
      source.operations["1"].stage = "complete";
      source.validations = [{ issue: "1", exitCode: 0, verdict: "rework", report: "correct this" }];
      return source;
    },
    autoRework: async (_config, options) => {
      correctionOptions = options;
      const reloaded = await options.configResolver({ issue: "1", runId: correctionRunId, sourceRunId: source.runId });
      assert.equal(reloaded.work["1"].status, "ready");
      return {
        issues: [{
          issue: "1",
          outcome: "approved",
          attemptsUsed: 1,
          finalRunId: correctionRunId,
          runs: [{ runId: correctionRunId }]
        }]
      };
    },
    integrateExistingRun: async (_config, options) => {
      integrationCalls.push(options.runId);
      if (options.runId === correctionRunId) {
        correctedIntegrated = true;
        return { integration: [{ issue: "1", integratedSha: "integrated" }] };
      }
      return { integration: [] };
    },
    persistManifestCompletionDurably: async () => ({ changed: [], committed: false })
  });

  assert.equal(executionCalls, 1);
  assert.deepEqual(integrationCalls, [source.runId, correctionRunId]);
  assert.deepEqual(result.progress.integratedIssueIds, ["1"]);
  assert.ok(result.lineage.runIds.includes(correctionRunId));
  assert.equal(result.lineage.issueAttempts["1"], 1);
  assert.equal(correctionOptions.retryLimit, context.authorization.limits.correction.retryLimit);
  assert.ok(correctionOptions.timeoutMs <= 45_000 && correctionOptions.timeoutMs > 30_000);
  assert.equal(correctionOptions.deadlineAt, Date.parse(session.startedAt) + context.authorization.limits.correction.deadlineMs);
});

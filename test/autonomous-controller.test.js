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
const { loadSession, claimSession, releaseSession } = require("../src/session-store");

async function fixture(t, issueIds = ["1", "2"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-session-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  await fs.writeFile(manifestPath, "{}\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    repository: "example/repo",
    defaultBranch: "main",
    integration: { enabled: true },
    work: Object.fromEntries(issueIds.map((id) => [id, { status: "ready" }]))
  };
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

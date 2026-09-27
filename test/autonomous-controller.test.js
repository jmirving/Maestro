const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createDelegatedAuthorization, saveAuthorization, bindValidation } = require("../src/authorization");
const {
  createSession,
  resolveSession,
  verifySessionContext,
  driveSession,
  requestSessionState
} = require("../src/autonomous-controller");
const { loadSession, saveSession, claimSession, releaseSession, processStartTime } = require("../src/session-store");
const { summarizeSession } = require("../src/session-view");
const { autoRework } = require("../src/rework");
const { integrateExistingRun } = require("../src/existing-run");
const { loadRunState, saveRunState, loadPersistedRunStates } = require("../src/run-store");
const { driveAutonomous } = require("../bin/maestro");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

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

test("ownership verifies process start time so a reused PID is reclaimed", async (t) => {
  const { repoPath, session } = await fixture(t);
  const identities = new Map([[123, "start-a"], [456, "start-c"]]);
  const processIdentity = async (pid) => identities.get(pid) || null;
  await claimSession(repoPath, session.id, { pid: 123, kill: () => {}, processIdentity });
  await assert.rejects(
    claimSession(repoPath, session.id, { pid: 456, kill: () => {}, processIdentity }),
    /owned by live process 123/
  );

  identities.set(123, "start-b");
  const second = await claimSession(repoPath, session.id, { pid: 456, kill: () => {}, processIdentity });
  assert.equal(second.session.owner.pid, 456);
  assert.equal(second.session.owner.processStartTime, "start-c");
  assert.ok(second.session.ownershipHistory.some((entry) => (
    entry.pid === 123 && entry.processStartTime === "start-a" && entry.reason === "orphaned"
  )));
  await releaseSession(repoPath, session.id, second.token, { status: "paused", stopReason: "test" });
});

test("ownership reclaims a stale PID while preserving its identity history", async (t) => {
  const { repoPath, session } = await fixture(t);
  const processIdentity = async (pid) => ({ 123: "start-a", 456: "start-b" })[pid] || null;
  await claimSession(repoPath, session.id, { pid: 123, kill: () => {}, processIdentity });

  const reclaimed = await claimSession(repoPath, session.id, {
    pid: 456,
    kill: (pid) => {
      if (pid === 123) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    },
    processIdentity
  });

  assert.equal(reclaimed.session.owner.pid, 456);
  assert.ok(reclaimed.session.ownershipHistory.some((entry) => (
    entry.pid === 123 && entry.processStartTime === "start-a" && entry.reason === "orphaned"
  )));
  await releaseSession(repoPath, session.id, reclaimed.token, { status: "paused", stopReason: "test" });
});

for (const budget of ["max-cycles", "max-runtime", "no-progress-limit"]) {
  test(`resume cannot execute again after the persisted ${budget} budget is exhausted`, async (t) => {
    const context = await fixture(t, ["1"]);
    const session = await loadSession(context.repoPath, context.session.id);
    const currentTime = new Date("2026-09-27T12:00:00.000Z");
    if (budget === "max-cycles") session.cycles = session.settings.limits.maxCycles;
    if (budget === "max-runtime") {
      session.startedAt = new Date(currentTime.getTime() - session.settings.limits.maxRuntimeMs).toISOString();
    }
    if (budget === "no-progress-limit") {
      session.progress.noProgressCycles = session.settings.limits.maxNoProgressCycles;
    }
    session.status = "quiescent";
    session.stopReason = budget;
    await saveSession(context.repoPath, session);

    let observations = 0;
    let advances = 0;
    const result = await driveSession({
      ...context,
      session: await loadSession(context.repoPath, session.id),
      now: () => currentTime,
      observe: async () => { observations += 1; return { readyIssueIds: ["1"] }; },
      advance: async () => { advances += 1; return { progressed: true }; }
    });

    assert.equal(observations, 0);
    assert.equal(advances, 0);
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, budget);
    assert.equal(
      result.terminal.nextAction,
      `maestro start 1 --delegate --continuous --renew ${context.authorization.id}`
    );
    assert.equal(summarizeSession(result).nextAction, result.terminal.nextAction);
    await assert.rejects(claimSession(context.repoPath, session.id), /is stopped and cannot be resumed/);
  });
}

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

test("production resume wiring blocks a matching live child", async (t) => {
  const context = await fixture(t, ["1"]);
  const session = await loadSession(context.repoPath, context.session.id);
  session.lineage.runIds = [context.authorization.runId];
  await saveSession(context.repoPath, session);

  const source = {
    runId: context.authorization.runId,
    mode: "autonomous",
    status: "running",
    authorization: context.authorization,
    autonomousSessionId: session.id,
    plan: { concurrency: 1, selected: [{ id: "1", status: "ready" }] },
    operations: {
      "1": {
        stage: "worker",
        processId: process.pid,
        processStartTime: await processStartTime(process.pid)
      }
    },
    workers: [], validations: [], reviews: {}, integration: []
  };
  let executionCalls = 0;

  await assert.rejects(driveAutonomous({ ...context, session }, {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => [source],
    loadRunState: async () => source,
    executeRun: async () => { executionCalls += 1; },
    persistManifestCompletionDurably: async () => ({ changed: [], committed: false })
  }), (error) => error.code === "SESSION_OPERATION_RUNNING" && error.message.includes(String(process.pid)));

  assert.equal(executionCalls, 0, "a matching live child must never be duplicated");
});

test("production resume wiring verifies child identity and reclaims a reused PID", async (t) => {
  const context = await fixture(t, ["1"]);
  const session = await loadSession(context.repoPath, context.session.id);
  session.lineage.runIds = [context.authorization.runId];
  await saveSession(context.repoPath, session);

  const source = {
    runId: context.authorization.runId,
    mode: "autonomous",
    status: "running",
    authorization: context.authorization,
    autonomousSessionId: session.id,
    plan: { concurrency: 1, selected: [{ id: "1", status: "ready" }] },
    operations: { "1": { stage: "worker", processId: process.pid, processStartTime: "stale-boot:original" } },
    workers: [],
    validations: [],
    reviews: {},
    integration: []
  };
  let executionCalls = 0;

  const result = await driveAutonomous({ ...context, session }, {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => source.integration.length ? [] : [source],
    loadRunState: async () => source,
    executeRun: async (_config, options) => {
      executionCalls += 1;
      assert.ok(options.reservedState.operations["1"].resumedAt);
      source.status = "awaiting-review";
      source.operations["1"].stage = "complete";
      source.workers = [{ issue: "1", exitCode: 0, baseSha: "base", headSha: "implementation" }];
      source.validations = [{ issue: "1", exitCode: 0, verdict: "approve" }];
      return source;
    },
    integrateExistingRun: async () => {
      source.integration = [{ issue: "1", integratedSha: "integrated" }];
      return { integration: source.integration };
    },
    persistManifestCompletionDurably: async () => ({ changed: ["1"], committed: true })
  });

  assert.equal(executionCalls, 1, "a reused PID must not be mistaken for the interrupted child");
  assert.deepEqual(result.progress.integratedIssueIds, ["1"]);
});

test("resume fails closed for a live child without persisted process identity", async (t) => {
  const context = await fixture(t, ["1"]);
  const source = {
    runId: context.authorization.runId,
    mode: "autonomous",
    status: "running",
    authorization: context.authorization,
    autonomousSessionId: context.session.id,
    plan: { concurrency: 1, selected: [{ id: "1", status: "ready" }] },
    operations: { "1": { stage: "validation", processId: 654 } },
    workers: [{ issue: "1", exitCode: 0, baseSha: "base", headSha: "implementation" }],
    validations: [], reviews: {}, integration: []
  };
  let executionCalls = 0;

  await assert.rejects(driveAutonomous(context, {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => [source],
    loadRunState: async () => source,
    processIsRunning: () => true,
    executeRun: async () => { executionCalls += 1; },
    persistManifestCompletionDurably: async () => ({ changed: [], committed: false })
  }), (error) => error.code === "SESSION_OPERATION_IDENTITY_UNAVAILABLE");

  assert.equal(executionCalls, 0);
});

test("resume before the first lineage checkpoint consumes the root run and executes the next wave once", async (t) => {
  const context = await fixture(t, ["1", "2"]);
  const states = [];
  const reservations = [];
  const integrationCalls = [];
  let interruptAfterFirstIntegration = true;
  let childRunIds = 0;

  const services = {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => {
      const integrated = new Set(states.flatMap((state) => (state.integration || []).map((entry) => String(entry.issue))));
      const selected = !integrated.has("1") ? [{ id: "1" }] : !integrated.has("2") ? [{ id: "2" }] : [];
      return { selected, humanGates: [], blocked: [], deferred: [] };
    },
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => states,
    loadRunState: async (_repoPath, runId) => states.find((state) => state.runId === runId),
    newRunId: () => {
      childRunIds += 1;
      return "second-wave";
    },
    reserveReadyWork: async (_config, options) => {
      if (states.some((state) => state.runId === options.runId)) {
        const error = new Error(`duplicate run ${options.runId}`);
        error.code = "RUN_STATE_CONFLICT";
        throw error;
      }
      const issue = states.some((state) => (state.integration || []).some((entry) => String(entry.issue) === "1")) ? "2" : "1";
      const state = {
        runId: options.runId,
        mode: "autonomous",
        status: "running",
        authorization: context.authorization,
        autonomousSessionId: context.session.id,
        ...(options.runId === context.authorization.runId ? {} : { parentRunId: context.authorization.runId }),
        plan: { concurrency: 1, selected: [{ id: issue }] },
        workers: [], validations: [], reviews: {}, integration: []
      };
      states.push(state);
      reservations.push(options.runId);
      return { reserved: true, state, plan: state.plan };
    },
    executeRun: async (_config, options) => {
      const state = options.reservedState;
      const issue = String(state.plan.selected[0].id);
      state.status = "awaiting-review";
      state.workers = [{ issue, exitCode: 0, baseSha: `base-${issue}`, headSha: `head-${issue}` }];
      state.validations = [{ issue, exitCode: 0, verdict: "approve" }];
      return state;
    },
    integrateExistingRun: async (_config, options) => {
      const state = states.find((entry) => entry.runId === options.runId);
      integrationCalls.push(options.runId);
      if (!state.integration.length) {
        const issue = String(state.plan.selected[0].id);
        state.integration = [{ issue, integratedSha: `integrated-${issue}` }];
        state.status = "integrated";
      }
      if (options.runId === context.authorization.runId && interruptAfterFirstIntegration) {
        interruptAfterFirstIntegration = false;
        const error = new Error("fault before first advance-result");
        error.code = "FAULT_BEFORE_FIRST_LINEAGE_CHECKPOINT";
        throw error;
      }
      return { integration: state.integration };
    },
    persistManifestCompletionDurably: async ({ issueIds }) => ({ changed: issueIds, committed: true })
  };

  await assert.rejects(
    driveAutonomous(context, services),
    (error) => error.code === "FAULT_BEFORE_FIRST_LINEAGE_CHECKPOINT"
  );
  const interrupted = await loadSession(context.repoPath, context.session.id);
  assert.deepEqual(interrupted.lineage.runIds, [], "the injected fault must precede the first advance-result checkpoint");
  assert.deepEqual(reservations, [context.authorization.runId]);

  const resumed = await driveAutonomous({ ...context, session: interrupted }, services);

  assert.deepEqual(reservations, [context.authorization.runId, "second-wave"]);
  assert.equal(childRunIds, 1);
  assert.deepEqual(integrationCalls, [context.authorization.runId, context.authorization.runId, "second-wave"]);
  assert.deepEqual(resumed.lineage.runIds, [context.authorization.runId, "second-wave"]);
  assert.deepEqual(resumed.progress.integratedIssueIds, ["1", "2"]);
});

test("real autonomous rework classification preserves delegated lineage and resumes the same approved child", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-autonomous-rework-lineage-"));
  const repoPath = path.join(root, "target");
  const originPath = path.join(root, "origin.git");
  const workerPath = path.join(root, "worker-1");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.com");
  const config = {
    repository: "example/repo",
    defaultBranch: "main",
    defaultConcurrency: 1,
    integration: { enabled: true, commands: [], postMergeCommands: [], closeIssues: false },
    work: { "1": { status: "ready" } }
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(config, null, 2)}\n`);
  await fs.writeFile(path.join(repoPath, "implementation.txt"), "base\n");
  git(repoPath, "add", ".maestro.json", "implementation.txt");
  git(repoPath, "commit", "-qm", "base");
  git(root, "clone", "-q", "--bare", repoPath, originPath);
  git(repoPath, "remote", "add", "origin", originPath);
  git(repoPath, "fetch", "-q", "origin", "main");
  git(repoPath, "worktree", "add", "-q", "-b", "maestro/1", workerPath, "main");
  await fs.writeFile(path.join(workerPath, "implementation.txt"), "initial implementation\n");
  git(workerPath, "add", "implementation.txt");
  git(workerPath, "commit", "-qm", "initial implementation");

  const sourceRunId = "20260927122500-aabbcc";
  const scope = { type: "issues", issueIds: ["1"], revision: "scope-revision" };
  const authorization = createDelegatedAuthorization({
    config,
    repoPath,
    runId: sourceRunId,
    issueIds: ["1"],
    scope,
    limits: { concurrency: 1, correction: { enabled: true, retryLimit: 3, deadlineMs: 60_000 } },
    invocation: ["maestro", "start", "1", "--delegate", "--continuous"]
  });
  await saveAuthorization(repoPath, authorization);
  const session = await createSession({
    config,
    repoPath,
    manifestPath,
    scope,
    authorization,
    settings: { concurrency: 1, correction: authorization.limits.correction }
  });
  const initialWorker = {
    issue: "1",
    exitCode: 0,
    baseSha: git(repoPath, "rev-parse", "main"),
    headSha: git(workerPath, "rev-parse", "HEAD"),
    branch: "maestro/1",
    worktreePath: workerPath,
    report: "initial implementation"
  };
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    mode: "autonomous",
    status: "awaiting-review",
    authorization,
    autonomousSessionId: session.id,
    plan: { concurrency: 1, selected: [{ id: "1", status: "ready" }] },
    baseline: { enabled: false, allowFailing: false, commands: [], results: [], passing: true },
    preflights: [],
    workers: [initialWorker],
    validations: [bindValidation(config, initialWorker, {
      issue: "1", exitCode: 0, verdict: "rework", report: "VERDICT: REWORK\ncorrect it"
    }, { scopeRevision: scope.revision })],
    reviews: {},
    integration: []
  });

  let correctionRunId = null;
  let interruptCorrectionIntegration = true;
  const services = {
    assessCurrentScope: async () => ({ current: true, revision: scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    autoRework: (currentConfig, options) => autoRework(currentConfig, {
      ...options,
      reworkOptions: {
        ...options.reworkOptions,
        workerExecutor: async ({ item, worktree, runId }) => {
          correctionRunId = runId;
          await fs.writeFile(path.join(worktree.worktreePath, "implementation.txt"), "corrected implementation\n");
          git(worktree.worktreePath, "add", "implementation.txt");
          git(worktree.worktreePath, "commit", "-qm", "correct implementation");
          return {
            issue: item.id,
            exitCode: 0,
            baseSha: worktree.baseSha,
            headSha: git(worktree.worktreePath, "rev-parse", "HEAD"),
            branch: worktree.branch,
            worktreePath: worktree.worktreePath,
            report: "corrected implementation"
          };
        },
        validatorExecutor: async ({ worker }) => ({
          issue: worker.issue, exitCode: 0, verdict: "approve", report: "VERDICT: APPROVE"
        })
      }
    }),
    integrateExistingRun: async (currentConfig, options) => {
      const state = await loadRunState(repoPath, options.runId);
      if (state.mode === "rework" && interruptCorrectionIntegration) {
        interruptCorrectionIntegration = false;
        const error = new Error("fault before corrected-child integration");
        error.code = "FAULT_BEFORE_CORRECTION_INTEGRATION";
        throw error;
      }
      return integrateExistingRun(currentConfig, {
        ...options,
        scopeAssessmentOptions: {
          explicitScopeResolver: async () => ({ type: "issues", issueIds: ["1"], revision: scope.revision })
        }
      });
    },
    persistManifestCompletionDurably: async () => ({ changed: ["1"], committed: true })
  };

  await assert.rejects(
    driveAutonomous({ config, repoPath, manifestPath, session }, services),
    (error) => error.code === "FAULT_BEFORE_CORRECTION_INTEGRATION"
  );
  assert.ok(correctionRunId);
  const interruptedChild = await loadRunState(repoPath, correctionRunId);
  assert.equal(interruptedChild.authorization.id, authorization.id);
  assert.equal(interruptedChild.autonomousSessionId, session.id);
  assert.equal(interruptedChild.correction.attempts["1"].number, 1);
  assert.equal(interruptedChild.validations[0].evidence.issueFactsRevision, scope.revision);

  const resumed = await driveAutonomous({
    config,
    repoPath,
    manifestPath,
    session: await loadSession(repoPath, session.id)
  }, services);
  const correctionChildren = (await loadPersistedRunStates(repoPath))
    .filter((state) => state.mode === "rework");
  const integratedChild = await loadRunState(repoPath, correctionRunId);

  assert.equal(correctionChildren.length, 1, "resume must not create a duplicate correction child");
  assert.equal(integratedChild.correction.attempts["1"].number, 1, "resume must not recharge the attempt");
  assert.deepEqual(integratedChild.integration.map((entry) => String(entry.issue)), ["1"]);
  assert.deepEqual(resumed.progress.integratedIssueIds, ["1"]);
  assert.equal(resumed.lineage.issueAttempts["1"], 1, "resume must retain the charged attempt in session lineage");
  assert.ok(resumed.lineage.recoveryRunIds.includes(correctionRunId));
  assert.equal(git(repoPath, "rev-parse", "HEAD"), git(workerPath, "rev-parse", "HEAD"));
});

test("integration-check correction survives interruption and only the approved session-owned child integrates", async (t) => {
  const context = await fixture(t, ["1"]);
  const session = await loadSession(context.repoPath, context.session.id);
  session.startedAt = new Date(Date.now() - 10_000).toISOString();
  session.lineage.runIds = [context.authorization.runId];
  await saveSession(context.repoPath, session);

  const deadlineAt = Date.parse(session.startedAt) + context.authorization.limits.correction.deadlineMs;
  const source = {
    runId: context.authorization.runId,
    mode: "autonomous",
    status: "integration-regression",
    authorization: context.authorization,
    autonomousSessionId: session.id,
    plan: { concurrency: 2, selected: [{ id: "1", status: "ready" }] },
    baseline: { enabled: true, passing: true, allowFailing: false, commands: [], results: [] },
    preflights: [],
    workers: [{ issue: "1", exitCode: 0, baseSha: "base", headSha: "original" }],
    validations: [{ issue: "1", exitCode: 0, verdict: "approve" }],
    reviews: {},
    integration: []
  };
  const correctionRunId = "integration-correction-approved";
  const states = [source];
  const integrationCalls = [];
  let child = null;

  const services = {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => states,
    loadRunState: async (_repoPath, runId) => states.find((state) => state.runId === runId),
    integrateExistingRun: async (_config, options) => {
      integrationCalls.push(options.runId);
      assert.equal(options.integrationCorrectionOptions.recoveryDeadlineAt, deadlineAt);
      assert.equal(options.integrationCorrectionOptions.recoveryAttemptLimit, context.authorization.limits.correction.retryLimit);
      if (options.runId === source.runId) {
        child = {
          runId: correctionRunId,
          parentRunId: source.runId,
          mode: "integration-correction",
          status: "awaiting-review",
          authorization: context.authorization,
          autonomousSessionId: session.id,
          plan: { concurrency: 2, selected: [{ id: "1", mode: "integration-correction" }] },
          baseline: source.baseline,
          preflights: source.preflights,
          workers: [{ issue: "1", exitCode: 0, baseSha: "target", headSha: "corrected" }],
          validations: [{ issue: "1", exitCode: 0, verdict: "approve" }],
          reviews: {},
          integration: [],
          integrationCorrection: {
            issue: "1",
            deadlineAt,
            attempts: [{ number: 1, status: "completed", outcome: "approve", chargedAt: "before-interruption" }]
          }
        };
        states.push(child);
        const error = new Error("fault after correction child was durably approved");
        error.code = "FAULT_AFTER_CORRECTION";
        throw error;
      }
      assert.equal(options.runId, correctionRunId, "resume must integrate the corrected child");
      child.integration = [{ issue: "1", integratedSha: "integrated-corrected" }];
      child.status = "integrated";
      return { integration: child.integration, newlyIntegrated: child.integration };
    },
    persistManifestCompletionDurably: async () => ({ changed: ["1"], committed: true })
  };

  await assert.rejects(
    driveAutonomous({ ...context, session }, services),
    (error) => error.code === "FAULT_AFTER_CORRECTION"
  );
  const interruptedDeadline = child.integrationCorrection.deadlineAt;
  const interruptedAttempts = structuredClone(child.integrationCorrection.attempts);

  const resumedSession = await loadSession(context.repoPath, session.id);
  const result = await driveAutonomous({ ...context, session: resumedSession }, services);

  assert.deepEqual(integrationCalls, [source.runId, correctionRunId]);
  assert.deepEqual(source.integration, [], "the original implementation must never be reintegrated");
  assert.deepEqual(child.integration, [{ issue: "1", integratedSha: "integrated-corrected" }]);
  assert.equal(child.integrationCorrection.deadlineAt, interruptedDeadline);
  assert.deepEqual(child.integrationCorrection.attempts, interruptedAttempts);
  assert.ok(result.lineage.runIds.includes(correctionRunId));
  assert.ok(result.lineage.recoveryRunIds.includes(correctionRunId));
  assert.equal(result.lineage.issueAttempts["1"], 1);
  assert.deepEqual(result.progress.integratedIssueIds, ["1"]);
});

test("manifest publication retains ownership, rejects concurrent resume, and publishes exactly once across pause and resume", async (t) => {
  const context = await fixture(t, ["1"]);
  const source = {
    runId: context.authorization.runId,
    mode: "autonomous",
    status: "awaiting-review",
    authorization: context.authorization,
    autonomousSessionId: context.session.id,
    plan: { concurrency: 2, selected: [{ id: "1", status: "ready" }] },
    workers: [{ issue: "1", exitCode: 0, baseSha: "base", headSha: "implementation" }],
    validations: [{ issue: "1", exitCode: 0, verdict: "approve" }],
    reviews: {},
    integration: []
  };
  let integrationCalls = 0;
  let publicationCalls = 0;
  let manifestPublications = 0;
  let publicationCheckpoint = null;
  const services = {
    assessCurrentScope: async () => ({ current: true, revision: context.scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => [source],
    loadRunState: async () => source,
    integrateExistingRun: async () => {
      integrationCalls += 1;
      source.integration = [{ issue: "1", integratedSha: "integrated" }];
      source.status = "integrated";
      return { integration: source.integration, newlyIntegrated: source.integration };
    },
    persistManifestCompletionDurably: async ({ checkpoint, onCheckpoint }) => {
      publicationCalls += 1;
      if (checkpoint?.state === "recorded") return { changed: [], committed: false, checkpoint, recovered: true };

      const owned = await loadSession(context.repoPath, context.session.id);
      assert.equal(owned.owner.pid, process.pid, "bookkeeping must retain the controller lease");
      assert.match(owned.owner.processStartTime, /^[^:]+:\d+$/, "ownership must persist boot and process-start identity");
      await assert.rejects(
        claimSession(context.repoPath, context.session.id, { pid: process.pid + 1000 }),
        (error) => error.code === "SESSION_OWNED"
      );
      publicationCheckpoint = { state: "intent", issueIds: ["1"] };
      await onCheckpoint(publicationCheckpoint);
      await requestSessionState(context.repoPath, owned, "pause");
      manifestPublications += 1;
      publicationCheckpoint = { state: "recorded", issueIds: ["1"], candidateSha: "manifest-sha" };
      await onCheckpoint(publicationCheckpoint);
      return { changed: ["1"], committed: true, checkpoint: publicationCheckpoint };
    }
  };

  const paused = await driveAutonomous(context, services);
  assert.equal(paused.status, "paused");
  assert.equal(paused.owner, undefined);
  assert.equal(paused.progress.manifestPublication.state, "recorded");
  assert.deepEqual(paused.progress.bookkeepingPendingIssueIds, []);

  const resumed = await driveAutonomous({ ...context, session: await loadSession(context.repoPath, context.session.id) }, services);
  assert.equal(resumed.status, "quiescent");
  assert.equal(integrationCalls, 1);
  assert.equal(publicationCalls, 2, "resume re-enters the idempotent publication service");
  assert.equal(manifestPublications, 1, "the manifest commit/push boundary executes exactly once");
});

test("parent closure reruns acceptance after manifest publication moves the target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-parent-publication-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    repository: "example/repo",
    defaultBranch: "main",
    integration: { enabled: true, closeIssues: true },
    worksets: { epic: {
      source: { type: "epic", issue: { repository: "example/repo", number: "10" } },
      refresh: { mode: "explicit" },
      completionPolicy: "The assembled workflow passes.",
      acceptance: { version: "v1", commands: ["npm test"], closeParent: true }
    } },
    work: { "1": { status: "complete" } }
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(config, null, 2)}\n`);
  const scope = { type: "workset", workset: "epic", issueIds: ["1"], revision: "scope-revision" };
  const authorization = createDelegatedAuthorization({
    config, repoPath, runId: "publication-root", issueIds: ["1"], scope,
    limits: { concurrency: 1, correction: { enabled: true, retryLimit: 2, deadlineMs: 60_000 } },
    invocation: ["maestro", "start", "--workset", "epic", "--delegate", "--continuous"]
  });
  await saveAuthorization(repoPath, authorization);
  let session = await createSession({
    config, repoPath, manifestPath, scope, authorization,
    settings: { concurrency: 1, correction: authorization.limits.correction }
  });
  session.progress.integratedIssueIds = ["1"];
  session.progress.bookkeepingPendingIssueIds = ["1"];
  session.acceptance = {
    outcome: "bookkeeping-pending", parentClosurePending: true, acceptanceReady: true,
    targetSha: "before-publication", scopeRevision: scope.revision
  };
  await saveSession(repoPath, session);

  let published = false;
  const evaluatedTargets = [];
  let closureCalls = 0;
  const acceptance = (targetSha, closed = false) => ({
    outcome: closed ? "verified-complete" : "bookkeeping-pending", verifiedComplete: closed, acceptanceReady: true,
    authorizedSnapshotSatisfied: true, liveScopeComplete: true, parentClosurePending: true,
    targetSha, scopeRevision: scope.revision, contractDigest: `contract-${targetSha}`,
    checks: [{ command: "npm test", status: "passed" }], unresolved: closed ? [] : [{ issue: "10", category: "bookkeeping-pending", reason: "closure pending" }]
  });
  const result = await driveAutonomous({ config, repoPath, manifestPath, session }, {
    assessCurrentScope: async () => ({ current: true, revision: scope.revision }),
    computeEffectivePlan: async () => ({ selected: [], humanGates: [], blocked: [], deferred: [] }),
    verifyExecutionSelection: async () => {},
    loadExecutionStates: async () => [],
    evaluateCompletion: async ({ session: evaluatedSession }) => {
      const target = published ? "after-publication" : "before-publication";
      evaluatedTargets.push(target);
      return acceptance(target, evaluatedSession.parentClosure?.state === "confirmed");
    },
    persistManifestCompletionDurably: async () => {
      published = true;
      return { changed: ["1"], committed: true };
    },
    reconcileParentClosure: async ({ session: closureSession, scopeAssessment }) => {
      closureCalls += 1;
      assert.equal(closureSession.acceptance.targetSha, "after-publication");
      assert.equal(closureSession.progress.bookkeepingPendingIssueIds.length, 0);
      assert.equal(scopeAssessment.revision, scope.revision);
      return { state: "confirmed", issue: "10", targetSha: closureSession.acceptance.targetSha };
    }
  });

  assert.deepEqual(evaluatedTargets, ["before-publication", "after-publication", "after-publication"]);
  assert.equal(closureCalls, 1);
  assert.equal(result.status, "complete");
  assert.equal(result.acceptance.outcome, "verified-complete");
  assert.equal(result.parentClosure.targetSha, "after-publication");
  assert.ok(result.checkpoints.some((entry) => entry.kind === "post-bookkeeping-acceptance"));
});

test("bookkeeping failure is durably pending before ownership is released", async (t) => {
  const context = await fixture(t, ["1"]);
  const error = new Error("push outcome unknown");
  error.code = "MANIFEST_PUBLICATION_UNCERTAIN";
  await assert.rejects(driveSession({
    ...context,
    observe: async () => ({ readyIssueIds: [], unresolved: [], recoverable: false }),
    advance: async () => { throw new Error("must not advance"); },
    finalize: async () => { throw error; }
  }), (caught) => caught === error);

  const persisted = await loadSession(context.repoPath, context.session.id);
  assert.equal(persisted.owner, undefined);
  assert.equal(persisted.status, "quiescent");
  assert.equal(persisted.phase, "bookkeeping-pending");
  assert.equal(persisted.stopReason, "MANIFEST_PUBLICATION_UNCERTAIN");
  assert.equal(persisted.terminal.nextAction, `maestro resume --session ${persisted.id}`);
});

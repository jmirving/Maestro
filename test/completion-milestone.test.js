const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createDelegatedAuthorization, saveAuthorization } = require("../src/authorization");
const { createSession } = require("../src/autonomous-controller");
const { loadSession } = require("../src/session-store");
const { evaluateCompletion, reconcileParentClosure } = require("../src/completion");
const { driveAutonomous } = require("../bin/maestro");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function integratedIssues(states) {
  return new Set(states.flatMap((state) => (state.integration || []).map((entry) => String(entry.issue))));
}

test("temporary-repository autonomous completion milestone survives waves, correction, interruption, reconciliation, and closure", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-completion-milestone-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.com");
  const config = {
    repository: "example/repo",
    defaultBranch: "main",
    defaultConcurrency: 2,
    integration: { enabled: true, commands: [], postMergeCommands: [], closeIssues: true },
    worksets: { epic: {
      source: { type: "epic", issue: { repository: "example/repo", number: "10" } },
      refresh: { mode: "explicit" },
      completionPolicy: "All dependency waves compose into the expected workflow.",
      acceptance: {
        version: "milestone-v1",
        requirements: ["Outside prerequisites are respected and unrelated work is excluded."],
        commands: ["node -e \"require('fs').accessSync('wave-1.txt'); require('fs').accessSync('wave-2.txt'); require('fs').accessSync('wave-3.txt')\""],
        closeParent: true
      }
    } },
    work: {
      "1": { status: "ready", blockedBy: ["90"] },
      "2": { status: "ready", blockedBy: ["1"] },
      "3": { status: "ready", blockedBy: ["2"] },
      "4": { status: "human_gate", humanGate: "release-owner approval" },
      "90": { status: "complete" },
      "99": { status: "ready" }
    }
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(config, null, 2)}\n`);
  await fs.writeFile(path.join(repoPath, "README.md"), "milestone fixture\n");
  git(repoPath, "add", ".maestro.json", "README.md");
  git(repoPath, "commit", "-qm", "fixture baseline");

  const scope = { type: "workset", workset: "epic", issueIds: ["1", "2", "3"], revision: "epic-scope-v1" };
  const authorization = createDelegatedAuthorization({
    config, repoPath, runId: "milestone-root", issueIds: scope.issueIds, scope,
    limits: { concurrency: 2, correction: { enabled: true, retryLimit: 3, deadlineMs: 120_000 } },
    invocation: ["maestro", "start", "--workset", "epic", "--delegate", "--continuous"]
  });
  await saveAuthorization(repoPath, authorization);
  const session = await createSession({
    config, repoPath, manifestPath, scope, authorization,
    settings: { concurrency: 2, correction: authorization.limits.correction }
  });

  const states = [];
  const selected = [];
  const executionCounts = new Map();
  let runSequence = 0;
  let integrationRegressionInjected = false;
  let manifestCommitCount = 0;
  let closureCount = 0;
  let parentOpen = true;
  const reconciliationRevisions = [];

  function stateFor(runId) {
    return states.find((state) => String(state.runId) === String(runId));
  }

  function makeState(runId, issue, extras = {}) {
    return {
      runId,
      mode: extras.mode || "autonomous",
      status: "running",
      authorization,
      autonomousSessionId: session.id,
      ...(extras.parentRunId ? { parentRunId: extras.parentRunId } : {}),
      plan: { concurrency: 2, selected: [{ id: issue, status: "ready" }] },
      baseline: { enabled: false, allowFailing: false, commands: [], results: [], passing: true },
      preflights: [], workers: [], validations: [], reviews: {}, integration: [],
      ...(extras.integrationCorrection ? { integrationCorrection: extras.integrationCorrection } : {})
    };
  }

  function integrateCommit(state, issue, label) {
    if (state.integration.length) return state.integration;
    return fs.writeFile(path.join(repoPath, `wave-${issue}.txt`), `${label}\n`)
      .then(() => {
        git(repoPath, "add", `wave-${issue}.txt`);
        git(repoPath, "commit", "-qm", `integrate issue ${issue}`);
        state.integration = [{ issue, integratedSha: git(repoPath, "rev-parse", "HEAD") }];
        state.status = "integrated";
        return state.integration;
      });
  }

  const services = {
    assessCurrentScope: async () => {
      reconciliationRevisions.push(scope.revision);
      return { current: true, revision: scope.revision };
    },
    computeEffectivePlan: async () => {
      const done = integratedIssues(states);
      const next = !done.has("1") ? "1" : !done.has("2") ? "2" : !done.has("3") ? "3" : null;
      return {
        selected: next ? [{ id: next }] : [],
        humanGates: [], blocked: [], deferred: []
      };
    },
    verifyExecutionSelection: async (_current, _repoPath, issueIds) => {
      assert.ok(issueIds.every((issue) => scope.issueIds.includes(String(issue))));
      assert.ok(!issueIds.includes("90"), "the shared outside prerequisite must not be executed");
      assert.ok(!issueIds.includes("99"), "unrelated ready work must not be executed");
    },
    loadExecutionStates: async () => states,
    loadRunState: async (_repoPath, runId) => stateFor(runId),
    newRunId: () => `milestone-child-${++runSequence}`,
    reserveReadyWork: async (_current, options) => {
      const done = integratedIssues(states);
      const issue = !done.has("1") ? "1" : !done.has("2") ? "2" : "3";
      selected.push(issue);
      const state = makeState(options.runId, issue, {
        parentRunId: options.runId === authorization.runId ? null : authorization.runId
      });
      states.push(state);
      return { reserved: true, state, plan: state.plan };
    },
    executeRun: async (_current, options) => {
      const state = options.reservedState;
      const issue = String(state.plan.selected[0].id);
      executionCounts.set(issue, Number(executionCounts.get(issue) || 0) + 1);
      state.status = "awaiting-review";
      state.workers = [{ issue, exitCode: 0, baseSha: "base", headSha: `implementation-${issue}` }];
      state.validations = [{
        issue, exitCode: 0,
        verdict: issue === "2" ? "rework" : "approve",
        report: issue === "2" ? "correct wave two" : "VERDICT: APPROVE"
      }];
      return state;
    },
    autoRework: async (_current, options) => {
      assert.deepEqual(options.issueIds, ["2"]);
      const child = makeState("rework-2", "2", { mode: "rework", parentRunId: stateFor("milestone-child-1").runId });
      child.status = "awaiting-review";
      child.workers = [{ issue: "2", exitCode: 0, baseSha: "base", headSha: "corrected-2" }];
      child.validations = [{ issue: "2", exitCode: 0, verdict: "approve" }];
      child.correction = { attempts: { "2": { number: 1 } } };
      states.push(child);
      return { issues: [{ issue: "2", outcome: "approved", attemptsUsed: 1, finalRunId: child.runId, runs: [{ runId: child.runId }] }] };
    },
    integrateExistingRun: async (_current, options) => {
      const state = stateFor(options.runId);
      const issue = String(state.plan.selected[0].id);
      if (state.mode === "autonomous" && issue === "2") return { integration: [] };
      if (state.mode === "autonomous" && issue === "3" && !integrationRegressionInjected) {
        integrationRegressionInjected = true;
        state.status = "integration-regression";
        const child = makeState("integration-correction-3", "3", {
          mode: "integration-correction", parentRunId: state.runId,
          integrationCorrection: { issue: "3", attempts: [{ number: 1, status: "completed", outcome: "approve" }] }
        });
        child.status = "awaiting-review";
        child.workers = [{ issue: "3", exitCode: 0, baseSha: "base", headSha: "corrected-3" }];
        child.validations = [{ issue: "3", exitCode: 0, verdict: "approve" }];
        states.push(child);
        const error = new Error("deterministic interruption after integration-check correction");
        error.code = "MILESTONE_INTERRUPTION";
        throw error;
      }
      const integration = await integrateCommit(state, issue, state.mode);
      return { integration, newlyIntegrated: integration };
    },
    persistManifestCompletionDurably: async ({ issueIds }) => {
      const current = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      let changed = false;
      for (const issue of issueIds) {
        if (current.work[issue]?.status !== "complete") {
          current.work[issue].status = "complete";
          changed = true;
        }
      }
      if (!changed) return { changed: [], committed: false };
      await fs.writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
      git(repoPath, "add", ".maestro.json");
      git(repoPath, "commit", "-qm", "publish completion bookkeeping");
      manifestCommitCount += 1;
      return { changed: issueIds, committed: true };
    },
    reconcileParentClosure: (options) => reconcileParentClosure({
      ...options,
      runner: async (command, args, runOptions) => {
        if (command === "gh") {
          if (args[1] === "view") return { code: 0, stdout: parentOpen ? "OPEN\n" : "CLOSED\n", stderr: "" };
          if (args[1] === "close") {
            closureCount += 1;
            parentOpen = false;
            return { code: 0, stdout: "", stderr: "" };
          }
        }
        const result = spawnSync(command, args, { cwd: runOptions.cwd, encoding: "utf8" });
        if (result.status !== 0) {
          const error = new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
          error.result = { code: result.status, stdout: result.stdout, stderr: result.stderr };
          throw error;
        }
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      }
    })
  };

  await assert.rejects(
    driveAutonomous({ config, repoPath, manifestPath, session }, services),
    (error) => error.code === "MILESTONE_INTERRUPTION"
  );
  const interrupted = await loadSession(repoPath, session.id);
  assert.equal(interrupted.status, "quiescent");
  assert.equal(interrupted.stopReason, "MILESTONE_INTERRUPTION");
  assert.equal(stateFor("integration-correction-3").integrationCorrection.attempts.length, 1);

  let currentSession = interrupted;
  for (let attempt = 0; attempt < 4 && currentSession.status !== "complete"; attempt += 1) {
    currentSession = await driveAutonomous({
      config: JSON.parse(await fs.readFile(manifestPath, "utf8")),
      repoPath, manifestPath, session: currentSession
    }, services);
    currentSession = await loadSession(repoPath, session.id);
  }

  assert.equal(currentSession.status, "complete");
  assert.equal(currentSession.terminal.verifiedComplete, true);
  assert.equal(currentSession.acceptance.outcome, "verified-complete");
  assert.equal(currentSession.acceptance.targetSha, git(repoPath, "rev-parse", "HEAD"));
  assert.equal(currentSession.acceptance.scopeRevision, scope.revision);
  assert.equal(currentSession.acceptance.checks[0].status, "passed");
  assert.equal(currentSession.parentClosure.state, "confirmed");
  assert.deepEqual(selected, ["1", "2", "3"]);
  assert.deepEqual(Object.fromEntries(executionCounts), { "1": 1, "2": 1, "3": 1 });
  assert.equal(stateFor("rework-2").correction.attempts["2"].number, 1);
  assert.equal(stateFor("integration-correction-3").integrationCorrection.attempts.length, 1);
  assert.equal(manifestCommitCount, 1);
  assert.equal(closureCount, 1);
  assert.ok(reconciliationRevisions.length >= 3);
  assert.ok(reconciliationRevisions.every((revision) => revision === scope.revision));

  const gated = await evaluateCompletion({
    config: JSON.parse(await fs.readFile(manifestPath, "utf8")),
    repoPath,
    session: {
      id: "human-gated-sibling",
      scope: { type: "issues", issueIds: ["1", "4"], revision: "gated-scope" },
      progress: { bookkeepingPendingIssueIds: [] }
    },
    states,
    scopeAssessment: { current: true, revision: "gated-scope" }
  });
  assert.equal(gated.verifiedComplete, false);
  assert.equal(gated.outcome, "incomplete");
  assert.equal(gated.members.find((member) => member.issue === "1").outcome, "verified", "safe sibling work remains complete");
  assert.match(gated.unresolved.find((entry) => entry.issue === "4").reason, /human_gate/);
});

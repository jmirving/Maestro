const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMembers, evaluateCompletion, reconcileParentClosure, worksetContract } = require("../src/completion");
const { digest } = require("../src/authorization");

function config(overrides = {}) {
  return {
    repository: "example/repo",
    defaultBranch: "main",
    work: { "1": { status: "complete" }, "2": { status: "complete" } },
    ...overrides
  };
}

function integrated(issue, extras = {}) {
  return {
    runId: `run-${issue}`,
    status: "integrated",
    workers: [{ issue, exitCode: 0, baseSha: "base", headSha: extras.noChange ? "base" : `head-${issue}`, noChange: extras.noChange === true }],
    validations: [{ issue, exitCode: 0, verdict: "approve" }],
    integration: [{ issue, integratedSha: "target", noChange: extras.noChange === true, ...extras }],
    closures: extras.closureRequired ? { [issue]: { issue, state: extras.closureState || "pending" } } : {}
  };
}

function gitRunner(head = "target") {
  return async (_command, args) => {
    if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

test("member accounting distinguishes integrated, verified no-change, external, and bookkeeping evidence", () => {
  const external = {
    source: "external", githubState: "CLOSED", githubStateReason: "completed", evidence: {},
    verification: { outcome: "verified", targetSha: "target", checks: [{ name: "workflow", status: "passed" }] }
  };
  const value = config({ work: {
    "1": { status: "complete" },
    "2": { status: "complete" },
    "3": { status: "complete", completion: external },
    "4": { status: "inactive" }
  } });
  const result = classifyMembers(value, [integrated("1"), integrated("2", { noChange: true })], ["1", "2", "3", "4"], { targetSha: "target" });
  assert.deepEqual(result.members.map((entry) => [entry.issue, entry.outcome, entry.source]), [
    ["1", "verified", "maestro-integration"],
    ["2", "verified", "verified-no-change"],
    ["3", "verified", "external"],
    ["4", "incomplete", null]
  ]);
  assert.match(result.unresolved[0].reason, /not an acceptance decision/);
});

test("external completion fails closed when verification is stale or unavailable", () => {
  const value = config({ work: { "1": {
    status: "complete",
    completion: {
      source: "external", githubState: "CLOSED", githubStateReason: "completed", evidence: {},
      verification: { outcome: "verified", targetSha: "old", checks: [{ name: "test", status: "passed" }] }
    }
  } } });
  const result = classifyMembers(value, [], ["1"], { targetSha: "target" });
  assert.equal(result.members[0].outcome, "incomplete");
  assert.match(result.members[0].reason, /lacks current independent verification/);
});

test("workset completion requires explicit repository-owned acceptance requirements", async () => {
  const value = config({ worksets: {
    epic: { source: { type: "epic", issue: { repository: "example/repo", number: "10" } }, refresh: { mode: "explicit" } }
  } });
  const session = { id: "session-test", scope: { type: "workset", workset: "epic", issueIds: ["1", "2"], revision: "scope-1" }, progress: { bookkeepingPendingIssueIds: [] } };
  const result = await evaluateCompletion({ config: value, repoPath: "/repo", session, states: [integrated("1"), integrated("2")], scopeAssessment: { current: true }, runner: gitRunner() });
  assert.equal(result.outcome, "human-action-required");
  assert.equal(result.verifiedComplete, false);
  assert.match(result.unresolved[0].reason, /acceptance requirements are missing/);
});

test("aggregate checks run on one target SHA and accepted baseline failures stay explicit", async () => {
  const value = config({
    worksets: {
      epic: {
        source: { type: "epic", issue: { repository: "example/repo", number: "10" } },
        refresh: { mode: "explicit" },
        completionPolicy: "The assembled workflow works end to end.",
        acceptance: { version: "v2", commands: ["npm test"] }
      }
    }
  });
  const session = {
    id: "session-test",
    authorization: { id: "authorization-test", policyDigest: "policy-test" },
    scope: { type: "workset", workset: "epic", issueIds: ["1", "2"], revision: "scope-1" },
    lineage: { runIds: ["run-1", "run-2"] },
    progress: { bookkeepingPendingIssueIds: [] }
  };
  const states = [integrated("1"), integrated("2")].map((state) => ({
    ...state,
    autonomousSessionId: session.id,
    authorization: { ...session.authorization, scope: { revision: session.scope.revision } }
  }));
  states[0].baseline = { allowFailing: true, results: [{ command: "npm test", code: 1, stdout: "not ok 1 - known", stderr: "" }] };
  const result = await evaluateCompletion({
    config: value, repoPath: "/repo", session, states, scopeAssessment: { current: true }, runner: gitRunner(),
    shellRunner: async () => ({ code: 1, stdout: "not ok 1 - known", stderr: "" }),
    now: new Date("2026-09-27T12:00:00.000Z")
  });
  assert.equal(result.outcome, "verified-complete");
  assert.equal(result.verifiedComplete, true);
  assert.equal(result.targetSha, "target");
  assert.equal(result.checks[0].status, "accepted-baseline-failure");
  assert.equal(result.contract.version, "v2");
});

test("aggregate checks cannot inherit an accepted failing baseline from another session", async () => {
  const value = config({ worksets: { epic: {
    source: { type: "epic", issue: { repository: "example/repo", number: "10" } }, refresh: { mode: "explicit" },
    completionPolicy: "Workflow", acceptance: { version: "v1", commands: ["npm test"] }
  } } });
  const session = {
    id: "current-session",
    authorization: { id: "current-authorization", policyDigest: "current-policy" },
    scope: { type: "workset", workset: "epic", issueIds: ["1", "2"], revision: "scope-1" },
    lineage: { runIds: ["run-1", "run-2"] },
    progress: { bookkeepingPendingIssueIds: [] }
  };
  const states = [integrated("1"), integrated("2")];
  states.push({
    runId: "historical-run",
    autonomousSessionId: "other-session",
    authorization: { id: "other-authorization", policyDigest: "other-policy", scope: { revision: "scope-1" } },
    baseline: { allowFailing: true, results: [{ command: "npm test", code: 1, stdout: "not ok 1 - known", stderr: "" }] }
  });
  const result = await evaluateCompletion({
    config: value, repoPath: "/repo", session, states, scopeAssessment: { current: true }, runner: gitRunner(),
    shellRunner: async () => ({ code: 1, stdout: "not ok 1 - known", stderr: "" })
  });
  assert.equal(result.outcome, "failed-validation");
  assert.equal(result.checks[0].status, "failed");
});

test("failed aggregate workflow checks keep an otherwise integrated epic incomplete", async () => {
  const value = config({ worksets: {
    epic: {
      source: { type: "epic", issue: { repository: "example/repo", number: "10" } }, refresh: { mode: "explicit" },
      completionPolicy: "The workflow works.", acceptance: { version: "v1", commands: ["npm test"] }
    }
  } });
  const session = { id: "session-test", scope: { type: "workset", workset: "epic", issueIds: ["1", "2"], revision: "scope-1" }, progress: { bookkeepingPendingIssueIds: [] } };
  const result = await evaluateCompletion({
    config: value, repoPath: "/repo", session, states: [integrated("1"), integrated("2")], scopeAssessment: { current: true }, runner: gitRunner(),
    shellRunner: async () => ({ code: 1, stdout: "not ok 1 - regression", stderr: "" })
  });
  assert.equal(result.outcome, "failed-validation");
  assert.equal(result.verifiedComplete, false);
  assert.equal(result.checks[0].status, "failed");
});

test("target movement during aggregate checks invalidates otherwise passing evidence", async () => {
  const value = config({ worksets: { epic: {
    source: { type: "epic", issue: { repository: "example/repo", number: "10" } }, refresh: { mode: "explicit" },
    completionPolicy: "Workflow", acceptance: { version: "v1", commands: ["npm test"] }
  } } });
  const session = { id: "session-test", scope: { type: "workset", workset: "epic", issueIds: ["1", "2"], revision: "scope-1" }, progress: { bookkeepingPendingIssueIds: [] } };
  let heads = 0;
  const runner = async (_command, args) => {
    if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${heads++ ? "moved" : "target"}\n`, stderr: "" };
    if (["status", "merge-base"].includes(args[0])) return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const result = await evaluateCompletion({ config: value, repoPath: "/repo", session, states: [integrated("1"), integrated("2")], scopeAssessment: { current: true }, runner, shellRunner: async () => ({ code: 0, stdout: "ok", stderr: "" }) });
  assert.equal(result.outcome, "scope-changed");
  assert.match(result.unresolved[0].reason, /target moved/);
});

test("completion evidence is reused idempotently only for the same target, scope, and contract", async () => {
  const value = config();
  const session = { id: "session-test", scope: { type: "issues", issueIds: ["1", "2"], revision: "scope-1" }, progress: { bookkeepingPendingIssueIds: [] } };
  const first = await evaluateCompletion({ config: value, repoPath: "/repo", session, states: [integrated("1"), integrated("2")], scopeAssessment: { current: true }, runner: gitRunner() });
  const second = await evaluateCompletion({ config: value, repoPath: "/repo", session, states: [integrated("1"), integrated("2")], scopeAssessment: { current: true }, runner: gitRunner(), priorEvidence: first });
  assert.equal(first.verifiedComplete, true);
  assert.equal(second.reused, true);
});

test("bookkeeping, closures, discarded work, and scope drift cannot become verified completion", async () => {
  const value = config({ work: { "1": { status: "ready" }, "2": { status: "ready" } } });
  const member = classifyMembers(value, [integrated("1", { closureRequired: true }), {
    runId: "run-2", status: "awaiting-review", workers: [{ issue: "2", exitCode: 0 }], validations: [{ issue: "2", verdict: "rework" }], reviews: { "2": { disposition: "discard" } }
  }], ["1", "2"], { targetSha: "target" });
  assert.equal(member.members[0].outcome, "bookkeeping-pending");
  assert.equal(member.members[1].outcome, "incomplete");

  const session = { id: "session-test", scope: { type: "issues", issueIds: ["1"], revision: "scope-1" }, progress: { bookkeepingPendingIssueIds: [] } };
  const drift = await evaluateCompletion({ config: value, repoPath: "/repo", session, states: [], scopeAssessment: { current: false, reason: "new child" } });
  assert.equal(drift.outcome, "scope-changed");
});

test("empty and partially accounted scopes fail closed", async () => {
  const empty = await evaluateCompletion({
    config: config(), repoPath: "/repo",
    session: { id: "empty", scope: { type: "issues", issueIds: [], revision: "empty" }, progress: { bookkeepingPendingIssueIds: [] } },
    states: [], scopeAssessment: { current: true }
  });
  assert.equal(empty.outcome, "human-action-required");
  assert.equal(empty.unresolved[0].category, "empty-scope");

  const partial = classifyMembers(config(), [integrated("1")], ["1", "2"], { targetSha: "target" });
  assert.equal(partial.members[0].outcome, "verified");
  assert.equal(partial.members[1].outcome, "incomplete");
});

test("contract retains parent acceptance context without making the epic a duplicate member", () => {
  const value = config({ worksets: { epic: {
    source: { type: "epic", issue: { repository: "example/repo", number: "10" } }, refresh: { mode: "explicit" },
    completionPolicy: "Parent workflow", acceptance: { version: "v1", requirements: ["Nested flow passes"], closeParent: true }
  } } });
  assert.deepEqual(worksetContract(value, { type: "workset", workset: "epic", issueIds: ["1"], revision: "r" }), {
    source: "worksets.epic", version: "v1", requirements: ["Parent workflow", "Nested flow passes"], commands: [], closeParent: true, parentIssue: "10"
  });
});

test("authorized parent closure observes before mutation and is idempotent", async () => {
  const value = config({
    integration: { closeIssues: true },
    worksets: { epic: {
      source: { type: "epic", issue: { repository: "example/repo", number: "10" } }, refresh: { mode: "explicit" },
      completionPolicy: "Parent workflow", acceptance: { version: "v1", closeParent: true }
    } }
  });
  const session = {
    scope: { type: "workset", workset: "epic", issueIds: ["1"], revision: "scope-1" },
    acceptance: {
      targetSha: "target",
      scopeRevision: "scope-1",
      contractDigest: digest({ contract: worksetContract(value, { type: "workset", workset: "epic", issueIds: ["1"], revision: "scope-1" }), scopeRevision: "scope-1" }),
      acceptanceReady: true,
      authorizedSnapshotSatisfied: true,
      liveScopeComplete: true
    }
  };
  const calls = [];
  const closure = await reconcileParentClosure({
    config: value, repoPath: "/repo", session,
    scopeAssessment: { current: true, revision: "scope-1" },
    authorization: { allowedActions: { closeIssue: true } },
    runner: async (_command, args) => {
      calls.push(args);
      if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "target\n", stderr: "" };
      return { code: 0, stdout: args[1] === "view" ? "OPEN\n" : "", stderr: "" };
    },
    now: new Date("2026-09-27T12:00:00.000Z")
  });
  assert.equal(closure.state, "confirmed");
  assert.equal(calls.filter((args) => args[1] === "close").length, 1);

  calls.length = 0;
  const reused = await reconcileParentClosure({ config: value, repoPath: "/repo", session: { ...session, parentClosure: closure }, scopeAssessment: { current: true, revision: "scope-1" }, authorization: { allowedActions: { closeIssue: true } }, runner: async () => { throw new Error("must not call"); } });
  assert.equal(reused, closure);
  assert.equal(calls.length, 0);
});

test("parent closure refuses target movement after acceptance without touching GitHub", async () => {
  const value = config({
    integration: { closeIssues: true },
    worksets: { epic: {
      source: { type: "epic", issue: { repository: "example/repo", number: "10" } }, refresh: { mode: "explicit" },
      completionPolicy: "Parent workflow", acceptance: { version: "v1", closeParent: true }
    } }
  });
  const scope = { type: "workset", workset: "epic", issueIds: ["1"], revision: "scope-1" };
  const contract = worksetContract(value, scope);
  const session = { scope, acceptance: {
    targetSha: "accepted-target", scopeRevision: scope.revision,
    contractDigest: digest({ contract, scopeRevision: scope.revision }),
    acceptanceReady: true, authorizedSnapshotSatisfied: true, liveScopeComplete: true
  } };
  let githubCalls = 0;
  await assert.rejects(reconcileParentClosure({
    config: value, repoPath: "/repo", session,
    scopeAssessment: { current: true, revision: scope.revision },
    authorization: { allowedActions: { closeIssue: true } },
    runner: async (command, args) => {
      if (command === "gh") githubCalls += 1;
      if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "moved-target\n", stderr: "" };
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    }
  }), (error) => error.code === "PARENT_CLOSURE_TARGET_MOVED");
  assert.equal(githubCalls, 0);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { integrateExistingRun, classifyRunItems } = require("../src/existing-run");
const { saveRunState } = require("../src/run-store");

test("classifyRunItems allows approved work to integrate while rejected work is marked for rework", () => {
  const state = {
    runId: "run-1",
    workers: [
      { issue: "33", exitCode: 0 },
      { issue: "47", exitCode: 0 }
    ],
    validations: [
      { issue: "33", verdict: "approve" },
      { issue: "47", verdict: "rework" }
    ],
    reviews: {
      "33": { disposition: "approve" },
      "47": { disposition: "rework-original" }
    }
  };

  const result = classifyRunItems(state);
  assert.deepEqual(result.integrable.map((entry) => entry.issue), ["33"]);
  assert.deepEqual(result.rework.map((entry) => entry.issue), ["47"]);
});

test("classifyRunItems refuses non-approved work unless human review explicitly marks it for rework", () => {
  assert.throws(() => classifyRunItems({
    runId: "run-2",
    workers: [{ issue: "47", exitCode: 0 }],
    validations: [{ issue: "47", verdict: "rework" }],
    reviews: { "47": { disposition: "approve" } }
  }), /not validator-approved/);
});

test("classifyRunItems integrates an audited override and excludes discarded work", () => {
  const result = classifyRunItems({
    runId: "run-3",
    workers: [{ issue: "7" }, { issue: "8" }],
    validations: [
      { issue: "7", verdict: "rework", exitCode: 1, report: "fix this" },
      { issue: "8", verdict: "rework" }
    ],
    reviews: {
      "7": {
        disposition: "approve-override",
        validatorOverride: { verdict: "rework", exitCode: 1, report: "fix this" }
      },
      "8": { disposition: "discard" }
    }
  });

  assert.deepEqual(result.integrable.map((entry) => entry.issue), ["7"]);
  assert.deepEqual(result.discarded.map((entry) => entry.issue), ["8"]);
  assert.deepEqual(result.rework, []);
});

test("classifyRunItems refuses override approval without matching validator provenance", () => {
  assert.throws(() => classifyRunItems({
    runId: "run-4",
    workers: [{ issue: "7" }],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: { "7": { disposition: "approve-override" } }
  }), /not validator-approved/);
});

test("integration guard rejects the same manifest/run conflict shown by status before invoking adapters", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-effective-guard-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = "20260910010101-aaaaaa";
  await saveRunState(root, runId, {
    runId,
    status: "awaiting-review",
    workers: [{ issue: "13", headSha: "stale-13" }],
    validations: [{ issue: "13", verdict: "approve" }],
    reviews: { "13": { disposition: "approve" } },
    integration: []
  });
  let invoked = false;

  await assert.rejects(integrateExistingRun({ work: { "13": { status: "complete" } } }, {
    repoPath: root,
    runId,
    runner: async () => { invoked = true; },
    shellRunner: async () => { invoked = true; }
  }), /complete in the manifest.*no integration record/i);
  assert.equal(invoked, false);
});

test("explicit historical integration skips a superseded implementation without adapter activity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-superseded-guard-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRunId = "20260910010101-aaaaaa";
  const childRunId = "20260910020202-bbbbbb";
  await saveRunState(root, sourceRunId, {
    runId: sourceRunId,
    status: "awaiting-review",
    workers: [{ issue: "13", headSha: "stale-13" }],
    validations: [{ issue: "13", verdict: "approve" }],
    reviews: { "13": { disposition: "approve" } },
    integration: []
  });
  await saveRunState(root, childRunId, {
    runId: childRunId,
    parentRunId: sourceRunId,
    status: "awaiting-review",
    workers: [{ issue: "13", headSha: "current-13" }],
    validations: [{ issue: "13", verdict: "rework" }],
    reviews: {},
    integration: []
  });
  let invoked = false;

  const result = await integrateExistingRun({ work: { "13": { status: "ready" } } }, {
    repoPath: root,
    runId: sourceRunId,
    runner: async () => { invoked = true; },
    shellRunner: async () => { invoked = true; }
  });
  assert.equal(result.nothingToDo, true);
  assert.deepEqual(result.superseded, [{ issue: "13" }]);
  assert.equal(invoked, false);
});

test("integration check failure enters bounded correction instead of opaque integration failure", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-integration-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = "20260920010101-aaaaaa";
  await saveRunState(root, runId, {
    runId,
    status: "awaiting-review",
    workers: [{ issue: "26", branch: "worker/26", worktreePath: "/worker", baseSha: "base", headSha: "source", exitCode: 0 }],
    validations: [{ issue: "26", verdict: "approve", exitCode: 0, report: "approved before combination" }],
    reviews: { "26": { disposition: "approve" } },
    integration: []
  });
  let correctionInput = null;
  let shellCalls = 0;
  const runner = async (_command, args) => {
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: "worker/26\n", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "origin/main") return { code: 0, stdout: "target\n", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: "refreshed\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await integrateExistingRun({
    repository: "example/repo",
    work: { "26": { status: "ready" } },
    integration: { commands: ["npm test"] }
  }, {
    repoPath: root,
    runId,
    runner,
    shellRunner: async () => {
      shellCalls += 1;
      return shellCalls === 1
        ? { code: 0, stdout: "baseline passes", stderr: "" }
        : { code: 1, stdout: "not ok 1 - integration interaction", stderr: "" };
    },
    integrationCorrectionExecutor: async (_config, input) => {
      correctionInput = input;
      return { runId: "20260920020202-bbbbbb", status: "awaiting-review", integrationCorrection: { outcome: "approved" } };
    }
  });

  assert.equal(result.stopped, "integration-correction");
  assert.deepEqual(result.newlyIntegrated, []);
  assert.deepEqual(result.integrationRecovery, {
    runId: "20260920020202-bbbbbb", issue: "26", status: "awaiting-review", outcome: "approved"
  });
  assert.equal(correctionInput.sourceRunId, runId);
  assert.equal(correctionInput.failure.command, "npm test");
  assert.match(correctionInput.failure.result.stdout, /integration interaction/);
});

test("commit resumes an active integration-correction child before reclassifying its source", async (t) => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-existing-correction-resume-"));
  t.after(() => fs.rm(repoPath, { recursive: true, force: true }));
  const sourceRunId = "20260920080101-aaaaaa";
  const correctionRunId = "20260920080202-bbbbbb";
  const worker = { issue: "26", branch: "worker/26", worktreePath: repoPath, headSha: "source-head", exitCode: 0 };
  const validation = { issue: "26", verdict: "approve", exitCode: 0 };
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId, mode: "execute", status: "awaiting-review",
    plan: { selected: [{ id: "26" }] }, workers: [worker], validations: [validation],
    reviews: { "26": { disposition: "approve" } }, baseline: { status: "passed" }
  });
  await saveRunState(repoPath, correctionRunId, {
    runId: correctionRunId, parentRunId: sourceRunId, mode: "integration-correction", status: "running",
    plan: { selected: [{ id: "26" }] }, workers: [], validations: [], reviews: {},
    capacity: { issues: ["26"] },
    integrationCorrection: {
      contractVersion: 1, kind: "integration-regression", issue: "26", deadlineAt: Date.now() + 60_000,
      attempts: [{ number: 1, status: "running", outcome: "running", processId: 2147483647 }],
      trigger: { command: "npm test", code: 1, stdout: "failed", stderr: "", targetSha: "target", sourceSha: "source-head" }
    }
  });

  let invocation;
  const result = await integrateExistingRun({ repository: "example/repo", work: { "26": { status: "ready" } } }, {
    repoPath,
    runId: sourceRunId,
    integrationCorrectionExecutor: async (_config, options) => {
      invocation = options;
      return {
        runId: correctionRunId,
        status: "awaiting-review",
        integrationCorrection: { outcome: "approved" }
      };
    }
  });

  assert.equal(invocation.sourceRunId, sourceRunId);
  assert.deepEqual(invocation.originalWorker, worker);
  assert.deepEqual(invocation.originalValidation, validation);
  assert.equal(invocation.failure.command, "npm test");
  assert.equal(result.integrationRecovery.runId, correctionRunId);
  assert.equal(result.integrationRecovery.outcome, "approved");
  assert.equal(result.stopped, "integration-correction");
  assert.equal(result.resumed, true);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { executeIntegrationCorrection } = require("../src/integration-correction");
const { loadRunState, saveRunState } = require("../src/run-store");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

test("integration regression correction is charged, committed, freshly validated, and returned to review", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-integration-correction-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "worker/26");
  git(repo, "config", "user.name", "Maestro Test");
  git(repo, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(repo, "behavior.txt"), "refreshed interaction\n");
  git(repo, "add", "behavior.txt");
  git(repo, "commit", "-qm", "refreshed implementation");
  const targetSha = git(repo, "rev-parse", "HEAD");
  const saved = [];
  let correctionContext;
  let validatorCalls = 0;
  const result = await executeIntegrationCorrection({
    repository: "example/repo",
    resolution: { maxAttempts: 3 },
    work: { "26": { status: "ready" } }
  }, {
    repoPath: repo,
    sourceRunId: "20260920010101-aaaaaa",
    runId: "20260920020202-bbbbbb",
    originalWorker: {
      issue: "26", branch: "worker/26", worktreePath: repo,
      baseSha: "base", headSha: targetSha, exitCode: 0, report: "original behavior"
    },
    originalValidation: { issue: "26", verdict: "approve", report: "previous approval" },
    failure: {
      command: "npm test", result: { code: 1, stdout: "not ok 1 - combined behavior", stderr: "" },
      targetSha, sourceSha: targetSha
    },
    capacityReserver: async (_config, options) => ({
      reserved: true,
      state: {
        runId: options.runId, mode: options.mode, status: "running", plan: { selected: options.items },
        capacity: { issues: ["26"] }
      }
    }),
    stateSaver: async (_repoPath, _runId, state) => { saved.push(JSON.parse(JSON.stringify(state))); },
    workerExecutor: async ({ worktree, correctionContext: context }) => {
      correctionContext = context;
      await fs.writeFile(path.join(repo, "behavior.txt"), "refreshed interaction\ncompatible correction\n");
      git(repo, "add", "behavior.txt");
      git(repo, "commit", "-qm", "correct combined regression");
      return {
        issue: "26", branch: worktree.branch, worktreePath: repo, baseSha: worktree.baseSha,
        headSha: git(repo, "rev-parse", "HEAD"), exitCode: 0, report: "corrected and tested"
      };
    },
    validatorExecutor: async ({ worker }) => {
      validatorCalls += 1;
      assert.notEqual(worker.headSha, targetSha);
      return { issue: "26", verdict: "approve", exitCode: 0, report: "VERDICT: APPROVE" };
    }
  });

  assert.equal(result.status, "awaiting-review");
  assert.equal(result.integrationCorrection.outcome, "approved");
  assert.equal(result.integrationCorrection.attempts.length, 1);
  assert.equal(result.integrationCorrection.attempts[0].number, 1);
  assert.equal(validatorCalls, 1);
  assert.match(correctionContext.validatorReport, /combined behavior/);
  assert.match(correctionContext.validatorReport, /Previous correction validation:\nprevious approval/);
  assert.deepEqual(result.reviews, {}, "stale approval must not be inherited");
  assert.deepEqual(result.capacity.issues, []);
  assert.equal(saved.some((state) => state.integrationCorrection.attempts[0]?.phase === "worker"), true);
});

test("integration correction retries REWORK within one persisted bounded lineage", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-integration-retry-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "worker/26");
  git(repo, "config", "user.name", "Maestro Test");
  git(repo, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(repo, "behavior.txt"), "base\n");
  git(repo, "add", "behavior.txt");
  git(repo, "commit", "-qm", "base");
  const targetSha = git(repo, "rev-parse", "HEAD");
  let workerCalls = 0;
  const result = await executeIntegrationCorrection({
    repository: "example/repo", resolution: { maxAttempts: 2 }, work: { "26": { status: "ready" } }
  }, {
    repoPath: repo,
    sourceRunId: "source",
    runId: "20260920030303-cccccc",
    originalWorker: { issue: "26", branch: "worker/26", worktreePath: repo, headSha: targetSha, exitCode: 0 },
    originalValidation: { verdict: "approve", report: "approved before combination" },
    failure: { command: "npm test", result: { code: 1 }, targetSha, sourceSha: targetSha },
    capacityReserver: async (_config, options) => ({
      reserved: true,
      state: { runId: options.runId, status: "running", plan: { selected: options.items }, capacity: { issues: ["26"] } }
    }),
    stateSaver: async () => {},
    workerExecutor: async ({ worktree }) => {
      workerCalls += 1;
      await fs.appendFile(path.join(repo, "behavior.txt"), `attempt ${workerCalls}\n`);
      git(repo, "add", "behavior.txt");
      git(repo, "commit", "-qm", `attempt ${workerCalls}`);
      return { issue: "26", branch: worktree.branch, worktreePath: repo, baseSha: targetSha, headSha: git(repo, "rev-parse", "HEAD"), exitCode: 0 };
    },
    validatorExecutor: async () => ({
      issue: "26", exitCode: 0, verdict: workerCalls === 1 ? "rework" : "approve",
      report: workerCalls === 1 ? "VERDICT: REWORK\nStill incompatible." : "VERDICT: APPROVE"
    })
  });
  assert.equal(workerCalls, 2);
  assert.equal(result.status, "awaiting-review");
  assert.deepEqual(result.integrationCorrection.attempts.map((entry) => entry.outcome), ["rework", "approve"]);
});

test("integration correction records no-progress without launching a validator", async () => {
  let persisted;
  let validatorCalls = 0;
  await assert.rejects(executeIntegrationCorrection({
    repository: "example/repo", work: { "26": { status: "ready" } }
  }, {
    repoPath: "/unused",
    sourceRunId: "source",
    runId: "20260920050505-eeeeee",
    originalWorker: { issue: "26", branch: "worker/26", worktreePath: "/unused", headSha: "same", exitCode: 0 },
    originalValidation: { verdict: "approve" },
    failure: { command: "npm test", result: { code: 1 }, targetSha: "target", sourceSha: "same" },
    capacityReserver: async (_config, options) => ({
      reserved: true,
      state: { runId: options.runId, status: "running", plan: { selected: options.items }, capacity: { issues: ["26"] } }
    }),
    stateSaver: async (_repo, _run, state) => { persisted = JSON.parse(JSON.stringify(state)); },
    workerExecutor: async () => ({
      issue: "26", branch: "worker/26", worktreePath: "/unused", baseSha: "target", headSha: "same", exitCode: 0
    }),
    validatorExecutor: async () => { validatorCalls += 1; }
  }), /made no commit/);
  assert.equal(validatorCalls, 0);
  assert.equal(persisted.integrationCorrection.outcome, "no-progress");
  assert.deepEqual(persisted.capacity.issues, []);
});

test("integration correction resumes an interrupted charged attempt without resetting its lineage", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-integration-resume-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "worker/26");
  git(repo, "config", "user.name", "Maestro Test");
  git(repo, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(repo, "behavior.txt"), "base\n");
  git(repo, "add", "behavior.txt");
  git(repo, "commit", "-qm", "base");
  const targetSha = git(repo, "rev-parse", "HEAD");
  const sourceRunId = "20260920060101-aaaaaa";
  const correctionRunId = "20260920060202-bbbbbb";
  await saveRunState(repo, sourceRunId, {
    runId: sourceRunId, mode: "execute", status: "awaiting-review",
    plan: { selected: [{ id: "26" }] },
    workers: [{ issue: "26", branch: "worker/26", worktreePath: repo, headSha: targetSha, exitCode: 0 }],
    validations: [{ issue: "26", verdict: "approve", exitCode: 0 }], reviews: {}
  });

  const config = {
    repository: "example/repo", defaultConcurrency: 1,
    resolution: { maxAttempts: 1, timeoutMs: 60_000 },
    work: { "26": { status: "ready", blockedBy: [], requires: [] } }
  };
  const originalWorker = { issue: "26", branch: "worker/26", worktreePath: repo, headSha: targetSha, exitCode: 0 };
  const failure = { command: "npm test", result: { code: 1 }, targetSha, sourceSha: targetSha };
  const first = await executeIntegrationCorrection(config, {
    repoPath: repo, sourceRunId, runId: correctionRunId, originalWorker,
    originalValidation: { issue: "26", verdict: "approve" }, failure,
    workerExecutor: async ({ worktree }) => {
      await fs.appendFile(path.join(repo, "behavior.txt"), "attempt one\n");
      git(repo, "add", "behavior.txt");
      git(repo, "commit", "-qm", "attempt one");
      return { issue: "26", branch: worktree.branch, worktreePath: repo, headSha: git(repo, "rev-parse", "HEAD"), exitCode: 0 };
    },
    validatorExecutor: async () => ({ issue: "26", verdict: "rework", exitCode: 0, report: "still failing" })
  });
  const originalDeadline = first.integrationCorrection.deadlineAt;
  const interrupted = await loadRunState(repo, correctionRunId);
  Object.assign(interrupted.integrationCorrection.attempts[0], {
    status: "running", outcome: "running", processId: 2147483647, completedAt: undefined
  });
  interrupted.status = "running";
  interrupted.capacity.issues = ["26"];
  await saveRunState(repo, correctionRunId, interrupted);

  const resumed = await executeIntegrationCorrection({
    ...config, resolution: { maxAttempts: 2, timeoutMs: 60_000 }
  }, {
    repoPath: repo, sourceRunId, originalWorker,
    originalValidation: { issue: "26", verdict: "approve" }, failure,
    workerExecutor: async ({ worktree, timeoutMs }) => {
      assert.ok(timeoutMs > 0 && timeoutMs <= 60_000);
      await fs.appendFile(path.join(repo, "behavior.txt"), "attempt two\n");
      git(repo, "add", "behavior.txt");
      git(repo, "commit", "-qm", "attempt two");
      return { issue: "26", branch: worktree.branch, worktreePath: repo, headSha: git(repo, "rev-parse", "HEAD"), exitCode: 0 };
    },
    validatorExecutor: async () => ({ issue: "26", verdict: "approve", exitCode: 0 })
  });

  assert.equal(resumed.runId, correctionRunId);
  assert.equal(resumed.status, "awaiting-review");
  assert.equal(resumed.integrationCorrection.deadlineAt, originalDeadline);
  assert.equal(resumed.integrationCorrection.attempts[0].status, "interrupted");
  assert.equal(resumed.integrationCorrection.attempts[1].number, 2);
  assert.deepEqual(resumed.capacity.issues, []);
});

test("integration correction rejects a validator-created commit", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-integration-validator-mutation-"));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "worker/26");
  git(repo, "config", "user.name", "Maestro Test");
  git(repo, "config", "user.email", "maestro@example.test");
  await fs.writeFile(path.join(repo, "behavior.txt"), "base\n");
  git(repo, "add", "behavior.txt");
  git(repo, "commit", "-qm", "base");
  const targetSha = git(repo, "rev-parse", "HEAD");

  await assert.rejects(executeIntegrationCorrection({
    repository: "example/repo", resolution: { maxAttempts: 1 }, work: { "26": { status: "ready" } }
  }, {
    repoPath: repo, sourceRunId: "source", runId: "20260920070707-cccccc",
    originalWorker: { issue: "26", branch: "worker/26", worktreePath: repo, headSha: targetSha, exitCode: 0 },
    originalValidation: { verdict: "approve" },
    failure: { command: "npm test", result: { code: 1 }, targetSha, sourceSha: targetSha },
    capacityReserver: async (_config, options) => ({
      reserved: true,
      state: { ...options.existingState, capacity: { issues: ["26"] } }
    }),
    stateSaver: async () => {},
    workerExecutor: async ({ worktree }) => {
      await fs.appendFile(path.join(repo, "behavior.txt"), "correction\n");
      git(repo, "add", "behavior.txt");
      git(repo, "commit", "-qm", "correction");
      return { issue: "26", branch: worktree.branch, worktreePath: repo, headSha: git(repo, "rev-parse", "HEAD"), exitCode: 0 };
    },
    validatorExecutor: async () => {
      await fs.writeFile(path.join(repo, "validator.txt"), "mutation\n");
      git(repo, "add", "validator.txt");
      git(repo, "commit", "-qm", "validator mutation");
      return { issue: "26", verdict: "approve", exitCode: 0 };
    }
  }), /HEAD changed from verified/);
});

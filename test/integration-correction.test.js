const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { executeIntegrationCorrection } = require("../src/integration-correction");

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

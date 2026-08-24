const test = require("node:test");
const assert = require("node:assert/strict");
const { executeRun } = require("../src/controller");

const config = {
  repository: "example/repo",
  defaultConcurrency: 2,
  capabilities: { node: { preflight: "node --version" } },
  work: {
    "1": { status: "ready", requires: ["node"] },
    "2": { status: "ready", requires: ["node"] },
    "3": { status: "ready", blockedBy: ["1"] }
  }
};

test("executeRun preflights once, creates isolated worktrees, runs workers, validates changed branches, and persists the run", async () => {
  const preflightCalls = [];
  const worktreeCalls = [];
  const workerCalls = [];
  const validatorCalls = [];
  const saved = [];
  const result = await executeRun(config, {
    repoPath: "/target",
    runId: "run-1",
    preflightRunner: async (command, options) => {
      preflightCalls.push({ command, options });
      return { code: 0, stdout: "ok", stderr: "" };
    },
    worktreeFactory: async ({ item }) => {
      worktreeCalls.push(item.id);
      return { baseSha: "base", branch: `maestro/${item.id}`, worktreePath: `/wt/${item.id}` };
    },
    workerExecutor: async ({ item, worktree }) => {
      workerCalls.push({ id: item.id, path: worktree.worktreePath });
      return {
        issue: item.id,
        exitCode: 0,
        baseSha: worktree.baseSha,
        headSha: `head-${item.id}`,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        report: "complete"
      };
    },
    validatorExecutor: async ({ worker }) => {
      validatorCalls.push(worker.issue);
      return { issue: worker.issue, exitCode: 0, verdict: "approve" };
    },
    stateSaver: async (repoPath, runId, state) => saved.push({ repoPath, runId, state })
  });

  assert.equal(preflightCalls.length, 1);
  assert.deepEqual(worktreeCalls, ["1", "2"]);
  assert.deepEqual(workerCalls.map((entry) => entry.id), ["1", "2"]);
  assert.deepEqual(validatorCalls, ["1", "2"]);
  assert.deepEqual(result.workers.map((entry) => entry.headSha), ["head-1", "head-2"]);
  assert.deepEqual(result.validations.map((entry) => entry.verdict), ["approve", "approve"]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].runId, "run-1");
  assert.deepEqual(saved[0].state.reviews, {});
});

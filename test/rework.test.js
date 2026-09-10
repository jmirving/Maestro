const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildWorkerPrompt } = require("../src/worker");
const { executeReworkRun } = require("../src/rework");
const { saveRunState } = require("../src/run-store");


test("rework prompt preserves prior implementation and includes validator corrections", () => {
  const prompt = buildWorkerPrompt({
    repository: "example/repo",
    item: { id: "47", mode: "rework", requires: ["node"] },
    correctionContext: {
      sourceRunId: "20260824232553-f60a17",
      priorWorkerReport: "implemented inbox lifecycle",
      validatorReport: "VERDICT: REWORK\nload exact confirmationRequestId"
    }
  });

  assert.match(prompt, /validator-guided rework/);
  assert.match(prompt, /20260824232553-f60a17/);
  assert.match(prompt, /implemented inbox lifecycle/);
  assert.match(prompt, /load exact confirmationRequestId/);
  assert.match(prompt, /do not restart the issue from scratch/i);
  assert.match(prompt, /Mode: rework/);
});

test("a human-gated run marked rework-original can enter rework", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-gate-rework-"));
  const repoPath = path.join(root, "target");
  const sourceRunId = "20260910090909-cccccc";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    mode: "execute",
    status: "awaiting-review",
    workers: [{
      issue: "14",
      exitCode: 0,
      baseSha: "base-old",
      headSha: "head-old",
      branch: "maestro/14",
      worktreePath: "/worktree/14",
      report: "prior implementation"
    }],
    validations: [{ issue: "14", verdict: "human_gate", report: "VERDICT: HUMAN_GATE\nNeeds a decision." }],
    reviews: { "14": { disposition: "rework-original" } }
  });

  const gitCalls = [];
  const result = await executeReworkRun({
    repository: "example/repo",
    work: { "14": { status: "ready" } }
  }, {
    repoPath,
    sourceRunId,
    runId: "20260910101010-dddddd",
    runner: async (_command, args) => {
      gitCalls.push(args);
      return { stdout: args[0] === "rev-parse" ? "base-new\n" : "" };
    },
    workerExecutor: async ({ worktree }) => ({
      issue: "14",
      exitCode: 0,
      ...worktree,
      headSha: "head-new",
      report: "corrected"
    }),
    validatorExecutor: async () => ({ issue: "14", verdict: "approve", exitCode: 0 }),
    stateSaver: async () => {}
  });

  assert.equal(result.workers.length, 1);
  assert.equal(result.validations[0].verdict, "approve");
  assert.ok(gitCalls.some((args) => args[0] === "rebase"));
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildWorkerPrompt } = require("../src/worker");
const { executeReworkRun, resolveIssueReworkSources } = require("../src/rework");
const { saveRunState } = require("../src/run-store");

function parseLeadingJson(stdout) {
  return JSON.parse(stdout.split("\n\nIssue #", 1)[0]);
}


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

test("issue-oriented rework resolves current states and groups diverged source runs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-issue-rework-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const firstId = "20260910010101-aaaaaa";
  const secondId = "20260910020202-bbbbbb";
  await saveRunState(repoPath, firstId, {
    runId: firstId,
    status: "awaiting-review",
    workers: [{ issue: "7", exitCode: 0 }],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: {}
  });
  await saveRunState(repoPath, secondId, {
    runId: secondId,
    parentRunId: firstId,
    status: "awaiting-review",
    workers: [{ issue: "13", exitCode: 0 }],
    validations: [{ issue: "13", verdict: "rework" }],
    reviews: {}
  });

  assert.deepEqual(await resolveIssueReworkSources(repoPath, ["7", "13", "7"]), [
    { sourceRunId: firstId, issueIds: ["7"] },
    { sourceRunId: secondId, issueIds: ["13"] }
  ]);
});

test("issue-oriented rework refuses to revive stale rework evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-stale-rework-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await saveRunState(repoPath, "20260910010101-aaaaaa", {
    runId: "20260910010101-aaaaaa",
    status: "awaiting-review",
    workers: [{ issue: "7", exitCode: 0 }],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: {}
  });
  await saveRunState(repoPath, "20260910020202-bbbbbb", {
    runId: "20260910020202-bbbbbb",
    status: "awaiting-review",
    workers: [{ issue: "7", exitCode: 0 }],
    validations: [{ issue: "7", verdict: "approve" }],
    reviews: {}
  });

  await assert.rejects(
    resolveIssueReworkSources(repoPath, ["7"]),
    /#7 \(awaiting-human-review in run 20260910020202-bbbbbb\)/
  );
});

test("plain rework resolves every current validator rejection in the newest actionable source run", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-plain-rework-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const olderReworkId = "20260910010101-aaaaaa";
  const newestReworkId = "20260910020202-bbbbbb";
  await saveRunState(repoPath, olderReworkId, {
    runId: olderReworkId,
    status: "awaiting-review",
    workers: [{ issue: "5", exitCode: 0 }],
    validations: [{ issue: "5", verdict: "rework" }],
    reviews: {}
  });
  await saveRunState(repoPath, newestReworkId, {
    runId: newestReworkId,
    status: "awaiting-review",
    workers: [{ issue: "7", exitCode: 0 }, { issue: "13", exitCode: 0 }],
    validations: [{ issue: "7", verdict: "rework" }, { issue: "13", verdict: "rework" }],
    reviews: {}
  });
  await saveRunState(repoPath, "20260910030303-cccccc", {
    runId: "20260910030303-cccccc",
    status: "awaiting-review",
    workers: [{ issue: "99", exitCode: 0 }],
    validations: [{ issue: "99", verdict: "approve" }],
    reviews: {}
  });

  assert.deepEqual(await resolveIssueReworkSources(repoPath), [
    { sourceRunId: newestReworkId, issueIds: ["7", "13"] }
  ]);
});

test("plain rework ignores stale rejection evidence and reports when none is actionable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-no-current-rework-"));
  const repoPath = path.join(root, "target");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await saveRunState(repoPath, "20260910010101-aaaaaa", {
    runId: "20260910010101-aaaaaa",
    status: "awaiting-review",
    workers: [{ issue: "7", exitCode: 0 }],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: {}
  });
  await saveRunState(repoPath, "20260910020202-bbbbbb", {
    runId: "20260910020202-bbbbbb",
    status: "awaiting-review",
    workers: [{ issue: "7", exitCode: 0 }],
    validations: [{ issue: "7", verdict: "approve" }],
    reviews: {}
  });

  await assert.rejects(
    resolveIssueReworkSources(repoPath),
    /No currently relevant validator-REWORK issues/
  );
});

test("explicit run issue selection rejects missing, ambiguous, and non-rework evidence before execution", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-explicit-rework-errors-"));
  const repoPath = path.join(root, "target");
  const sourceRunId = "20260910010101-aaaaaa";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    status: "awaiting-review",
    workers: [{ issue: "7", exitCode: 0 }, { issue: "7", exitCode: 0 }, { issue: "13", exitCode: 0 }],
    validations: [{ issue: "7", verdict: "rework" }, { issue: "13", verdict: "approve" }],
    reviews: {}
  });

  const config = { repository: "example/repo", work: {} };
  await assert.rejects(
    executeReworkRun(config, { repoPath, sourceRunId, issueIds: ["404"] }),
    /no worker evidence for issue #404/
  );
  await assert.rejects(
    executeReworkRun(config, { repoPath, sourceRunId, issueIds: ["7"] }),
    /ambiguous worker evidence for issue #7/
  );
  await assert.rejects(
    executeReworkRun(config, { repoPath, sourceRunId, issueIds: ["13"] }),
    /Cannot rework non-REWORK issue state.*#13 \(validator=approve, review=none\)/
  );
});

test("maestro rework executes the latest actionable set without a run ID", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-rework-cli-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  const binPath = path.join(root, "bin");
  const sourceRunId = "20260910010101-aaaaaa";
  await fs.mkdir(repoPath);
  await fs.mkdir(binPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(manifestPath, `${JSON.stringify({
    repository: "example/repo",
    work: { "7": { status: "ready" }, "13": { status: "ready" }, "99": { status: "ready" } }
  })}\n`);
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    status: "awaiting-review",
    workers: ["7", "13"].map((issue) => ({
      issue,
      exitCode: 0,
      baseSha: "base",
      headSha: `head-${issue}`,
      branch: `maestro/${issue}`,
      worktreePath: repoPath,
      report: `prior ${issue}`
    })),
    validations: ["7", "13"].map((issue) => ({ issue, verdict: "rework", report: `fix ${issue}` })),
    reviews: {}
  });
  await saveRunState(repoPath, "20260910020202-bbbbbb", {
    runId: "20260910020202-bbbbbb",
    status: "awaiting-review",
    workers: [{ issue: "99", exitCode: 0 }],
    validations: [{ issue: "99", verdict: "approve" }],
    reviews: {}
  });
  await fs.writeFile(path.join(binPath, "git"), `#!/usr/bin/env node
if (process.argv[2] === "rev-parse") process.stdout.write("base\\n");
`);
  await fs.writeFile(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const index = process.argv.indexOf("--output-last-message");
if (index >= 0) fs.writeFileSync(process.argv[index + 1], "Result: complete\\n");
`);
  await fs.chmod(path.join(binPath, "git"), 0o755);
  await fs.chmod(path.join(binPath, "codex"), 0o755);

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const result = spawnSync(process.execPath, [
    cli, "rework", manifestPath, "--repo-path", repoPath
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.status, 0, result.stderr);
  const rework = parseLeadingJson(result.stdout);
  assert.equal(rework.parentRunId, sourceRunId);
  assert.deepEqual(rework.plan.selected.map((entry) => entry.id), ["7", "13"]);

  const invalid = spawnSync(process.execPath, [
    cli, "rework", "not-an-issue", manifestPath, "--repo-path", repoPath
  ], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid issue number: not-an-issue/);
});

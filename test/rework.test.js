const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildWorkerPrompt } = require("../src/worker");
const {
  executeReworkRun,
  resolveIssueReworkSources,
  autoRework,
  loadCorrectionLineage
} = require("../src/rework");
const { saveRunState, loadRunState, loadPersistedRunStates } = require("../src/run-store");
const { resolveCurrentIssueStates } = require("../src/run-resolver");
const { capacitySnapshot } = require("../src/scheduler");

function parseLeadingJson(stdout) {
  return JSON.parse(stdout.split("\n\nIssue #", 1)[0]);
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

async function autoFixture(t, issues = ["7"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-auto-rework-"));
  const repoPath = path.join(root, "target");
  const sourceRunId = "20260910010101-aaaaaa";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    mode: "execute",
    status: "awaiting-review",
    plan: { selected: issues.map((id) => ({ id })) },
    workers: issues.map((issue) => ({
      issue,
      exitCode: 0,
      baseSha: `base-${issue}`,
      headSha: `head-${issue}`,
      branch: `maestro/${issue}`,
      worktreePath: repoPath,
      report: `worker ${issue}`
    })),
    validations: issues.map((issue) => ({ issue, exitCode: 0, verdict: "rework", report: `fix ${issue}` })),
    reviews: {}
  });
  return {
    repoPath,
    sourceRunId,
    config: { repository: "example/repo", defaultConcurrency: 2, work: Object.fromEntries(issues.map((issue) => [issue, { status: "ready" }])) },
    runner: async (_command, args) => ({ stdout: args[0] === "rev-parse" ? "base-new\n" : "" })
  };
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

test("manual rework records and respects a temporary concurrency bound", async (t) => {
  const fixture = await autoFixture(t, ["7", "8"]);
  const result = await executeReworkRun(fixture.config, {
    repoPath: fixture.repoPath,
    sourceRunId: fixture.sourceRunId,
    runId: "20260910101010-bounded",
    concurrency: { value: 1, source: "this invocation", savedDefault: 2 },
    runner: fixture.runner,
    workerExecutor: async ({ item, worktree }) => ({ issue: item.id, exitCode: 0, ...worktree, headSha: `new-${item.id}` }),
    validatorExecutor: async ({ worker }) => ({ issue: worker.issue, verdict: "approve", exitCode: 0 }),
    stateSaver: async () => {}
  });

  assert.equal(result.plan.concurrency, 1);
  assert.equal(result.plan.concurrencySource, "this invocation");
  assert.deepEqual(result.plan.ready.map((item) => item.id), ["7", "8"]);
  assert.deepEqual(result.plan.selected.map((item) => item.id), ["7"]);
  assert.deepEqual(result.workers.map((item) => item.issue), ["7"]);
});

test("manual rework selection respects advisory conflicts between candidates and active work", async (t) => {
  const fixture = await autoFixture(t, ["7", "8", "9"]);
  fixture.config.work["99"] = { status: "ready" };
  fixture.config.planning = {
    advisoryConflicts: [
      { issues: ["7", "99"], reason: "active overlap", source: "test", confidence: "high" },
      { issues: ["8", "9"], reason: "candidate overlap", source: "test", confidence: "high" }
    ]
  };
  await saveRunState(fixture.repoPath, "20260910100500-acdeff", {
    runId: "20260910100500-acdeff",
    mode: "execute",
    status: "running",
    plan: { selected: [{ id: "99" }] },
    workers: [],
    validations: [],
    reviews: {}
  });

  const result = await executeReworkRun(fixture.config, {
    repoPath: fixture.repoPath,
    sourceRunId: fixture.sourceRunId,
    runId: "20260910101010-conflict-safe",
    concurrency: { value: 3, source: "this invocation", savedDefault: 2 },
    runner: fixture.runner,
    workerExecutor: async ({ item, worktree }) => ({ issue: item.id, exitCode: 0, ...worktree, headSha: `new-${item.id}` }),
    validatorExecutor: async ({ worker }) => ({ issue: worker.issue, verdict: "approve", exitCode: 0 })
  });

  assert.deepEqual(result.plan.selected.map((item) => item.id), ["8"]);
  assert.deepEqual(result.plan.advisoryDeferred.map((item) => [item.id, item.conflictsWith]), [["7", "99"], ["9", "8"]]);
  assert.deepEqual(result.workers.map((item) => item.issue), ["8"]);
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

test("issue-oriented rework accepts a contextual HUMAN_GATE correction decision", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-gate-source-"));
  const repoPath = path.join(root, "target");
  const runId = "20260910030303-cccccc";
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveRunState(repoPath, runId, {
    runId,
    status: "awaiting-review",
    workers: [{ issue: "14", exitCode: 0 }],
    validations: [{ issue: "14", verdict: "human_gate", exitCode: 0, report: "Owner must choose" }],
    reviews: {
      "14": {
        disposition: "rework",
        notes: "Use the owner-approved fallback",
        humanGateResolution: { verdict: "human_gate", exitCode: 0, report: "Owner must choose" }
      }
    }
  });

  assert.deepEqual(await resolveIssueReworkSources(repoPath, ["14"]), [
    { sourceRunId: runId, issueIds: ["14"] }
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
if (process.argv[2] === "rev-parse") process.stdout.write(process.argv[3] === "HEAD" ? "head-new\\n" : "base\\n");
`);
  await fs.writeFile(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const index = process.argv.indexOf("--output-last-message");
if (index >= 0) fs.writeFileSync(process.argv[index + 1], process.argv.includes("read-only") ? "VERDICT: APPROVE\\n" : "Result: complete\\n");
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
  assert.deepEqual(rework.map((entry) => entry.parentRunId), [sourceRunId, sourceRunId]);
  assert.deepEqual(rework.map((entry) => entry.plan.selected[0].id).sort(), ["13", "7"]);

  const invalid = spawnSync(process.execPath, [
    cli, "rework", "not-an-issue", manifestPath, "--repo-path", repoPath
  ], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid issue number: not-an-issue/);
});

test("automatic rework corrects and revalidates until approval while persisting trigger lineage", async (t) => {
  const fixture = await autoFixture(t);
  const verdicts = ["rework", "approve"];
  let workers = 0;
  const result = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    reworkOptions: {
      runner: fixture.runner,
      workerExecutor: async ({ worktree }) => ({ issue: "7", exitCode: 0, ...worktree, headSha: `corrected-${++workers}`, report: "corrected" }),
      validatorExecutor: async () => ({ issue: "7", exitCode: 0, verdict: verdicts.shift(), report: "fresh validation" })
    }
  });

  assert.equal(result.issues[0].outcome, "approved");
  assert.equal(workers, 2);
  const states = await loadPersistedRunStates(fixture.repoPath);
  const children = states.filter((state) => state.mode === "rework");
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((state) => state.correction.attempts["7"].number).sort(), [1, 2]);
  const first = children.find((state) => state.correction.attempts["7"].number === 1);
  const second = children.find((state) => state.correction.attempts["7"].number === 2);
  assert.equal(first.correction.attempts["7"].trigger.verdict, "rework");
  assert.equal(second.correction.attempts["7"].outcome, "approved");
  assert.equal((await loadCorrectionLineage(fixture.repoPath, second.runId, "7")).attempts.length, 2);
});

test("automatic rework stops at HUMAN_GATE and never launches a correction for an existing gate", async (t) => {
  const fixture = await autoFixture(t, ["7", "8"]);
  let calls = 0;
  const first = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    reworkOptions: {
      runner: fixture.runner,
      workerExecutor: async ({ worktree }) => ({ issue: "7", exitCode: 0, ...worktree, headSha: "corrected", report: "needs decision" }),
      validatorExecutor: async () => ({ issue: "7", exitCode: 0, verdict: "human_gate", report: "choose an API" })
    }
  });
  assert.equal(first.issues[0].outcome, "human-gate");

  const gatedRun = await loadRunState(fixture.repoPath, first.issues[0].finalRunId);
  const second = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    reworkExecutor: async () => { calls += 1; }
  });
  assert.equal(gatedRun.validations[0].verdict, "human_gate");
  assert.equal(second.issues[0].outcome, "human-gate");
  assert.equal(calls, 0);
});

test("automatic rework releases a prepared reservation when current evidence is already terminal", async (t) => {
  const fixture = await autoFixture(t);
  const settledRunId = "20260910020202-bbbbbb";
  const reservationRunId = "20260910030303-cccccc";
  await saveRunState(fixture.repoPath, settledRunId, {
    runId: settledRunId,
    parentRunId: fixture.sourceRunId,
    mode: "rework",
    status: "awaiting-review",
    plan: { selected: [{ id: "7", mode: "rework" }] },
    workers: [{ issue: "7", exitCode: 0, baseSha: "head-7", headSha: "approved" }],
    validations: [{ issue: "7", exitCode: 0, verdict: "approve" }],
    reviews: {}
  });
  const [resolved] = await resolveCurrentIssueStates(fixture.repoPath, ["7"]);
  const reservedState = {
    runId: reservationRunId,
    mode: "rework",
    status: "running",
    plan: { selected: [{ id: "7", mode: "rework" }] },
    workers: [],
    validations: [],
    reviews: {},
    capacity: { scope: "repository", limit: 1, issues: ["7"] }
  };
  await saveRunState(fixture.repoPath, reservationRunId, reservedState);
  let workerStarts = 0;

  const result = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    capacity: 1,
    initialReservations: {
      "7": { runId: reservationRunId, reservedState, resolved }
    },
    reworkExecutor: async () => {
      workerStarts += 1;
      throw new Error("worker must not start");
    }
  });

  assert.equal(result.issues[0].outcome, "approved");
  assert.equal(workerStarts, 0);
  const released = await loadRunState(fixture.repoPath, reservationRunId);
  assert.equal(released.status, "cancelled");
  assert.deepEqual(released.capacity.issues, []);
  assert.equal(released.reservationRelease.reason, "current-approved");
  const states = await loadPersistedRunStates(fixture.repoPath);
  assert.equal(capacitySnapshot(fixture.config, states).used, 0);
  assert.equal((await resolveCurrentIssueStates(fixture.repoPath, ["7"]))[0].runId, settledRunId);
});

test("automatic rework exhausts a durable three-attempt budget across child runs and resume", async (t) => {
  const fixture = await autoFixture(t);
  let workers = 0;
  const alwaysRework = {
    runner: fixture.runner,
    workerExecutor: async ({ worktree }) => ({ issue: "7", exitCode: 0, ...worktree, headSha: `corrected-${++workers}`, report: "attempted" }),
    validatorExecutor: async () => ({ issue: "7", exitCode: 0, verdict: "rework", report: "still failing" })
  };
  const first = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    retryLimit: 1,
    reworkOptions: alwaysRework
  });
  assert.equal(first.issues[0].outcome, "retry-exhausted");
  assert.equal(workers, 1);

  const resumed = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    retryLimit: 3,
    reworkOptions: alwaysRework
  });
  assert.equal(resumed.issues[0].outcome, "retry-exhausted");
  assert.equal(resumed.issues[0].attemptsUsed, 3);
  assert.equal(workers, 3);
  const terminal = await loadRunState(fixture.repoPath, resumed.issues[0].finalRunId);
  assert.deepEqual(terminal.autoRework["7"], {
    status: "retry-exhausted",
    retryLimit: 3,
    attemptsUsed: 3,
    finalVerdict: "rework",
    action: "maestro details 7"
  });
});

test("displayed manual rework action resumes after automatic exhaustion without approval or integration", async (t) => {
  const fixture = await autoFixture(t);
  let workers = 0;
  const exhausted = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    retryLimit: 3,
    reworkOptions: {
      runner: fixture.runner,
      workerExecutor: async ({ worktree }) => ({
        issue: "7",
        exitCode: 0,
        ...worktree,
        headSha: `corrected-${++workers}`,
        report: "attempted"
      }),
      validatorExecutor: async () => ({
        issue: "7",
        exitCode: 0,
        verdict: "rework",
        report: "still failing"
      })
    }
  });
  assert.equal(exhausted.issues[0].outcome, "retry-exhausted");
  assert.equal(workers, 3);

  const manifestPath = path.join(fixture.repoPath, ".maestro.json");
  const binPath = path.join(path.dirname(fixture.repoPath), "bin");
  await fs.writeFile(manifestPath, `${JSON.stringify(fixture.config)}\n`);
  await fs.mkdir(binPath);
  await fs.writeFile(path.join(binPath, "git"), `#!/usr/bin/env node
if (process.argv[2] === "rev-parse") process.stdout.write(process.argv[3] === "HEAD" ? "head-manual\\n" : "base-manual\\n");
`);
  await fs.writeFile(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const index = process.argv.indexOf("--output-last-message");
if (index >= 0) fs.writeFileSync(process.argv[index + 1], process.argv.includes("read-only") ? "VERDICT: APPROVE\\n" : "Result: complete\\n");
`);
  await fs.chmod(path.join(binPath, "git"), 0o755);
  await fs.chmod(path.join(binPath, "codex"), 0o755);

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const env = { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` };
  const status = spawnSync(process.execPath, [
    cli, "status", manifestPath, "7", "--repo-path", fixture.repoPath
  ], { encoding: "utf8", env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /`maestro rework 7`/);

  const manual = spawnSync(process.execPath, [
    cli, "rework", manifestPath, "7", "--repo-path", fixture.repoPath
  ], { encoding: "utf8", env });
  assert.equal(manual.status, 0, manual.stderr);
  const child = parseLeadingJson(manual.stdout);
  assert.equal(child.parentRunId, exhausted.issues[0].finalRunId);
  assert.equal(child.correction.attempts["7"].number, 4);
  assert.equal(child.correction.attempts["7"].automatic, false);
  assert.equal(child.validations[0].verdict, "approve");
  assert.deepEqual(child.reviews, {});
  assert.deepEqual(child.integration || [], []);

  const terminal = await loadRunState(fixture.repoPath, exhausted.issues[0].finalRunId);
  assert.equal(terminal.autoRework["7"].status, "retry-exhausted");
  assert.deepEqual(terminal.reviews, {});
  assert.deepEqual(terminal.integration || [], []);
});

test("automatic rework fails safely on worker, validator, and pre-worker refresh failures", async (t) => {
  const workerFixture = await autoFixture(t);
  const workerFailure = await autoRework(workerFixture.config, {
    repoPath: workerFixture.repoPath,
    issueIds: ["7"],
    reworkOptions: {
      runner: workerFixture.runner,
      workerExecutor: async ({ worktree }) => ({ issue: "7", exitCode: 2, ...worktree, headSha: "unchanged", report: "failed" })
    }
  });
  assert.equal(workerFailure.issues[0].outcome, "worker-failure");

  const validatorFixture = await autoFixture(t);
  const validatorFailure = await autoRework(validatorFixture.config, {
    repoPath: validatorFixture.repoPath,
    issueIds: ["7"],
    reworkOptions: {
      runner: validatorFixture.runner,
      workerExecutor: async ({ worktree }) => ({ issue: "7", exitCode: 0, ...worktree, headSha: "changed", report: "done" }),
      validatorExecutor: async () => ({ issue: "7", exitCode: 0, verdict: "invalid", report: "malformed" })
    }
  });
  assert.equal(validatorFailure.issues[0].outcome, "validator-failure");
  const invalidState = await loadRunState(validatorFixture.repoPath, validatorFailure.issues[0].finalRunId);
  assert.equal(invalidState.correction.attempts["7"].outcome, "validator-failure");

  const refreshFixture = await autoFixture(t);
  const refreshFailure = await autoRework(refreshFixture.config, {
    repoPath: refreshFixture.repoPath,
    issueIds: ["7"],
    reworkOptions: { runner: async () => { throw new Error("refresh failed"); } }
  });
  assert.equal(refreshFailure.issues[0].outcome, "infrastructure-failure");
  const refreshState = await loadRunState(refreshFixture.repoPath, refreshFailure.issues[0].finalRunId);
  assert.equal(refreshState.correction.attempts["7"].number, 1);
  assert.equal(refreshState.correction.attempts["7"].phase, "stopped");
  assert.equal(refreshState.correction.attempts["7"].outcome, "infrastructure-failure");
});

test("automatic rework records no-progress when a successful worker creates no commit", async (t) => {
  const fixture = await autoFixture(t, ["7", "8"]);
  let validatorCalls = 0;
  const result = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7", "8"],
    capacity: 2,
    reworkOptions: {
      runner: fixture.runner,
      workerExecutor: async ({ item, worktree }) => ({
        issue: item.id,
        exitCode: 0,
        ...worktree,
        headSha: item.id === "7" ? worktree.baseSha : "corrected-8",
        report: item.id === "7" ? "no new commit" : "corrected"
      }),
      validatorExecutor: async ({ worker }) => {
        validatorCalls += 1;
        return { issue: worker.issue, exitCode: 0, verdict: "approve" };
      }
    }
  });

  assert.equal(validatorCalls, 1);
  assert.deepEqual(result.issues.map((entry) => [entry.issue, entry.outcome]), [["7", "no-progress"], ["8", "approved"]]);
  const state = await loadRunState(fixture.repoPath, result.issues[0].finalRunId);
  assert.deepEqual(state.validations, []);
  assert.equal(state.correction.attempts["7"].outcome, "no-progress");
  assert.equal(state.autoRework["7"].status, "no-progress");

  let resumedCalls = 0;
  const resumed = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    reworkExecutor: async () => { resumedCalls += 1; }
  });
  assert.equal(resumed.issues[0].outcome, "no-progress");
  assert.equal(resumedCalls, 0);
});

test("automatic rework applies one session deadline, persists timeout, and lets an independent sibling finish", async (t) => {
  const fixture = await autoFixture(t, ["7", "8"]);
  const receivedTimeouts = [];
  const result = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7", "8"],
    capacity: 2,
    timeoutMs: 250,
    reworkOptions: {
      runner: fixture.runner,
      workerExecutor: async ({ item, worktree, timeoutMs }) => {
        receivedTimeouts.push(timeoutMs);
        return item.id === "7"
          ? { issue: item.id, exitCode: 1, timedOut: true, ...worktree, headSha: worktree.baseSha, report: "timed out" }
          : { issue: item.id, exitCode: 0, timedOut: false, ...worktree, headSha: "corrected-8", report: "corrected" };
      },
      validatorExecutor: async ({ worker, timeoutMs }) => {
        receivedTimeouts.push(timeoutMs);
        return { issue: worker.issue, exitCode: 0, timedOut: false, verdict: "approve", report: "fresh" };
      }
    }
  });

  assert.deepEqual(result.issues.map((entry) => [entry.issue, entry.outcome]), [["7", "timeout"], ["8", "approved"]]);
  assert.ok(receivedTimeouts.every((value) => value > 0 && value <= 250));
  const timedOut = await loadRunState(fixture.repoPath, result.issues[0].finalRunId);
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.correction.attempts["7"].outcome, "timeout");
  assert.equal(timedOut.correction.attempts["7"].timeoutStage, "worker");
  assert.equal(timedOut.autoRework["7"].status, "timeout");
  assert.equal(timedOut.autoRework["7"].timeoutStage, "worker");

  let resumedCalls = 0;
  const resumed = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    timeoutMs: 250,
    reworkExecutor: async () => { resumedCalls += 1; }
  });
  assert.equal(resumed.issues[0].outcome, "timeout");
  assert.equal(resumedCalls, 0);
});

test("automatic rework distinguishes validator timeout from validator failure", async (t) => {
  const fixture = await autoFixture(t);
  const result = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    timeoutMs: 250,
    reworkOptions: {
      runner: fixture.runner,
      workerExecutor: async ({ worktree }) => ({ issue: "7", exitCode: 0, ...worktree, headSha: "changed", report: "done" }),
      validatorExecutor: async ({ timeoutMs }) => ({ issue: "7", exitCode: 1, timedOut: timeoutMs > 0, verdict: "failed", report: "" })
    }
  });

  assert.equal(result.issues[0].outcome, "timeout");
  const state = await loadRunState(fixture.repoPath, result.issues[0].finalRunId);
  assert.equal(state.correction.attempts["7"].timeoutStage, "validator");
  assert.equal(state.autoRework["7"].timeoutStage, "validator");
});

test("an exhausted session persists timeout before another attempt and resume preserves it", async (t) => {
  const fixture = await autoFixture(t);
  let clockReads = 0;
  let executorCalls = 0;
  const result = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    timeoutMs: 25,
    now: () => clockReads++ === 0 ? 100 : 126,
    reworkExecutor: async () => { executorCalls += 1; }
  });

  assert.equal(result.issues[0].outcome, "timeout");
  assert.equal(result.issues[0].timeoutStage, "session");
  assert.equal(executorCalls, 0);
  const state = await loadRunState(fixture.repoPath, fixture.sourceRunId);
  assert.equal(state.autoRework["7"].status, "timeout");
  assert.equal(state.autoRework["7"].attemptsUsed, 0);
  assert.equal(state.autoRework["7"].timeoutStage, "session");

  const resumed = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7"],
    reworkExecutor: async () => { executorCalls += 1; }
  });
  assert.equal(resumed.issues[0].outcome, "timeout");
  assert.equal(executorCalls, 0);
});

test("semantic rebase ambiguity preserves active conflict evidence and supports explicit human continuation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-rework-conflict-"));
  const repoPath = path.join(root, "target");
  const originPath = path.join(root, "origin.git");
  const sourceRunId = "20260910010101-aaaaaa";
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(repoPath);
  git(root, "init", "--bare", "-q", originPath);
  git(repoPath, "init", "-q", "-b", "main");
  git(repoPath, "config", "user.email", "maestro@example.test");
  git(repoPath, "config", "user.name", "Maestro Test");
  await fs.writeFile(path.join(repoPath, "shared.txt"), "base\n");
  git(repoPath, "add", "shared.txt");
  git(repoPath, "commit", "-q", "-m", "base");
  const baseSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "remote", "add", "origin", originPath);
  git(repoPath, "push", "-q", "-u", "origin", "main");
  git(repoPath, "checkout", "-q", "-b", "maestro/7");
  await fs.writeFile(path.join(repoPath, "shared.txt"), "worker change\n");
  git(repoPath, "commit", "-qam", "worker change");
  const workerHeadSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "checkout", "-q", "main");
  await fs.writeFile(path.join(repoPath, "shared.txt"), "main change\n");
  git(repoPath, "commit", "-qam", "main change");
  git(repoPath, "push", "-q", "origin", "main");
  git(repoPath, "checkout", "-q", "maestro/7");

  await saveRunState(repoPath, sourceRunId, {
    runId: sourceRunId,
    mode: "execute",
    status: "awaiting-review",
    plan: { selected: [{ id: "7" }] },
    workers: [{
      issue: "7",
      exitCode: 0,
      baseSha,
      headSha: workerHeadSha,
      branch: "maestro/7",
      worktreePath: repoPath,
      report: "original implementation"
    }],
    validations: [{ issue: "7", exitCode: 0, verdict: "rework", report: "fix it" }],
    reviews: {}
  });

  let workerCalls = 0;
  const result = await autoRework({
    repository: "example/repo",
    defaultBranch: "main",
    work: { "7": { status: "ready" } }
  }, {
    repoPath,
    issueIds: ["7"],
    reworkOptions: {
      conflictResolver: async () => ({
        status: "human-required",
        exitCode: 0,
        report: "RESOLUTION: HUMAN_REQUIRED\nThe two one-line replacements need a product decision."
      }),
      workerExecutor: async () => {
        workerCalls += 1;
        throw new Error("worker must not start");
      }
    }
  });

  assert.equal(result.issues[0].outcome, "human-required");
  assert.equal(workerCalls, 0);
  const state = await loadRunState(repoPath, result.issues[0].finalRunId);
  const attempt = state.correction.attempts["7"];
  assert.equal(attempt.number, 1);
  assert.equal(attempt.phase, "stopped");
  assert.equal(attempt.outcome, "human-required");
  assert.deepEqual(attempt.conflict.conflictedFiles, ["shared.txt"]);
  assert.equal(attempt.conflict.operation, "rebase");
  assert.equal(attempt.conflict.operationState, "active");
  assert.equal(attempt.conflict.interruptedStage, "rework-refresh");
  assert.equal(attempt.conflict.continuationAction, "maestro rework 7");
  assert.match(attempt.conflict.stderr, /could not apply.*worker change/s);
  assert.equal(attempt.conflict.resolution.status, "human-required");
  assert.match(attempt.conflict.resolution.report, /product decision/);
  assert.equal(state.autoRework["7"].status, "human-required");
  assert.equal(state.autoRework["7"].attemptsUsed, 1);
  assert.equal(state.autoRework["7"].action, "maestro details 7");
  assert.match(git(repoPath, "status", "--porcelain"), /UU shared\.txt/);
  assert.equal(git(repoPath, "rev-parse", "-q", "--verify", "REBASE_HEAD"), workerHeadSha);

  const manualRebase = spawnSync("git", ["rebase", "origin/main"], { cwd: repoPath, encoding: "utf8" });
  assert.notEqual(manualRebase.status, 0, "the recorded conflict should remain reproducible for manual resolution");
  await fs.writeFile(path.join(repoPath, "shared.txt"), "resolved worker and main changes\n");
  git(repoPath, "add", "shared.txt");
  git(repoPath, "-c", "core.editor=true", "rebase", "--continue");

  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.appendFile(path.join(repoPath, ".git", "info", "exclude"), "\n.maestro.json\n");
  await fs.writeFile(manifestPath, `${JSON.stringify({
    repository: "example/repo",
    defaultBranch: "main",
    work: { "7": { status: "ready" } }
  })}\n`);
  const binPath = path.join(root, "bin");
  await fs.mkdir(binPath);
  await fs.writeFile(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const reportIndex = process.argv.indexOf("--output-last-message");
if (process.argv.includes("read-only")) {
  fs.writeFileSync(process.argv[reportIndex + 1], "VERDICT: APPROVE\\nFresh validation passed.\\n");
} else {
  fs.writeFileSync("correction.txt", "validator correction\\n");
  spawnSync("git", ["add", "correction.txt"], { stdio: "inherit" });
  spawnSync("git", ["commit", "-q", "-m", "validator correction"], { stdio: "inherit" });
  fs.writeFileSync(process.argv[reportIndex + 1], "Result: complete\\nCorrection committed.\\n");
}
`);
  await fs.chmod(path.join(binPath, "codex"), 0o755);

  const runCountBeforeRecovery = (await loadPersistedRunStates(repoPath)).length;
  const [displayedExecutable, ...displayedArgs] = attempt.conflict.continuationAction.split(" ");
  assert.equal(displayedExecutable, "maestro");
  const recovery = spawnSync(process.execPath, [
    path.resolve(__dirname, "../bin/maestro.js"), ...displayedArgs
  ], {
    cwd: repoPath,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(recovery.status, 0, recovery.stderr);
  const recovered = parseLeadingJson(recovery.stdout);
  assert.equal(recovered.runId, result.issues[0].finalRunId);
  assert.equal(recovered.parentRunId, sourceRunId);
  assert.equal(recovered.status, "awaiting-review");
  assert.equal(recovered.workers.length, 1);
  assert.equal(recovered.validations[0].verdict, "approve");
  assert.deepEqual(recovered.reviews, {});
  assert.deepEqual(recovered.integration || [], []);
  assert.equal(recovered.correction.attempts["7"].number, 1);
  assert.equal(recovered.correction.attempts["7"].sourceRunId, sourceRunId);
  assert.match(recovery.stdout, /Recommended: `maestro approve 7`/);
  assert.equal((await loadPersistedRunStates(repoPath)).length, runCountBeforeRecovery);

  const preservedConflict = await loadRunState(repoPath, result.issues[0].finalRunId);
  assert.equal(preservedConflict.correction.attempts["7"].outcome, "approved");
  assert.equal(preservedConflict.correction.attempts["7"].conflict.operationState, "manually-resolved");
  assert.equal(preservedConflict.autoRework?.["7"], undefined);

  const runCountAfterRecovery = (await loadPersistedRunStates(repoPath)).length;
  const replay = spawnSync(process.execPath, [
    path.resolve(__dirname, "../bin/maestro.js"), ...displayedArgs
  ], {
    cwd: repoPath,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` }
  });
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /Cannot rework the current workflow state/);
  assert.equal((await loadPersistedRunStates(repoPath)).length, runCountAfterRecovery);
});

test("issue-local automatic rework lets an independent sibling approve after another gates", async (t) => {
  const fixture = await autoFixture(t, ["7", "8"]);
  const result = await autoRework(fixture.config, {
    repoPath: fixture.repoPath,
    issueIds: ["7", "8"],
    capacity: 2,
    reworkOptions: {
      runner: fixture.runner,
      workerExecutor: async ({ item, worktree }) => ({ issue: item.id, exitCode: 0, ...worktree, headSha: `corrected-${item.id}`, report: "corrected" }),
      validatorExecutor: async ({ worker }) => ({
        issue: worker.issue,
        exitCode: 0,
        verdict: worker.issue === "7" ? "human_gate" : "approve",
        report: "fresh"
      })
    }
  });
  assert.deepEqual(result.issues.map((entry) => [entry.issue, entry.outcome]), [
    ["7", "human-gate"],
    ["8", "approved"]
  ]);
});

test("maestro next --auto-rework serializes advisory conflicts and preserves invocation concurrency across resumed corrections", async (t) => {
  const fixture = await autoFixture(t, ["7", "8"]);
  fixture.config.planning = {
    advisoryConflicts: [{ issues: ["7", "8"], reason: "shared files", source: "test", confidence: "high" }]
  };
  const manifestPath = path.join(fixture.repoPath, ".maestro.json");
  const binPath = path.join(path.dirname(fixture.repoPath), "bin");
  const eventPath = path.join(path.dirname(fixture.repoPath), "rework-events.log");
  const validationCountPath = path.join(path.dirname(fixture.repoPath), "validation-count");
  await fs.mkdir(binPath);
  await fs.writeFile(manifestPath, `${JSON.stringify(fixture.config)}\n`);
  await fs.writeFile(path.join(binPath, "git"), `#!/usr/bin/env node
if (process.argv[2] === "rev-parse") process.stdout.write(process.argv[3] === "HEAD" ? "head-new\\n" : "base-new\\n");
`);
  await fs.writeFile(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const index = process.argv.indexOf("--output-last-message");
if (process.argv.includes("read-only")) {
  const countPath = process.env.MAESTRO_TEST_VALIDATION_COUNT;
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
  fs.writeFileSync(countPath, String(count + 1));
  fs.writeFileSync(process.argv[index + 1], count === 0 ? "VERDICT: REWORK\\n" : "VERDICT: APPROVE\\n");
} else {
  fs.appendFileSync(process.env.MAESTRO_TEST_EVENTS, "start\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
  fs.appendFileSync(process.env.MAESTRO_TEST_EVENTS, "finish\\n");
  fs.writeFileSync(process.argv[index + 1], "Result: complete\\n");
}
`);
  await fs.chmod(path.join(binPath, "git"), 0o755);
  await fs.chmod(path.join(binPath, "codex"), 0o755);

  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, "../bin/maestro.js"), "next", "--auto-rework", "-j", "4", "--repo-path", fixture.repoPath
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binPath}${path.delimiter}${process.env.PATH}`,
      MAESTRO_TEST_EVENTS: eventPath,
      MAESTRO_TEST_VALIDATION_COUNT: validationCountPath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = parseLeadingJson(result.stdout);
  assert.deepEqual(output.plan.selected, []);
  assert.deepEqual(output.autoRework.issues.map((entry) => [entry.issue, entry.outcome]), [["7", "approved"], ["8", "approved"]]);
  const children = output.autoRework.issues.flatMap((entry) => entry.runs);
  assert.equal(children.length, 3);
  assert.ok(children.every((child) => child.plan.concurrency === 4));
  assert.ok(children.every((child) => child.plan.concurrencySource === "this invocation"));
  assert.ok(children.every((child) => child.plan.savedDefaultConcurrency === 2));
  assert.ok(children.every((child) => Object.values(child.correction.attempts).every((attempt) => attempt.automatic)));
  assert.deepEqual((await fs.readFile(eventPath, "utf8")).trim().split("\n"), ["start", "finish", "start", "finish", "start", "finish"]);
  assert.match(result.stdout, /Recommended: `maestro approve 7 8`/);
});

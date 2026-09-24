const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { bindValidation } = require("../src/authorization");
const { formatDetails, loadIssueDetails } = require("../src/details");
const { statusSnapshot } = require("../src/display");
const { saveRunState, loadRunState } = require("../src/run-store");
const { executeValidatorRetry } = require("../src/validator-retry");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(t, { validation = {}, mode = "execute", status = "awaiting-review" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-validator-retry-"));
  const repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath);
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.email", "test@example.com");
  git(repoPath, "config", "user.name", "Test");
  await fs.writeFile(path.join(repoPath, "file.txt"), "base\n");
  git(repoPath, "add", "file.txt");
  git(repoPath, "commit", "-m", "base");
  const baseSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "switch", "-c", "maestro/31-source");
  await fs.writeFile(path.join(repoPath, "file.txt"), "implementation\n");
  git(repoPath, "add", "file.txt");
  git(repoPath, "commit", "-m", "implementation");
  const headSha = git(repoPath, "rev-parse", "HEAD");
  const config = {
    repository: "example/repo",
    defaultConcurrency: 2,
    integration: { commands: [] },
    work: { "31": { status: "ready", mode: "execute", requires: [] } }
  };
  const worker = { issue: "31", exitCode: 0, baseSha, headSha, branch: "maestro/31-source", worktreePath: repoPath, report: "implemented" };
  const failed = bindValidation(config, worker, {
    issue: "31", exitCode: 1, verdict: "failed", outputLimitExceeded: true,
    report: "VERDICT: APPROVE\nold invalid attempt", stderr: "old limit", ...validation
  });
  const sourceRunId = "20260923010101-aaaaaa";
  const source = {
    runId: sourceRunId, mode, status, repoPath,
    plan: { concurrency: 2, selected: [{ id: "31" }] },
    baseline: { enabled: true, commands: [], results: [], passing: true, allowFailing: false },
    preflights: [], workers: [worker], validations: [failed], reviews: {}
  };
  await saveRunState(repoPath, sourceRunId, source);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, repoPath, config, worker, failed, source, sourceRunId };
}

function validator(verdict, extra = {}) {
  const calls = [];
  const execute = async (input) => {
    calls.push(input);
    return { issue: input.worker.issue, exitCode: 0, verdict, report: `VERDICT: ${verdict.toUpperCase()}`, ...extra };
  };
  execute.calls = calls;
  return execute;
}

for (const verdict of ["approve", "rework", "human_gate"]) {
  test(`validator infrastructure failure retries the same SHA and produces ${verdict}`, async (t) => {
    const value = await fixture(t);
    const execute = validator(verdict);
    const result = await executeValidatorRetry(value.config, {
      repoPath: value.repoPath, issue: "31", runId: `2026092302020${execute.calls.length + 1}-bbbbbb`, validatorExecutor: execute
    });
    assert.equal(execute.calls.length, 1);
    assert.equal(execute.calls[0].worker.headSha, value.worker.headSha);
    assert.deepEqual(result.worker, value.worker);
    assert.equal(result.validation.verdict, verdict);
    const persisted = await loadRunState(value.repoPath, result.runId);
    assert.equal(persisted.parentRunId, value.sourceRunId);
    assert.equal(persisted.mode, "validator-retry");
    assert.equal(persisted.workers[0].headSha, value.worker.headSha);
    assert.equal(persisted.validationRetry.sourceRunId, value.sourceRunId);
    assert.equal(persisted.validationRetry.reason, "validator diagnostic output limit");
    assert.equal(persisted.correction, undefined);
    assert.equal((await loadRunState(value.repoPath, value.sourceRunId)).validations[0].verdict, "failed");
  });
}

test("retry launches no worker and does not create or charge correction attempts", async (t) => {
  const value = await fixture(t);
  value.source.correction = { rootRunId: "root", attempts: { "31": { number: 2, outcome: "validator-failure" } } };
  value.source.autoRework = { "31": { attemptsUsed: 2, retryLimit: 3, status: "validator-failure" } };
  await saveRunState(value.repoPath, value.sourceRunId, value.source);
  const result = await executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", runId: "20260923020301-bbbbbb", validatorExecutor: validator("approve") });
  const retry = await loadRunState(value.repoPath, result.runId);
  const source = await loadRunState(value.repoPath, value.sourceRunId);
  assert.deepEqual(retry.workers, [value.worker]);
  assert.equal(retry.correction, undefined);
  assert.equal(retry.autoRework, undefined);
  assert.equal(source.correction.attempts["31"].number, 2);
  assert.equal(source.autoRework["31"].attemptsUsed, 2);
});

test("failed source remains inspectable and retry is authoritative for status and details", async (t) => {
  const value = await fixture(t);
  const before = await statusSnapshot(value.config, value.repoPath, ["31"]);
  assert.equal(before.items[0].action, "maestro validate 31 --retry");
  assert.equal(before.recommendations.recommended, "maestro validate 31 --retry");
  const result = await executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", runId: "20260923020401-bbbbbb", validatorExecutor: validator("approve") });
  const status = await statusSnapshot(value.config, value.repoPath, ["31"]);
  assert.equal(status.items[0].validator, "approve");
  assert.equal(status.items[0].group, "awaiting-approval");
  assert.equal(status.recommendations.recommended, "maestro approve 31");
  const text = formatDetails(await loadIssueDetails(value.repoPath, ["31"], { config: value.config }));
  assert.match(text, new RegExp(`Resolved run: ${result.runId}`));
  assert.match(text, new RegExp(`Source run: ${value.sourceRunId}`));
  assert.match(text, /Validator retry provenance:/);
  assert.match(text, /VERDICT: APPROVE/);
  assert.match(text, /old invalid attempt/);
});

test("changed implementation HEAD is refused", async (t) => {
  const value = await fixture(t);
  await fs.writeFile(path.join(value.repoPath, "file.txt"), "changed again\n");
  git(value.repoPath, "add", "file.txt");
  git(value.repoPath, "commit", "-m", "moved");
  await assert.rejects(executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", validatorExecutor: validator("approve") }), /implementation HEAD changed/);
});

test("a superseding run makes old failed implementation ineligible", async (t) => {
  const value = await fixture(t);
  await saveRunState(value.repoPath, "20260923020501-cccccc", {
    runId: "20260923020501-cccccc", parentRunId: value.sourceRunId, mode: "rework", status: "awaiting-review",
    plan: { selected: [{ id: "31" }] }, workers: [{ ...value.worker, headSha: "new-head" }],
    validations: [{ issue: "31", exitCode: 0, verdict: "rework" }], reviews: {}
  });
  await assert.rejects(executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", validatorExecutor: validator("approve") }), /verdict rework is not an infrastructure\/retryable failure/);
});

test("changed acceptance context is refused", async (t) => {
  const value = await fixture(t);
  const changed = structuredClone(value.config);
  changed.work["31"].requires = ["database"];
  await assert.rejects(executeValidatorRetry(changed, { repoPath: value.repoPath, issue: "31", validatorExecutor: validator("approve") }), /target or acceptance context changed/);
});

test("complete issue is refused", async (t) => {
  const value = await fixture(t);
  const complete = structuredClone(value.config);
  complete.work["31"].status = "complete";
  await assert.rejects(executeValidatorRetry(complete, { repoPath: value.repoPath, issue: "31", validatorExecutor: validator("approve") }), /already integrated or complete/);
});

test("active rework ownership is refused", async (t) => {
  const value = await fixture(t);
  await saveRunState(value.repoPath, "20260923020601-dddddd", {
    runId: "20260923020601-dddddd", parentRunId: value.sourceRunId, mode: "rework", status: "running",
    plan: { selected: [{ id: "31" }] }, capacity: { limit: 2, issues: ["31"] }, workers: [], validations: [], reviews: {}
  });
  await assert.rejects(executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", validatorExecutor: validator("approve") }), /current lifecycle ownership is rework-running/);
});

test("ordinary semantic REWORK and HUMAN_GATE are never retryable infrastructure failures", async (t) => {
  for (const verdict of ["rework", "human_gate"]) {
    const value = await fixture(t, { validation: { exitCode: 0, verdict, outputLimitExceeded: false } });
    await assert.rejects(executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", validatorExecutor: validator("approve") }), verdict === "human_gate" ? /semantic human decision/ : /not an infrastructure\/retryable failure/);
  }
});

test("non-fatal diagnostic truncation can approve and remains visible", async (t) => {
  const value = await fixture(t);
  const result = await executeValidatorRetry(value.config, {
    repoPath: value.repoPath, issue: "31", runId: "20260923020701-eeeeee",
    validatorExecutor: validator("approve", { outputTruncated: true, stderrTruncated: true, reportLimitExceeded: false })
  });
  assert.equal(result.validation.verdict, "approve");
  assert.equal(result.validation.outputTruncated, true);
  const text = formatDetails(await loadIssueDetails(value.repoPath, ["31"], { config: value.config }));
  assert.match(text, /Diagnostic output truncated: yes/);
  assert.match(text, /Authoritative report limit exceeded: no/);
});

test("repeating a successful retry is idempotent", async (t) => {
  const value = await fixture(t);
  const execute = validator("approve");
  const first = await executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", runId: "20260923020801-ffffff", validatorExecutor: execute });
  const second = await executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", runId: "20260923020802-ffffff", validatorExecutor: execute });
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.runId, first.runId);
  assert.equal(execute.calls.length, 1);
  await assert.rejects(loadRunState(value.repoPath, "20260923020802-ffffff"), /No Maestro run|ENOENT|no such file/i);
});

test("dirty implementation worktree is refused", async (t) => {
  const value = await fixture(t);
  await fs.writeFile(path.join(value.repoPath, "untracked.txt"), "dirty\n");
  await assert.rejects(executeValidatorRetry(value.config, { repoPath: value.repoPath, issue: "31", validatorExecutor: validator("approve") }), /worktree is dirty/);
});

test("acceptance movement during validation rejects the result and releases capacity", async (t) => {
  const value = await fixture(t);
  const execute = async ({ worker }) => {
    value.config.work["31"].requires = ["database"];
    return { issue: worker.issue, exitCode: 0, verdict: "approve", report: "VERDICT: APPROVE" };
  };
  await assert.rejects(executeValidatorRetry(value.config, {
    repoPath: value.repoPath, issue: "31", runId: "20260923020901-ababab", validatorExecutor: execute
  }), /target or acceptance context changed/);
  const retry = await loadRunState(value.repoPath, "20260923020901-ababab");
  assert.equal(retry.status, "failed");
  assert.deepEqual(retry.capacity.issues, []);
  assert.equal(retry.validations.length, 0);
  assert.equal(retry.validationRetry.outcome, "rejected-stale-result");
});

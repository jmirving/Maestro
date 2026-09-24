const crypto = require("node:crypto");
const { bindValidation, digest, validationContext } = require("./authorization");
const { commitLifecycleTransition } = require("./lifecycle-coordination");
const { runChecked } = require("./process");
const { resolveCurrentIssueStates } = require("./run-resolver");
const { reserveExplicitWork } = require("./scheduler");
const { retryableValidationFailure, validateWorker } = require("./validator");

function validatorRetryRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function scopeRevision(state) {
  return state.authorization?.scope?.revision || null;
}

function fail(message, code = "VALIDATOR_RETRY_INELIGIBLE") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertSourceEligible(config, current) {
  const { issue, state, evidence } = current;
  if (evidence.integration || config.work?.[issue]?.status === "complete") {
    fail(`Cannot retry validation for issue #${issue}; it is already integrated or complete.`);
  }
  if (["running", "rework-running", "technical-conflict"].includes(evidence.state)) {
    fail(`Cannot retry validation for issue #${issue}; current lifecycle ownership is ${evidence.state}.`);
  }
  if (evidence.review || evidence.validation?.verdict === "human_gate") {
    fail(`Cannot retry validation for issue #${issue}; a semantic human decision already exists.`);
  }
  const worker = evidence.worker;
  if (!worker || worker.exitCode !== 0 || !worker.headSha || !worker.baseSha || !worker.branch || !worker.worktreePath) {
    fail(`Cannot retry validation for issue #${issue}; complete successful worker/worktree evidence is missing.`);
  }
  const reason = retryableValidationFailure(evidence.validation);
  if (!reason) {
    const verdict = evidence.validation?.verdict || "missing";
    fail(`Cannot retry validation for issue #${issue}; current validator verdict ${verdict} is not an infrastructure/retryable failure.`);
  }
  if (!evidence.validation.evidence) {
    fail(`Cannot retry validation for issue #${issue}; the failed validator is missing bound implementation/acceptance evidence.`);
  }
  const expected = validationContext(config, worker, issue, scopeRevision(state));
  if (digest(evidence.validation.evidence) !== digest(expected)) {
    fail(`Cannot retry validation for issue #${issue}; the target or acceptance context changed since the failed validation.`);
  }
  return { worker, reason, expected };
}

async function gitText(runner, args, cwd) {
  return (await runner("git", args, { cwd })).stdout.trim();
}

async function verifyPersistedImplementation(worker, runner = runChecked) {
  let head;
  let branch;
  let branchHead;
  let status;
  try {
    [head, branch, branchHead, status] = await Promise.all([
      gitText(runner, ["rev-parse", "HEAD"], worker.worktreePath),
      gitText(runner, ["symbolic-ref", "--short", "HEAD"], worker.worktreePath),
      gitText(runner, ["rev-parse", worker.branch], worker.worktreePath),
      gitText(runner, ["status", "--porcelain", "--untracked-files=normal"], worker.worktreePath)
    ]);
    await gitText(runner, ["cat-file", "-e", `${worker.baseSha}^{commit}`], worker.worktreePath);
  } catch (error) {
    fail(`Cannot retry validation; persisted implementation Git evidence is unavailable or inconsistent: ${error.message}`);
  }
  if (head !== worker.headSha || branchHead !== worker.headSha) {
    fail(`Cannot retry validation; implementation HEAD changed (expected ${worker.headSha}, worktree ${head}, branch ${branchHead}).`);
  }
  if (branch !== worker.branch) fail(`Cannot retry validation; implementation branch changed (expected ${worker.branch}, found ${branch}).`);
  if (status) fail("Cannot retry validation; implementation worktree is dirty.");
  return { headSha: head, branch, baseSha: worker.baseSha, clean: true };
}

function sameCurrent(actual, expected) {
  return actual && String(actual.runId) === String(expected.runId) &&
    actual.evidence?.worker?.headSha === expected.evidence.worker.headSha &&
    digest(actual.evidence?.validation || null) === digest(expected.evidence.validation);
}

async function executeValidatorRetry(config, {
  repoPath,
  issue,
  runId = validatorRetryRunId(),
  validatorExecutor = validateWorker,
  runner = runChecked,
  now = () => new Date(),
  resolver = resolveCurrentIssueStates,
  reserve = reserveExplicitWork,
  transition = commitLifecycleTransition
} = {}) {
  issue = String(issue);
  const [source] = await resolver(repoPath, [issue]);
  if (source.state.mode === "validator-retry" && source.evidence.validation?.verdict !== "failed") {
    return { idempotent: true, issue, runId: source.runId, sourceRunId: source.state.validationRetry?.sourceRunId, worker: source.evidence.worker, validation: source.evidence.validation, retry: source.state.validationRetry };
  }
  const { worker, reason } = assertSourceEligible(config, source);
  await verifyPersistedImplementation(worker, runner);
  const startedAt = now().toISOString();
  const retry = {
    sourceRunId: source.runId,
    sourceValidatorAttempt: source.state.validationRetry?.attempt || 1,
    attempt: (source.state.validationRetry?.attempt || 1) + 1,
    issue,
    implementationSha: worker.headSha,
    baseSha: worker.baseSha,
    acceptanceDigest: source.evidence.validation.evidence.acceptanceDigest,
    reason,
    startedAt
  };
  const reservation = await reserve(config, {
    repoPath,
    runId,
    mode: "validator-retry",
    items: [{ id: issue, ...(config.work?.[issue] || {}), mode: "validate" }],
    expectedCurrent: [{ issue, runId: source.runId }],
    currentEligibility: (actual) => sameCurrent(actual, source),
    extraState: {
      parentRunId: source.runId,
      baseline: source.state.baseline || null,
      preflights: source.state.preflights || [],
      workers: [{ ...worker }],
      validationRetry: retry,
      ...(source.state.scope ? { scope: source.state.scope } : {}),
      ...(source.state.authorization ? { authorization: source.state.authorization } : {})
    },
    beforePersist: async () => verifyPersistedImplementation(worker, runner)
  });
  if (!reservation.reserved) {
    fail(`Cannot reserve validator retry for issue #${issue}: ${reservation.reason}.`, "VALIDATOR_RETRY_RESERVATION_FAILED");
  }

  let rawValidation;
  try {
    rawValidation = await validatorExecutor({ repository: config.repository, worker, baseline: source.state.baseline, runId });
  } catch (error) {
    rawValidation = { issue, exitCode: 1, verdict: "failed", report: "", stderr: error.message, infrastructureFailure: true, failureKind: "validator-execution-error" };
  }
  if (String(rawValidation?.issue) !== issue) {
    rawValidation = {
      issue,
      exitCode: 1,
      verdict: "failed",
      report: rawValidation?.report || "",
      stderr: `Validator returned evidence for issue #${rawValidation?.issue ?? "unknown"}, expected #${issue}.`,
      infrastructureFailure: true,
      failureKind: "validator-evidence-mismatch"
    };
  }
  const validation = bindValidation(config, worker, rawValidation, { scopeRevision: scopeRevision(source.state) });
  const completedAt = now().toISOString();
  try {
    await transition({
      repoPath,
      runId,
      issueIds: [issue],
      beforePersist: async () => {
        const [current] = await resolver(repoPath, [issue]);
        if (String(current.runId) !== String(runId) || current.evidence.worker?.headSha !== worker.headSha) {
          fail(`Cannot attach validator result for issue #${issue}; lifecycle evidence moved during validation.`);
        }
        assertSourceEligible(config, { ...current, state: source.state, evidence: { ...source.evidence, worker } });
        await verifyPersistedImplementation(worker, runner);
        const expected = validationContext(config, worker, issue, scopeRevision(source.state));
        if (digest(validation.evidence) !== digest(expected)) fail(`Cannot attach validator result for issue #${issue}; acceptance context moved during validation.`);
      },
      mutate: (state) => {
        state.status = "awaiting-review";
        state.validations = [validation];
        state.validationRetry = { ...state.validationRetry, completedAt, verdict: validation.verdict, exitCode: validation.exitCode };
        if (state.capacity?.issues) state.capacity.issues = [];
        return state;
      }
    });
  } catch (error) {
    await transition({
      repoPath,
      runId,
      issueIds: [issue],
      mutate: (state) => {
        state.status = "failed";
        state.failure = error.message;
        state.validationRetry = { ...state.validationRetry, completedAt, outcome: "rejected-stale-result" };
        if (state.capacity?.issues) state.capacity.issues = [];
        return state;
      }
    }).catch(() => {});
    throw error;
  }
  return { idempotent: false, issue, runId, sourceRunId: source.runId, worker, validation, retry: { ...retry, completedAt } };
}

function formatValidatorRetry(result) {
  const next = result.validation.verdict === "approve"
    ? `maestro approve ${result.issue}`
    : result.validation.verdict === "rework"
      ? `maestro rework ${result.issue}`
      : result.validation.verdict === "human_gate"
        ? `maestro details ${result.issue}`
        : `maestro validate ${result.issue} --retry`;
  return [
    `Validator retry ${result.idempotent ? "already current" : "completed"} for issue #${result.issue}.`,
    `Implementation: ${result.worker.headSha}`,
    `Source run: ${result.sourceRunId}`,
    `Retry reason: ${result.retry.reason}`,
    `Verdict: ${result.validation.verdict}`,
    `Next: ${next}`
  ].join("\n") + "\n";
}

module.exports = { executeValidatorRetry, formatValidatorRetry, verifyPersistedImplementation };

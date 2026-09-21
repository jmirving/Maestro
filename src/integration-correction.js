const crypto = require("node:crypto");
const { runChecked } = require("./process");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { reserveExplicitWork } = require("./scheduler");
const { saveRunState } = require("./run-store");
const { isAncestor } = require("./git-conflict");

const DEFAULT_ATTEMPT_LIMIT = 3;

function correctionRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function failureReport(failure, previousValidation = null) {
  const result = failure.result || {};
  return [
    "Integration refresh succeeded, but a required combined-code check failed.",
    `Command: ${failure.command || "unknown"}`,
    `Exit code: ${result.code ?? "unknown"}`,
    result.stdout ? `stdout:\n${result.stdout}` : null,
    result.stderr ? `stderr:\n${result.stderr}` : null,
    previousValidation?.report ? `Previous correction validation:\n${previousValidation.report}` : null
  ].filter(Boolean).join("\n\n");
}

async function verifyCorrection(worker, originalHead, targetSha, runner) {
  if (worker.exitCode !== 0) throw new Error(`Integration correction worker exited ${worker.exitCode}.`);
  if (!worker.headSha || worker.headSha === originalHead) {
    const error = new Error("Integration correction made no commit.");
    error.code = "CORRECTION_NO_PROGRESS";
    throw error;
  }
  if (!(await isAncestor(targetSha, worker.headSha, { cwd: worker.worktreePath, runner }))) {
    throw new Error(`Integration correction moved away from the refreshed target ${targetSha}.`);
  }
  const branch = (await runner("git", ["branch", "--show-current"], { cwd: worker.worktreePath })).stdout.trim();
  if (worker.branch && branch !== worker.branch) throw new Error(`Integration correction moved to ${branch || "detached HEAD"}.`);
  const status = (await runner("git", ["status", "--porcelain"], { cwd: worker.worktreePath })).stdout.trim();
  if (status) throw new Error(`Integration correction left residual changes:\n${status}`);
}

async function executeIntegrationCorrection(config, {
  repoPath,
  sourceRunId,
  originalWorker,
  originalValidation,
  failure,
  runId = correctionRunId(),
  runner = runChecked,
  workerExecutor = executeWorker,
  validatorExecutor = validateWorker,
  capacityReserver = reserveExplicitWork,
  stateSaver = saveRunState,
  baseline = null
} = {}) {
  const issue = String(originalWorker.issue);
  const item = { id: issue, ...(config.work?.[issue] || {}), mode: "integration-correction" };
  const reservation = await capacityReserver(config, {
    repoPath,
    runId,
    mode: "integration-correction",
    items: [item],
    expectedCurrent: [{ issue, runId: sourceRunId }],
    extraState: { parentRunId: sourceRunId }
  });
  if (!reservation.reserved) {
    throw new Error(`Cannot reserve worker capacity for integration correction: ${reservation.reason}.`);
  }
  const state = Object.assign(reservation.state, {
    runId,
    parentRunId: sourceRunId,
    mode: "integration-correction",
    status: "running",
    repoPath,
    workers: [],
    validations: [],
    reviews: {},
    integrationCorrection: {
      issue,
      sourceRunId,
      trigger: {
        command: failure.command,
        code: failure.result?.code ?? null,
        stdout: failure.result?.stdout || "",
        stderr: failure.result?.stderr || "",
        targetSha: failure.targetSha,
        sourceSha: failure.sourceSha
      },
      deadlineAt: Date.now() + (config.resolution?.timeoutMs || 30 * 60 * 1000),
      attempts: []
    }
  });
  await stateSaver(repoPath, runId, state);

  const limit = config.resolution?.maxAttempts || DEFAULT_ATTEMPT_LIMIT;
  let previousHead = failure.sourceSha || originalWorker.headSha;
  let previousValidation = originalValidation;
  try {
    for (let number = 1; number <= limit; number += 1) {
      const remainingMs = state.integrationCorrection.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        state.status = "failed";
        state.integrationCorrection.outcome = "timeout";
        break;
      }
      const attempt = { number, chargedAt: new Date().toISOString(), phase: "worker", outcome: "running" };
      state.integrationCorrection.attempts.push(attempt);
      await stateSaver(repoPath, runId, state);
      const worker = await workerExecutor({
        repository: config.repository,
        item,
        worktree: {
          worktreePath: originalWorker.worktreePath,
          branch: originalWorker.branch,
          baseSha: failure.targetSha
        },
        runId,
        correctionContext: {
          sourceRunId,
          priorWorkerReport: originalWorker.report || "",
          validatorReport: failureReport(failure, previousValidation)
        },
        timeoutMs: remainingMs
      });
      attempt.worker = worker;
      if (worker.timedOut) {
        attempt.outcome = "timeout";
        state.status = "failed";
        state.integrationCorrection.outcome = "timeout";
        state.workers = [worker];
        break;
      }
      await verifyCorrection(worker, previousHead, failure.targetSha, runner);
      attempt.phase = "validation";
      await stateSaver(repoPath, runId, state);
      const validation = await validatorExecutor({
        repository: config.repository,
        worker,
        baseline,
        runId,
        timeoutMs: Math.max(1, state.integrationCorrection.deadlineAt - Date.now())
      });
      attempt.validation = validation;
      attempt.outcome = validation.verdict;
      previousHead = worker.headSha;
      previousValidation = validation;
      state.workers = [worker];
      state.validations = [validation];
      await stateSaver(repoPath, runId, state);
      if (validation.timedOut) {
        state.status = "failed";
        state.integrationCorrection.outcome = "timeout";
        break;
      }
      if (validation.verdict === "approve" && validation.exitCode === 0) {
        state.status = "awaiting-review";
        state.integrationCorrection.outcome = "approved";
        if (state.capacity?.issues) state.capacity.issues = [];
        await stateSaver(repoPath, runId, state);
        return state;
      }
      if (validation.verdict === "human_gate") {
        state.status = "human-required";
        state.integrationCorrection.outcome = "human-required";
        break;
      }
      if (validation.verdict !== "rework" || validation.exitCode !== 0) {
        state.status = "failed";
        state.integrationCorrection.outcome = "validator-failure";
        break;
      }
    }
    if (state.status === "running") {
      state.status = "failed";
      state.integrationCorrection.outcome = "retry-exhausted";
    }
    state.failure = `Integration correction stopped: ${state.integrationCorrection.outcome}.`;
    if (state.capacity?.issues) state.capacity.issues = [];
    await stateSaver(repoPath, runId, state);
    return state;
  } catch (error) {
    state.status = "failed";
    state.integrationCorrection.outcome = error.code === "CORRECTION_NO_PROGRESS" ? "no-progress" : "infrastructure-failure";
    state.failure = error.message;
    if (state.capacity?.issues) state.capacity.issues = [];
    await stateSaver(repoPath, runId, state);
    throw error;
  }
}

module.exports = { failureReport, verifyCorrection, executeIntegrationCorrection };

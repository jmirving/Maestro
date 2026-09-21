const crypto = require("node:crypto");
const { runChecked } = require("./process");
const { executeWorker } = require("./worker");
const { validateWorker } = require("./validator");
const { reserveExplicitWork, withCapacityLock } = require("./scheduler");
const { loadRunState, loadPersistedRunStates, saveRunState } = require("./run-store");
const { isAncestor } = require("./git-conflict");
const {
  DEFAULT_RECOVERY_ATTEMPT_LIMIT,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  ensureRecoveryContract,
  interruptExitedAttempt,
  nextRecoveryAttempt,
  assertRecoveryAvailable
} = require("./recovery-attempts");

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
  const headSha = (await runner("git", ["rev-parse", "HEAD"], { cwd: worker.worktreePath })).stdout.trim();
  if (headSha !== worker.headSha) {
    throw new Error(`Integration correction HEAD changed from verified ${worker.headSha} to ${headSha}.`);
  }
  const status = (await runner("git", ["status", "--porcelain"], { cwd: worker.worktreePath })).stdout.trim();
  if (status) throw new Error(`Integration correction left residual changes:\n${status}`);
}

async function findContinuableCorrection(repoPath, { runId, sourceRunId, issue }) {
  if (runId) {
    return loadRunState(repoPath, runId).catch((error) =>
      error.code === "ENOENT" || /No Maestro run/.test(error.message) ? null : Promise.reject(error));
  }
  const states = await loadPersistedRunStates(repoPath).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  return states.filter((state) =>
    state.mode === "integration-correction" &&
    String(state.parentRunId) === String(sourceRunId) &&
    String(state.integrationCorrection?.issue) === String(issue) &&
    state.status === "running"
  ).sort((left, right) => String(left.runId).localeCompare(String(right.runId))).at(-1) || null;
}

async function executeIntegrationCorrection(config, {
  repoPath,
  sourceRunId,
  originalWorker,
  originalValidation,
  failure,
  runId = null,
  runner = runChecked,
  workerExecutor = executeWorker,
  validatorExecutor = validateWorker,
  capacityReserver = reserveExplicitWork,
  stateSaver = saveRunState,
  baseline = null
} = {}) {
  const issue = String(originalWorker.issue);
  const item = { id: issue, ...(config.work?.[issue] || {}), mode: "integration-correction" };
  let state = await findContinuableCorrection(repoPath, { runId, sourceRunId, issue });
  if (state && state.status !== "running") return state;
  const resuming = Boolean(state);
  runId = state?.runId || runId || correctionRunId();
  const timeoutMs = config.resolution?.timeoutMs || DEFAULT_RECOVERY_TIMEOUT_MS;
  const trigger = {
    command: failure.command,
    code: failure.result?.code ?? null,
    stdout: failure.result?.stdout || "",
    stderr: failure.result?.stderr || "",
    targetSha: failure.targetSha,
    sourceSha: failure.sourceSha
  };
  state = state || {
    runId,
    parentRunId: sourceRunId,
    mode: "integration-correction",
    status: "running",
    repoPath,
    workers: [],
    validations: [],
    reviews: {},
    integrationCorrection: ensureRecoveryContract(null, {
      kind: "integration-regression",
      issue,
      timeoutMs,
      sourceRunId,
      trigger
    })
  };
  state.integrationCorrection = ensureRecoveryContract(state.integrationCorrection, {
    kind: "integration-regression", issue, timeoutMs, sourceRunId, trigger
  });

  const releaseCapacity = async () => {
    const release = async () => {
      if (state.capacity?.issues) {
        state.capacity.issues = [];
        state.capacity.releasedAt = new Date().toISOString();
      }
      await stateSaver(repoPath, runId, state);
    };
    if (stateSaver === saveRunState) await withCapacityLock(repoPath, release);
    else await release();
  };

  if (resuming) {
    const interrupted = interruptExitedAttempt(state.integrationCorrection);
    if (interrupted) {
      state.failure = `Integration correction attempt ${interrupted.number} was interrupted; its charge is retained.`;
      await releaseCapacity();
    }
  }

  const limit = config.resolution?.maxAttempts || DEFAULT_RECOVERY_ATTEMPT_LIMIT;
  let remainingMs;
  try {
    remainingMs = assertRecoveryAvailable(state.integrationCorrection, {
      attemptLimit: limit,
      label: "Integration correction"
    });
  } catch (error) {
    state.status = "failed";
    state.integrationCorrection.outcome = error.code === "RECOVERY_TIMEOUT" ? "timeout" : "retry-exhausted";
    state.failure = error.message;
    await releaseCapacity();
    return state;
  }

  let pendingAttempt;
  const reservation = await capacityReserver(config, {
    repoPath,
    runId,
    mode: "integration-correction",
    items: [item],
    expectedCurrent: [{ issue, runId: resuming ? runId : sourceRunId }],
    currentEligibility: resuming ? (current) => String(current.runId) === String(runId) : null,
    existingState: state,
    extraState: { parentRunId: sourceRunId },
    beforePersist: ({ state: persisted }) => {
      pendingAttempt = nextRecoveryAttempt(persisted.integrationCorrection, { phase: "worker", status: "running" });
      persisted.status = "running";
      delete persisted.failure;
    }
  });
  if (!reservation.reserved) {
    throw new Error(`Cannot reserve worker capacity for integration correction: ${reservation.reason}.`);
  }
  state = reservation.state;
  state.workers = state.workers || [];
  state.validations = state.validations || [];
  state.reviews = state.reviews || {};
  if (!state.integrationCorrection) state.integrationCorrection = ensureRecoveryContract(null, {
    kind: "integration-regression", issue, timeoutMs, sourceRunId, trigger
  });
  if (!pendingAttempt) {
    pendingAttempt = nextRecoveryAttempt(state.integrationCorrection, { phase: "worker", status: "running" });
    await stateSaver(repoPath, runId, state);
  }

  let previousHead = state.workers?.[0]?.headSha || failure.sourceSha || originalWorker.headSha;
  let previousValidation = state.validations?.[0] || originalValidation;
  try {
    for (;;) {
      const attempt = pendingAttempt;
      remainingMs = Math.max(1, state.integrationCorrection.deadlineAt - Date.now());
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
      attempt.status = "validation";
      if (worker.timedOut) {
        attempt.status = "completed";
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
      await verifyCorrection(worker, previousHead, failure.targetSha, runner);
      attempt.validation = validation;
      attempt.status = "completed";
      attempt.completedAt = new Date().toISOString();
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
        await releaseCapacity();
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
      try {
        assertRecoveryAvailable(state.integrationCorrection, {
          attemptLimit: limit,
          label: "Integration correction"
        });
      } catch (error) {
        state.status = "failed";
        state.integrationCorrection.outcome = error.code === "RECOVERY_TIMEOUT" ? "timeout" : "retry-exhausted";
        break;
      }
      pendingAttempt = nextRecoveryAttempt(state.integrationCorrection, { phase: "worker", status: "running" });
      await stateSaver(repoPath, runId, state);
    }
    if (state.status === "running") {
      state.status = "failed";
      state.integrationCorrection.outcome = "retry-exhausted";
    }
    state.failure = `Integration correction stopped: ${state.integrationCorrection.outcome}.`;
    await releaseCapacity();
    return state;
  } catch (error) {
    if (pendingAttempt && pendingAttempt.status !== "completed") {
      pendingAttempt.status = "failed";
      pendingAttempt.outcome = "infrastructure-failure";
      pendingAttempt.completedAt = new Date().toISOString();
      pendingAttempt.stderr = error.message;
    }
    state.status = "failed";
    state.integrationCorrection.outcome = error.code === "CORRECTION_NO_PROGRESS" ? "no-progress" : "infrastructure-failure";
    state.failure = error.message;
    await releaseCapacity();
    throw error;
  }
}

module.exports = { failureReport, verifyCorrection, executeIntegrationCorrection };

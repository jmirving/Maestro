const DEFAULT_RECOVERY_ATTEMPT_LIMIT = 3;
const DEFAULT_RECOVERY_TIMEOUT_MS = 30 * 60 * 1000;

function processIsRunning(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function ensureRecoveryContract(existing, {
  kind,
  issue,
  timeoutMs = DEFAULT_RECOVERY_TIMEOUT_MS,
  now = Date.now,
  ...evidence
} = {}) {
  if (existing) {
    existing.attempts = existing.attempts || [];
    return existing;
  }
  return {
    contractVersion: 1,
    kind,
    issue: issue == null ? null : String(issue),
    deadlineAt: now() + timeoutMs,
    attempts: [],
    ...evidence
  };
}

function interruptExitedAttempt(contract, { now = Date.now } = {}) {
  const attempt = contract?.attempts?.at(-1);
  if (!attempt || !["running", "worker", "validation"].includes(attempt.status)) return null;
  if (processIsRunning(attempt.processId)) {
    const error = new Error(`Recovery attempt ${attempt.number} is still running in process ${attempt.processId}.`);
    error.code = "RECOVERY_ATTEMPT_RUNNING";
    throw error;
  }
  Object.assign(attempt, {
    status: "interrupted",
    outcome: "interrupted",
    completedAt: new Date(now()).toISOString(),
    failureKind: "recovery-process-exited",
    stderr: attempt.stderr || "The recovery process exited without recording a result."
  });
  return attempt;
}

function remainingRecoveryMs(contract, { now = Date.now } = {}) {
  return Math.max(0, Number(contract.deadlineAt) - now());
}

async function runWithinRecoveryDeadline(contract, start, {
  label = "Recovery operation",
  now = Date.now
} = {}) {
  const remainingMs = remainingRecoveryMs(contract, { now });
  if (remainingMs <= 0) {
    const error = new Error(`${label} time budget exhausted.`);
    error.code = "RECOVERY_TIMEOUT";
    throw error;
  }
  let timer;
  try {
    return await Promise.race([
      start(remainingMs),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${remainingMs}ms.`);
          error.code = "RECOVERY_TIMEOUT";
          reject(error);
        }, remainingMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nextRecoveryAttempt(contract, {
  phase,
  status = "running",
  now = Date.now
} = {}) {
  const attempt = {
    number: contract.attempts.length + 1,
    chargedAt: new Date(now()).toISOString(),
    status,
    phase,
    outcome: "running",
    processId: process.pid
  };
  contract.attempts.push(attempt);
  return attempt;
}

function assertRecoveryAvailable(contract, {
  attemptLimit = DEFAULT_RECOVERY_ATTEMPT_LIMIT,
  label = "Recovery",
  now = Date.now
} = {}) {
  if (contract.attempts.length >= attemptLimit) {
    const error = new Error(`${label} attempt limit (${attemptLimit}) exhausted.`);
    error.code = "RECOVERY_ATTEMPTS_EXHAUSTED";
    throw error;
  }
  const remainingMs = remainingRecoveryMs(contract, { now });
  if (remainingMs <= 0) {
    const error = new Error(`${label} time budget exhausted.`);
    error.code = "RECOVERY_TIMEOUT";
    throw error;
  }
  return remainingMs;
}

module.exports = {
  DEFAULT_RECOVERY_ATTEMPT_LIMIT,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  processIsRunning,
  ensureRecoveryContract,
  interruptExitedAttempt,
  remainingRecoveryMs,
  runWithinRecoveryDeadline,
  nextRecoveryAttempt,
  assertRecoveryAvailable
};

const crypto = require("node:crypto");
const { runChecked } = require("./process");

const CONTRACT_VERSION = 1;
const SETUP_FAILURE_STAGES = new Set(["preflight", "baseline"]);
const LIFECYCLE_MODES = new Set(["rework", "reconcile"]);

function acceptanceDigest(config, items) {
  const acceptance = {
    repository: config.repository || null,
    defaultBranch: config.defaultBranch || "main",
    baseline: config.baseline || null,
    integrationCommands: config.integration?.commands || [],
    capabilities: config.capabilities || {},
    validation: config.validation || null,
    resolution: config.resolution || null,
    items: (items || []).map((item) => ({
      id: String(item.id),
      requires: item.requires || []
    })).sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
  };
  return crypto.createHash("sha256").update(JSON.stringify(acceptance)).digest("hex");
}

function createSetupCheckpoint({ mode, config, items, workers, sourceRunId, attemptIdentity }) {
  if (!LIFECYCLE_MODES.has(mode)) throw new Error(`Unsupported setup-resume lifecycle mode: ${mode}.`);
  const expected = {};
  for (const worker of workers || []) {
    expected[String(worker.issue)] = {
      issue: String(worker.issue),
      worktreePath: worker.worktreePath || null,
      branch: worker.branch || null,
      implementationSha: worker.headSha || null,
      baseSha: worker.baseSha || null,
      targetBranch: config.defaultBranch || "main"
    };
  }
  return {
    contractVersion: CONTRACT_VERSION,
    mode,
    sourceRunId: String(sourceRunId),
    attemptIdentity,
    acceptanceDigest: acceptanceDigest(config, items),
    stage: "reserved",
    completed: { preflight: false, baseline: false, refresh: false },
    execution: { workerStarted: false, resolverStarted: false, validatorStarted: false },
    expected,
    history: []
  };
}

async function captureExpectedSetupState(setup, { runner = runChecked } = {}) {
  for (const expected of Object.values(setup.expected || {})) {
    const options = { cwd: expected.worktreePath };
    expected.implementationSha = (await runner("git", ["rev-parse", "HEAD"], options)).stdout.trim() || expected.implementationSha;
    expected.branch = (await runner("git", ["branch", "--show-current"], options)).stdout.trim() || expected.branch;
    const status = (await runner("git", ["status", "--porcelain"], options)).stdout.trim();
    if (status) {
      throw new Error(
        `Cannot establish safe setup checkpoint for issue #${expected.issue}: ` +
        "worktree is dirty."
      );
    }
  }
  return setup;
}

function recordSetupFailure(state, error, stage) {
  const setup = state.setup;
  if (!setup) return;
  setup.stage = stage;
  setup.failure = {
    stage,
    code: error.code || (stage === "preflight" ? "PREFLIGHT_FAILED" : "SETUP_FAILED"),
    message: error.message,
    recordedAt: new Date().toISOString()
  };
}

function archiveSetupFailure(state) {
  const setup = state.setup;
  if (!setup?.failure) return;
  setup.history ||= [];
  setup.history.push({ ...setup.failure });
  delete setup.failure;
}

function expectedEntriesAreComplete(setup, issueIds) {
  if (!setup?.expected || typeof setup.expected !== "object") return false;
  return issueIds.every((issue) => {
    const expected = setup.expected[String(issue)];
    return expected && expected.worktreePath && expected.branch && expected.implementationSha;
  });
}

function isSafelyResumableSetupFailure(state, { issueIds = null } = {}) {
  const setup = state?.setup;
  const issues = issueIds?.map(String) || (state?.plan?.selected || []).map((item) => String(item.id));
  if (
    !LIFECYCLE_MODES.has(state?.mode) ||
    state?.status !== "failed" ||
    setup?.contractVersion !== CONTRACT_VERSION ||
    setup.mode !== state.mode ||
    !setup.sourceRunId ||
    !setup.attemptIdentity ||
    !issues.length ||
    !SETUP_FAILURE_STAGES.has(state.failureStage) ||
    setup.stage !== state.failureStage ||
    setup.failure?.stage !== state.failureStage ||
    setup.failure?.code !== state.failureCode ||
    setup.execution?.workerStarted !== false ||
    setup.execution?.resolverStarted !== false ||
    setup.execution?.validatorStarted !== false ||
    (state.workers || []).length !== 0 ||
    (state.validations || []).length !== 0 ||
    !expectedEntriesAreComplete(setup, issues)
  ) return false;

  if (state.mode === "rework") {
    return issues.every((issue) => {
      const attempt = state.correction?.attempts?.[issue];
      return attempt && Number.isInteger(attempt.number) && attempt.number > 0 &&
        String(attempt.sourceRunId) === String(setup.sourceRunId) &&
        attempt.phase === "stopped" &&
        ["infrastructure-failure", "timeout"].includes(attempt.outcome) &&
        attempt.failureStage === state.failureStage &&
        attempt.failureCode === state.failureCode &&
        attempt.workerExecution?.status === "not-started";
    });
  }

  return state.mode === "reconcile" &&
    String(state.parentRunId) === String(setup.sourceRunId) &&
    String(state.recovery?.sessionId) === String(setup.attemptIdentity);
}

async function verifySetupResume(config, state, { runner = runChecked } = {}) {
  const issues = (state.plan?.selected || []).map((item) => String(item.id));
  if (!isSafelyResumableSetupFailure(state, { issueIds: issues })) {
    throw new Error(`Run ${state.runId} does not contain explicit, side-effect-free setup failure evidence.`);
  }
  const currentDigest = acceptanceDigest(config, state.plan.selected || []);
  if (currentDigest !== state.setup.acceptanceDigest) {
    throw new Error(`Run ${state.runId} setup acceptance context changed; refusing to resume stale setup evidence.`);
  }
  for (const issue of issues) {
    const expected = state.setup.expected[issue];
    const options = { cwd: expected.worktreePath };
    const head = (await runner("git", ["rev-parse", "HEAD"], options)).stdout.trim();
    const branch = (await runner("git", ["branch", "--show-current"], options)).stdout.trim();
    const status = (await runner("git", ["status", "--porcelain"], options)).stdout.trim();
    if (head !== expected.implementationSha || branch !== expected.branch || status) {
      throw new Error(
        `Run ${state.runId} cannot resume setup for issue #${issue}: expected ` +
        `${expected.branch}@${expected.implementationSha} in ${expected.worktreePath}, found ` +
        `${branch || "detached HEAD"}@${head}${status ? " with a dirty worktree" : ""}.`
      );
    }
  }
  return true;
}

module.exports = {
  CONTRACT_VERSION,
  SETUP_FAILURE_STAGES,
  acceptanceDigest,
  createSetupCheckpoint,
  captureExpectedSetupState,
  recordSetupFailure,
  archiveSetupFailure,
  isSafelyResumableSetupFailure,
  verifySetupResume
};

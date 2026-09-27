const crypto = require("node:crypto");
const path = require("node:path");
const {
  newSession,
  loadSession,
  listSessions,
  saveSession,
  claimSession,
  updateOwnedSession,
  releaseSession,
  requestSessionControl
} = require("./session-store");
const { digest, loadAuthorization } = require("./authorization");
const { coordinatedRepoPath } = require("./reporter");

const DEFAULT_LIMITS = Object.freeze({ maxCycles: 20, maxRuntimeMs: 60 * 60 * 1000, maxNoProgressCycles: 2 });

function newSessionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `session-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function checkpoint(kind, details = {}, now = new Date()) {
  return { kind, at: now.toISOString(), ...details };
}

function normalizedSettings(settings = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(settings.limits || {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Autonomous setting ${name} must be a positive integer.`);
  }
  const concurrency = Number(settings.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Autonomous setting concurrency must be a positive integer.");
  return { concurrency, correction: settings.correction || {}, limits };
}

async function createSession({ config, repoPath, manifestPath, scope, authorization, settings, id = newSessionId(), now = new Date() }) {
  if (authorization?.kind !== "delegated" || authorization.status !== "active") {
    throw new Error("An autonomous session requires an active persisted delegated authorization.");
  }
  const issueIds = scope.issueIds.map(String);
  if (digest(issueIds.slice().sort()) !== digest(authorization.scope.issueIds.map(String).sort()) || scope.revision !== authorization.scope.revision) {
    throw new Error("Autonomous session scope must exactly match its delegated authorization.");
  }
  const session = newSession({
    id,
    repository: config.repository,
    repoPath,
    manifestPath,
    targetBranch: config.defaultBranch || "main",
    scope: { ...scope, issueIds },
    authorization,
    settings: normalizedSettings(settings),
    now
  });
  await saveSession(repoPath, session, { create: true });
  return session;
}

async function verifySessionContext({ session, config, repoPath, manifestPath, authorizationLoader = loadAuthorization }) {
  const mismatches = [];
  if (session.repository !== config.repository) mismatches.push("repository identity changed");
  if (session.repositoryRoot !== coordinatedRepoPath(repoPath)) mismatches.push("coordinated checkout changed");
  if (session.manifestPath !== path.resolve(manifestPath)) mismatches.push("manifest path changed");
  if (session.targetBranch !== (config.defaultBranch || "main")) mismatches.push("target branch changed");
  let authorization;
  try { authorization = await authorizationLoader(repoPath, session.authorization.id); } catch (error) {
    mismatches.push(error.message);
  }
  if (authorization) {
    if (authorization.status !== "active") mismatches.push(`authorization is ${authorization.status}`);
    if (authorization.policyDigest !== session.authorization.policyDigest) mismatches.push("authorization policy changed");
    if (authorization.scope?.revision !== session.scope.revision) mismatches.push("scope revision changed");
    if (digest((authorization.scope?.issueIds || []).map(String).sort()) !== digest(session.scope.issueIds.slice().sort())) mismatches.push("authorized membership changed");
  }
  if (mismatches.length) {
    const error = new Error(`Cannot resume Maestro session ${session.id}: ${mismatches.join("; ")}. Renew authorization or intentionally start a new session.`);
    error.code = "SESSION_CONTEXT_DRIFT";
    throw error;
  }
  return authorization;
}

function matchesSelector(session, selector = {}) {
  if (selector.sessionId) return session.id === selector.sessionId;
  if (selector.workset) return session.scope.type === "workset" && session.scope.workset === selector.workset;
  if (selector.issue) return session.scope.issueIds.includes(String(selector.issue));
  return false;
}

async function resolveSession(repoPath, selector) {
  if (selector?.sessionId) return loadSession(repoPath, selector.sessionId);
  if (!selector?.workset && !selector?.issue) throw new Error("Resume requires a session id, workset name, or issue number; Maestro will not guess the latest session.");
  const matches = (await listSessions(repoPath)).filter((session) => matchesSelector(session, selector) && !["complete", "stopped"].includes(session.status));
  if (!matches.length) throw new Error("No resumable Maestro session matches that scope.");
  if (matches.length > 1) throw new Error(`More than one resumable Maestro session matches that scope: ${matches.map((entry) => entry.id).join(", ")}. Select one explicitly.`);
  return matches[0];
}

function terminalReport(observation = {}) {
  const unresolved = (observation.unresolved || []).map((entry) => ({
    issue: String(entry.issue),
    reason: entry.reason,
    nextAction: entry.nextAction || null
  }));
  return {
    verifiedComplete: observation.verifiedComplete === true,
    unresolved,
    remainingIssueIds: (observation.remainingIssueIds || unresolved.map((entry) => entry.issue)).map(String),
    nextAction: observation.nextAction || unresolved.find((entry) => entry.nextAction)?.nextAction || "maestro status"
  };
}

function requestedControl(session) {
  if (!session.controlRequest) return null;
  const action = session.controlRequest.action;
  return {
    status: action === "pause" ? "paused" : "stopped",
    stopReason: action === "pause" ? "user-paused" : "user-stopped"
  };
}

function exhaustedBudgetReason(session, startedAt, currentTime) {
  if ((session.cycles || 0) >= session.settings.limits.maxCycles) return "max-cycles";
  if (currentTime.getTime() - startedAt >= session.settings.limits.maxRuntimeMs) return "max-runtime";
  if ((session.progress?.noProgressCycles || 0) >= session.settings.limits.maxNoProgressCycles) return "no-progress-limit";
  return null;
}

async function driveSession({
  config,
  repoPath,
  manifestPath,
  session: suppliedSession = null,
  sessionId = null,
  observe,
  advance,
  finalize = null,
  now = () => new Date()
}) {
  if (typeof observe !== "function" || typeof advance !== "function") throw new Error("Autonomous controller requires observe and advance lifecycle services.");
  const source = suppliedSession || await loadSession(repoPath, sessionId);
  await verifySessionContext({ session: source, config, repoPath, manifestPath });
  const { session: claimed, token } = await claimSession(repoPath, source.id, { now: now() });
  const started = Date.parse(claimed.startedAt || now().toISOString());
  let session = await updateOwnedSession(repoPath, claimed.id, token, (state) => {
    state.startedAt ||= now().toISOString();
    state.checkpoints.push(checkpoint("controller-claimed", { priorPhase: state.phase }, now()));
    return state;
  });

  async function finish(terminal) {
    if (typeof finalize === "function") {
      try {
        session = await finalize({
          session,
          terminal,
          update: async (mutate) => {
            session = await updateOwnedSession(repoPath, session.id, token, mutate);
            return session;
          }
        }) || session;
      } catch (error) {
        session = await updateOwnedSession(repoPath, session.id, token, (state) => {
          state.phase = "bookkeeping-pending";
          state.stopReason = error.code || "bookkeeping-failed";
          state.lastError = { message: error.message, code: error.code || null, at: now().toISOString() };
          state.terminal ||= terminalReport();
          state.terminal.nextAction = `maestro resume --session ${state.id}`;
          state.checkpoints.push(checkpoint("bookkeeping-error", state.lastError, now()));
          return state;
        });
        await releaseSession(repoPath, session.id, token, {
          status: "quiescent",
          stopReason: error.code || "bookkeeping-failed"
        });
        throw error;
      }
    }

    // Reload under the lease so a pause/stop request made while finalization
    // was publishing bookkeeping is honored before ownership is released.
    session = await updateOwnedSession(repoPath, session.id, token, (state) => state);
    const control = requestedControl(session);
    return releaseSession(repoPath, session.id, token, control || terminal);
  }

  try {
    while (true) {
      const admissionStop = exhaustedBudgetReason(session, started, now());
      if (admissionStop) return finish({ status: "stopped", stopReason: admissionStop });

      session = await updateOwnedSession(repoPath, session.id, token, (state) => {
        state.phase = "reconcile";
        state.checkpoints.push(checkpoint("reconcile-intent", { cycle: state.cycles || 0 }, now()));
        return state;
      });
      if (requestedControl(session)) return finish(requestedControl(session));
      const observation = await observe(session);
      session = await updateOwnedSession(repoPath, session.id, token, (state) => {
        state.checkpoints.push(checkpoint("reconcile-result", {
          cycle: state.cycles || 0,
          readyIssueIds: (observation.readyIssueIds || []).map(String),
          unresolved: observation.unresolved || []
        }, now()));
        state.terminal = terminalReport(observation);
        return state;
      });
      if (requestedControl(session)) return finish(requestedControl(session));

      if (observation.verifiedComplete === true) {
        return finish({ status: "complete", stopReason: "verified-complete" });
      }
      if (!(observation.readyIssueIds || []).length && observation.recoverable !== true) {
        return finish({
          status: "quiescent",
          stopReason: observation.stopReason || (session.terminal.unresolved.length ? "unresolved-work" : "no-ready-work")
        });
      }
      const advanceStop = exhaustedBudgetReason(session, started, now());
      if (advanceStop) return finish({ status: "stopped", stopReason: advanceStop });

      session = await updateOwnedSession(repoPath, session.id, token, (state) => {
        state.phase = "advance";
        state.checkpoints.push(checkpoint("advance-intent", {
          cycle: state.cycles || 0,
          issueIds: (observation.readyIssueIds || []).map(String)
        }, now()));
        return state;
      });
      if (requestedControl(session)) return finish(requestedControl(session));
      const outcome = await advance({ session, observation });
      session = await updateOwnedSession(repoPath, session.id, token, (state) => {
        const runIds = (outcome.runIds || []).map(String);
        state.lineage.runIds = [...new Set([...state.lineage.runIds, ...runIds])];
        state.lineage.recoveryRunIds = [...new Set([...state.lineage.recoveryRunIds, ...(outcome.recoveryRunIds || []).map(String)])];
        for (const [issue, count] of Object.entries(outcome.issueAttempts || {})) {
          state.lineage.issueAttempts[String(issue)] = Math.max(Number(state.lineage.issueAttempts[String(issue)] || 0), Number(count));
        }
        state.progress.integratedIssueIds = [...new Set([...state.progress.integratedIssueIds, ...(outcome.integratedIssueIds || []).map(String)])];
        state.progress.bookkeepingPendingIssueIds = [...new Set([
          ...state.progress.bookkeepingPendingIssueIds,
          ...(outcome.bookkeepingPendingIssueIds || []).map(String)
        ])];
        state.progress.noProgressCycles = outcome.progressed === false ? state.progress.noProgressCycles + 1 : 0;
        state.cycles = (state.cycles || 0) + 1;
        state.phase = "reconcile";
        state.checkpoints.push(checkpoint("advance-result", {
          cycle: state.cycles - 1,
          runIds,
          integratedIssueIds: (outcome.integratedIssueIds || []).map(String),
          outcome: outcome.kind || null
        }, now()));
        return state;
      });
      const outcomeStop = exhaustedBudgetReason(session, started, now());
      if (outcomeStop) return finish({ status: "stopped", stopReason: outcomeStop });
      if (outcome.stopReason) return finish({ status: "quiescent", stopReason: outcome.stopReason });
    }
  } catch (error) {
    await updateOwnedSession(repoPath, session.id, token, (state) => {
      state.phase = "stopped";
      state.stopReason = error.code || "controller-error";
      state.lastError = { message: error.message, code: error.code || null, at: now().toISOString() };
      state.checkpoints.push(checkpoint("controller-error", state.lastError, now()));
      return state;
    }).catch(() => {});
    await releaseSession(repoPath, session.id, token, { status: "quiescent", stopReason: error.code || "controller-error" }).catch(() => {});
    throw error;
  }
}

async function requestSessionState(repoPath, session, action) {
  return requestSessionControl(repoPath, session.id, action);
}

module.exports = {
  DEFAULT_LIMITS,
  newSessionId,
  createSession,
  verifySessionContext,
  resolveSession,
  terminalReport,
  driveSession,
  requestSessionState
};

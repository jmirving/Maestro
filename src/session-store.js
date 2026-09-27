const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { coordinatedRepoPath, reportRootForRepo } = require("./reporter");
const { withRepositoryCoordination } = require("./repository-coordination");

const SESSION_VERSION = 1;
const SESSION_ID = /^session-[A-Za-z0-9._-]+$/;

function sessionPath(repoPath, sessionId) {
  if (!SESSION_ID.test(String(sessionId))) throw new Error("Invalid Maestro session id.");
  return path.join(reportRootForRepo(repoPath), `${sessionId}.json`);
}

function revision(contents) {
  return contents == null ? null : crypto.createHash("sha256").update(contents).digest("hex");
}

async function read(file) {
  try { return await fs.readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

function validateSession(session) {
  if (session?.version !== SESSION_VERSION) throw new Error(`Unsupported Maestro session version ${session?.version ?? "missing"}.`);
  if (!SESSION_ID.test(String(session.id))) throw new Error("Persisted Maestro session has an invalid id.");
  if (!session.repository || !session.repositoryRoot || !session.manifestPath) throw new Error(`Maestro session ${session.id} has incomplete repository identity.`);
  if (!Array.isArray(session.scope?.issueIds) || !session.scope.issueIds.length || !session.scope.revision) {
    throw new Error(`Maestro session ${session.id} has incomplete scope evidence.`);
  }
  return session;
}

async function loadSession(repoPath, sessionId) {
  const file = sessionPath(repoPath, sessionId);
  const contents = await read(file);
  if (contents == null) throw new Error(`Maestro session ${sessionId} was not found.`);
  let session;
  try { session = JSON.parse(contents); } catch (error) {
    const invalid = new Error(`Maestro session ${sessionId} is corrupt: ${error.message}`);
    invalid.code = "SESSION_CORRUPT";
    throw invalid;
  }
  validateSession(session);
  Object.defineProperty(session, "_revision", { value: revision(contents), enumerable: false, writable: true, configurable: true });
  return session;
}

async function listSessions(repoPath) {
  const root = reportRootForRepo(repoPath);
  let names;
  try { names = await fs.readdir(root); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const ids = names.map((name) => name.match(/^(session-[A-Za-z0-9._-]+)\.json$/)?.[1]).filter(Boolean).sort();
  return Promise.all(ids.map((id) => loadSession(repoPath, id)));
}

async function saveSession(repoPath, session, { create = false } = {}) {
  validateSession(session);
  const file = sessionPath(repoPath, session.id);
  return withRepositoryCoordination(repoPath, async () => {
    const current = await read(file);
    const expected = session._revision;
    if (create && current != null) throw new Error(`Maestro session ${session.id} already exists.`);
    if (!create && current == null) throw new Error(`Maestro session ${session.id} no longer exists.`);
    if (!create && expected !== revision(current)) {
      const error = new Error(`Maestro session ${session.id} changed; reload it before continuing.`);
      error.code = "SESSION_STATE_CONFLICT";
      throw error;
    }
    const contents = `${JSON.stringify(session, null, 2)}\n`;
    await atomicWrite(file, contents);
    Object.defineProperty(session, "_revision", { value: revision(contents), enumerable: false, writable: true, configurable: true });
    return session;
  });
}

function ownerAlive(owner, kill = process.kill) {
  if (!owner?.pid || !Number.isInteger(owner.pid)) return false;
  try { kill(owner.pid, 0); return true; } catch (error) {
    return error.code !== "ESRCH" ? true : false;
  }
}

async function claimSession(repoPath, sessionId, { pid = process.pid, now = new Date(), kill = process.kill } = {}) {
  return withRepositoryCoordination(repoPath, async () => {
    const session = await loadSession(repoPath, sessionId);
    if (["complete", "stopped"].includes(session.status)) throw new Error(`Maestro session ${session.id} is ${session.status} and cannot be resumed.`);
    if (session.owner && ownerAlive(session.owner, kill)) {
      const error = new Error(`Maestro session ${session.id} is owned by live process ${session.owner.pid}.`);
      error.code = "SESSION_OWNED";
      throw error;
    }
    if (session.owner) {
      session.ownershipHistory = [...(session.ownershipHistory || []), { ...session.owner, releasedAt: now.toISOString(), reason: "orphaned" }];
    }
    const token = crypto.randomBytes(16).toString("hex");
    session.owner = { pid, token, claimedAt: now.toISOString() };
    session.status = "running";
    session.updatedAt = now.toISOString();
    // saveSession would take the same repository lock. This write remains CAS
    // protected because the lock serializes the load and replace here.
    const file = sessionPath(repoPath, session.id);
    const contents = `${JSON.stringify(session, null, 2)}\n`;
    await atomicWrite(file, contents);
    Object.defineProperty(session, "_revision", { value: revision(contents), enumerable: false, writable: true, configurable: true });
    return { session, token };
  });
}

async function updateOwnedSession(repoPath, sessionId, token, mutate) {
  return withRepositoryCoordination(repoPath, async () => {
    const session = await loadSession(repoPath, sessionId);
    if (!session.owner || session.owner.token !== token) {
      const error = new Error(`Maestro session ${session.id} ownership changed; refusing a stale controller write.`);
      error.code = "SESSION_OWNERSHIP_LOST";
      throw error;
    }
    const next = await mutate(session) || session;
    next.updatedAt = new Date().toISOString();
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    await atomicWrite(sessionPath(repoPath, next.id), contents);
    Object.defineProperty(next, "_revision", { value: revision(contents), enumerable: false, writable: true, configurable: true });
    return next;
  });
}

async function releaseSession(repoPath, sessionId, token, { status, stopReason = null } = {}) {
  return updateOwnedSession(repoPath, sessionId, token, (session) => {
    session.ownershipHistory = [...(session.ownershipHistory || []), { ...session.owner, releasedAt: new Date().toISOString(), reason: status }];
    delete session.owner;
    delete session.controlRequest;
    session.status = status;
    if (stopReason) session.stopReason = stopReason;
    session.terminal ||= { verifiedComplete: false, unresolved: [] };
    session.terminal.nextAction = ["paused", "quiescent"].includes(status)
      ? `maestro resume --session ${session.id}`
      : status === "stopped"
        ? session.scope.type === "workset" && session.scope.workset
          ? `maestro start --workset ${session.scope.workset} --delegate --continuous`
          : `maestro start ${session.scope.issueIds.join(" ")} --delegate --continuous`
        : status === "complete"
          ? "maestro status --completed"
          : session.terminal.nextAction || "maestro status";
    return session;
  });
}

async function requestSessionControl(repoPath, sessionId, action, { now = new Date() } = {}) {
  if (!["pause", "stop"].includes(action)) throw new Error("Unsupported session control action.");
  return withRepositoryCoordination(repoPath, async () => {
    const session = await loadSession(repoPath, sessionId);
    if (["complete", "stopped"].includes(session.status)) return session;
    session.controlRequest = { action, requestedAt: now.toISOString() };
    session.checkpoints.push({ kind: `${action}-requested`, at: now.toISOString() });
    if (!session.owner) {
      session.status = action === "pause" ? "paused" : "stopped";
      session.stopReason = action === "pause" ? "user-paused" : "user-stopped";
      delete session.controlRequest;
    }
    session.updatedAt = now.toISOString();
    const contents = `${JSON.stringify(session, null, 2)}\n`;
    await atomicWrite(sessionPath(repoPath, session.id), contents);
    Object.defineProperty(session, "_revision", { value: revision(contents), enumerable: false, writable: true, configurable: true });
    return session;
  });
}

function newSession({ id, repository, repoPath, manifestPath, targetBranch, scope, authorization, settings, now = new Date() }) {
  const createdAt = now.toISOString();
  return {
    version: SESSION_VERSION,
    id,
    repository,
    repositoryRoot: coordinatedRepoPath(repoPath),
    manifestPath: path.resolve(manifestPath),
    targetBranch,
    scope,
    authorization: { id: authorization.id, policyVersion: authorization.policyVersion, policyDigest: authorization.policyDigest },
    settings,
    status: "created",
    phase: "reconcile",
    createdAt,
    updatedAt: createdAt,
    checkpoints: [],
    lineage: { runIds: [], issueAttempts: {}, recoveryRunIds: [] },
    progress: { integratedIssueIds: [], bookkeepingPendingIssueIds: [], noProgressCycles: 0 },
    terminal: { verifiedComplete: false, unresolved: [] }
  };
}

module.exports = {
  SESSION_VERSION,
  sessionPath,
  newSession,
  loadSession,
  listSessions,
  saveSession,
  claimSession,
  updateOwnedSession,
  releaseSession,
  requestSessionControl,
  ownerAlive
};

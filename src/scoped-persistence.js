const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { manifestContents } = require("./draft");
const { scopePath } = require("./scope-store");

function temporaryPath(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
}

function restoreFile(file, contents) {
  if (contents == null) {
    try { fs.unlinkSync(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }
  const temporary = temporaryPath(file);
  try {
    fs.writeFileSync(temporary, contents, "utf8");
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function persistScopedDraft({
  repoPath,
  manifestPath,
  manifest,
  persistManifest = true,
  expectedManifestContents,
  expectedSnapshotContents,
  name,
  snapshot
}, {
  now = () => new Date(),
  beforeManifestPersist = () => {},
  beforeScopePersist = () => {}
} = {}) {
  if (expectedSnapshotContents === undefined) {
    throw new Error("Scoped draft persistence requires the expected scope snapshot contents for conflict detection.");
  }
  const nextManifestContents = manifestContents(manifest);
  const snapshotFile = scopePath(repoPath, name);
  const nextSnapshotContents = `${JSON.stringify({ ...snapshot, savedAt: now().toISOString() }, null, 2)}\n`;
  const lockPath = `${manifestPath}.lock`;
  const manifestTemporary = temporaryPath(manifestPath);
  const snapshotTemporary = temporaryPath(snapshotFile);
  let lock;
  let manifestCommitted = false;

  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  try {
    lock = fs.openSync(lockPath, "wx");
    const currentManifestContents = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : null;
    if (expectedManifestContents !== undefined && currentManifestContents !== expectedManifestContents) {
      throw new Error("The manifest changed after reconciliation was proposed; no changes were written. Draft again against the current file.");
    }
    const currentSnapshotContents = fs.existsSync(snapshotFile) ? fs.readFileSync(snapshotFile, "utf8") : null;
    if (currentSnapshotContents !== expectedSnapshotContents) {
      throw new Error("The workset scope snapshot changed after reconciliation was proposed; no changes were written. Draft again against the current scope.");
    }
    const manifestChanged = persistManifest && currentManifestContents !== nextManifestContents;

    if (manifestChanged) fs.writeFileSync(manifestTemporary, nextManifestContents, "utf8");
    fs.writeFileSync(snapshotTemporary, nextSnapshotContents, "utf8");

    try {
      if (manifestChanged) {
        beforeManifestPersist();
        fs.renameSync(manifestTemporary, manifestPath);
        manifestCommitted = true;
      }
      beforeScopePersist();
      fs.renameSync(snapshotTemporary, snapshotFile);
    } catch (error) {
      if (manifestCommitted) {
        try {
          restoreFile(manifestPath, currentManifestContents);
          restoreFile(snapshotFile, currentSnapshotContents);
        } catch (rollbackError) {
          throw new Error(`Scoped draft persistence failed (${error.message}) and rollback failed (${rollbackError.message}).`);
        }
      }
      throw error;
    }
    return { manifestWritten: manifestChanged, scopeWritten: true, snapshotFile };
  } finally {
    try { fs.unlinkSync(manifestTemporary); } catch {}
    try { fs.unlinkSync(snapshotTemporary); } catch {}
    if (lock != null) {
      fs.closeSync(lock);
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

module.exports = { persistScopedDraft };

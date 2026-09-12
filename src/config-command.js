const { validateRepositoryConfig } = require("./config-validator");
const { readManifestSnapshot, writeManifest } = require("./draft");
const { parseConcurrency, resolveConcurrency, formatConcurrency } = require("./concurrency");

const SUPPORTED_KEY = "defaultConcurrency";

function readValidatedManifest(manifestPath) {
  let snapshot;
  try {
    snapshot = readManifestSnapshot(manifestPath);
  } catch (error) {
    throw new Error(`Cannot read Maestro manifest ${manifestPath}: ${error.message}`);
  }
  if (!snapshot.config) throw new Error(`Maestro manifest not found: ${manifestPath}.`);
  try {
    validateRepositoryConfig(snapshot.config);
  } catch (error) {
    throw new Error(`Cannot use malformed Maestro manifest ${manifestPath}: ${error.message}`);
  }
  return snapshot;
}

function getDefaultConcurrency(manifestPath) {
  const { config } = readValidatedManifest(manifestPath);
  const setting = resolveConcurrency({ savedDefault: config.defaultConcurrency });
  return { manifestPath, saved: config.defaultConcurrency ?? null, setting };
}

function setDefaultConcurrency(manifestPath, value, { beforeWrite, writer = writeManifest } = {}) {
  const snapshot = readValidatedManifest(manifestPath);
  const next = parseConcurrency(value, "defaultConcurrency");
  const old = snapshot.config.defaultConcurrency ?? null;
  if (old === next) return { manifestPath, old, next, changed: false };
  const config = structuredClone(snapshot.config);
  config.defaultConcurrency = next;
  validateRepositoryConfig(config);
  if (beforeWrite) beforeWrite();
  writer(manifestPath, config, { expectedContents: snapshot.contents });
  return { manifestPath, old, next, changed: true };
}

function runConfigCommand({ action, key, value, manifestPath }) {
  if (!["get", "set"].includes(action)) throw new Error("maestro config requires `get` or `set`.");
  if (key !== SUPPORTED_KEY) throw new Error(`Unsupported Maestro config key: ${key}. Only ${SUPPORTED_KEY} is currently supported.`);
  if (action === "get") {
    if (value != null) throw new Error("maestro config get defaultConcurrency does not accept a value.");
    const result = getDefaultConcurrency(manifestPath);
    return `Manifest: ${result.manifestPath}\nSaved defaultConcurrency: ${result.saved == null ? "not set" : result.saved}\n${formatConcurrency(result.setting)}\n`;
  }
  if (value == null) throw new Error("maestro config set defaultConcurrency requires a value.");
  const result = setDefaultConcurrency(manifestPath, value);
  const old = result.old == null ? "not set (effective fallback: 2)" : result.old;
  return `Manifest: ${result.manifestPath}\ndefaultConcurrency: ${old} -> ${result.next}${result.changed ? "" : " (unchanged)"}\nFuture independent invocations without an override will use ${result.next}. Commit and push the manifest through your normal Git workflow to share this default.\n`;
}

module.exports = { SUPPORTED_KEY, readValidatedManifest, getDefaultConcurrency, setDefaultConcurrency, runConfigCommand };

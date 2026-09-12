const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;

function parseConcurrency(value, label = "Concurrency") {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${label} must be a positive integer between 1 and ${MAX_CONCURRENCY}.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_CONCURRENCY) {
    throw new Error(`${label} must be a safe integer between 1 and ${MAX_CONCURRENCY}.`);
  }
  return parsed;
}

function resolveConcurrency({ override, savedDefault, captured } = {}) {
  if (captured != null) {
    if (override != null) {
      throw new Error("A captured session concurrency cannot be changed by an invocation override.");
    }
    return {
      value: parseConcurrency(captured, "Captured session concurrency"),
      source: "captured session",
      savedDefault: savedDefault == null ? null : parseConcurrency(savedDefault, "Saved defaultConcurrency")
    };
  }
  const saved = savedDefault == null ? null : parseConcurrency(savedDefault, "Saved defaultConcurrency");
  if (override != null) {
    return { value: parseConcurrency(override, "Concurrency override"), source: "this invocation", savedDefault: saved };
  }
  if (saved != null) return { value: saved, source: "saved default", savedDefault: saved };
  return { value: DEFAULT_CONCURRENCY, source: "built-in fallback", savedDefault: null };
}

function formatConcurrency(setting) {
  if (setting.source === "saved default" || setting.source === "built-in fallback") {
    return `Concurrency: ${setting.value} (${setting.source})`;
  }
  const saved = setting.savedDefault == null ? `fallback: ${DEFAULT_CONCURRENCY}` : `saved default: ${setting.savedDefault}`;
  return `Concurrency: ${setting.value} (${setting.source}; ${saved})`;
}

module.exports = { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, parseConcurrency, resolveConcurrency, formatConcurrency };

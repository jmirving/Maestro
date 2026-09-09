const fs = require("node:fs");
const { validateRepositoryConfig } = require("./config-validator");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function issueId(issue) {
  return Number.isSafeInteger(issue?.number) && issue.number > 0 ? String(issue.number) : null;
}

function proposeDraft({ repository, existingConfig = null, issues = [], selectedIssueIds = [] }) {
  if (existingConfig?.repository && existingConfig.repository !== repository) {
    throw new Error(`The existing manifest targets ${existingConfig.repository}, but the current checkout is ${repository}.`);
  }

  if (existingConfig) validateRepositoryConfig(existingConfig);

  const manifest = existingConfig ? clone(existingConfig) : { repository, work: {} };
  const selected = new Set(selectedIssueIds.map(String));
  const seen = new Set();
  const ambiguous = new Set();
  const normalized = [];
  const unresolved = [];

  for (const issue of issues) {
    const id = issueId(issue);
    if (!id) {
      unresolved.push({ issue: null, reason: "GitHub issue record has no positive integer number." });
      continue;
    }
    if (selected.size && !selected.has(id)) continue;
    if (seen.has(id)) {
      ambiguous.add(id);
      unresolved.push({ issue: id, reason: "GitHub returned duplicate records for this issue." });
      continue;
    }
    seen.add(id);
    normalized.push({ id, issue });
  }

  const added = [];
  for (const { id, issue } of normalized) {
    if (ambiguous.has(id)) continue;
    if (String(issue.state).toUpperCase() !== "OPEN") {
      unresolved.push({ issue: id, reason: `Issue is ${String(issue.state || "in an unknown state").toLowerCase()}, not open.` });
      continue;
    }
    if (manifest.work[id]) continue;
    manifest.work[id] = { status: "ready" };
    added.push(id);
  }

  for (const id of selected) {
    if (!seen.has(id)) unresolved.push({ issue: id, reason: "GitHub did not return the selected issue." });
  }

  validateRepositoryConfig(manifest);
  added.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  unresolved.sort((a, b) => String(a.issue || "").localeCompare(String(b.issue || "")) || a.reason.localeCompare(b.reason));
  return { manifest, added, unresolved, created: !existingConfig };
}

function formatDraftSummary({ repository, manifestPath, result, write }) {
  const lines = [
    `Maestro draft for ${repository}`,
    `Manifest: ${manifestPath}`,
    "Changes:"
  ];
  if (result.created) lines.push("  + create manifest");
  if (result.added.length) {
    for (const id of result.added) lines.push(`  + #${id} ready`);
  } else if (!result.created) {
    lines.push("  (no changes)");
  }
  if (result.unresolved.length) {
    lines.push("Unresolved:");
    for (const item of result.unresolved) lines.push(`  ! ${item.issue ? `#${item.issue}: ` : ""}${item.reason}`);
  }
  lines.push("Proposed manifest:", JSON.stringify(result.manifest, null, 2));
  if (!write) lines.push("Dry run; use --write to persist this manifest.");
  else if (result.created || result.added.length) lines.push("Writing schema-valid manifest.");
  else lines.push("Schema-valid manifest is already current; nothing written.");
  return `${lines.join("\n")}\n`;
}

function readExistingManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeManifest(manifestPath, manifest) {
  validateRepositoryConfig(manifest);
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, "utf8") === contents) return false;
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, "utf8");
    fs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  return true;
}

module.exports = { proposeDraft, formatDraftSummary, readExistingManifest, writeManifest };

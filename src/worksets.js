const crypto = require("node:crypto");
const { loadGitHubIssues, loadGitHubSubIssues } = require("./github");
const { explicitDependencies } = require("./draft");

const WORKSET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeIssueRef(ref, defaultRepository = null) {
  const repository = String(ref?.repository || defaultRepository || "");
  const number = String(ref?.number || ref?.issue || "");
  if (!repository.includes("/") || !/^[1-9]\d*$/.test(number)) {
    throw new Error(`Invalid canonical issue reference: ${repository || "(no repository)"}#${number || "(no number)"}.`);
  }
  return { repository, number };
}

function issueRefKey(ref) {
  return `${ref.repository.toLowerCase()}#${ref.number}`;
}

function stableWorksetName(epicNumber) {
  return `epic-${String(epicNumber)}`;
}

function validateWorksetName(name) {
  if (!WORKSET_NAME.test(String(name || ""))) {
    throw new Error("Workset names must start with a lowercase letter or digit and contain only lowercase letters, digits, '.', '_' or '-' (maximum 64 characters).");
  }
  return String(name);
}

function epicWorkset(repository, number, { includeParent = false } = {}) {
  return {
    source: { type: "epic", issue: normalizeIssueRef({ repository, number }), ...(includeParent ? { includeParent: true } : {}) },
    refresh: { mode: "explicit" }
  };
}

function issueWorkset(repository, numbers) {
  return {
    source: { type: "issues", issues: numbers.map((number) => normalizeIssueRef({ repository, number })) },
    refresh: { mode: "explicit" }
  };
}

function issueFact(issue, repository) {
  return {
    repository,
    number: String(issue.number),
    state: String(issue.state || "").toUpperCase(),
    title: String(issue.title || ""),
    body: String(issue.body || ""),
    labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean).sort(),
    updatedAt: issue.updatedAt || null,
    closedAt: issue.closedAt || null
  };
}

function explicitIssueRevision(repository, issueIds, issues) {
  const membership = [...new Set(issueIds.map(String))]
    .sort((a, b) => Number(a) - Number(b))
    .map((number) => normalizeIssueRef({ repository, number }));
  const byNumber = new Map(issues.map((issue) => [String(issue.number), issue]));
  const missing = membership.filter((ref) => !byNumber.has(ref.number));
  if (missing.length) {
    throw new Error(`GitHub did not return canonical facts for ${missing.map((ref) => `${ref.repository}#${ref.number}`).join(", ")}.`);
  }
  return digest({
    type: "issues",
    repository,
    membership,
    issues: membership.map((ref) => issueFact(byNumber.get(ref.number), ref.repository))
  });
}

function scopeRevision(definition, membership, issues, parent, supportingIssues = []) {
  return digest({
    definition,
    membership,
    issues: issues.map((issue) => issueFact(issue, membership.find((ref) => ref.number === String(issue.number))?.repository || "")),
    parent,
    supportingIssues: supportingIssues.map((issue) => issueFact(issue, issue.repository || ""))
  });
}

async function resolveWorksetScope(name, definition, {
  repository,
  repoPath,
  issueLoader = loadGitHubIssues,
  subIssueLoader = loadGitHubSubIssues
} = {}) {
  validateWorksetName(name);
  if (!definition?.source) throw new Error(`Workset '${name}' has no source.`);
  repository = repository || definition.source.issue?.repository || definition.source.issues?.[0]?.repository;
  if (typeof repository !== "string" || !repository.includes("/")) throw new Error(`Workset '${name}' has no valid target repository.`);
  const diagnostics = [];
  const issueByKey = new Map();
  const membership = [];
  let parent = null;

  const fetchIssue = async (ref, role) => {
    if (ref.repository.toLowerCase() !== repository.toLowerCase()) {
      diagnostics.push({ type: "cross-repository", issue: ref, reason: `${role} ${ref.repository}#${ref.number} is outside ${repository}; cross-repository execution is not supported.` });
      return null;
    }
    try {
      const records = await issueLoader(ref.repository, [ref.number], { repoPath });
      if (records.length !== 1 || String(records[0]?.number) !== ref.number) throw new Error(`returned ${records.length} matching records`);
      return records[0];
    } catch (error) {
      diagnostics.push({ type: "missing-or-inaccessible", issue: ref, reason: `Cannot read ${role} ${ref.repository}#${ref.number}: ${error.message}` });
      return null;
    }
  };

  if (definition.source.type === "issues") {
    const seen = new Set();
    for (const raw of definition.source.issues || []) {
      const ref = normalizeIssueRef(raw);
      const key = issueRefKey(ref);
      if (seen.has(key)) {
        diagnostics.push({ type: "duplicate", issue: ref, reason: `Explicit workset '${name}' lists ${ref.repository}#${ref.number} more than once.` });
        continue;
      }
      seen.add(key);
      const issue = await fetchIssue(ref, "selected issue");
      if (issue) {
        membership.push(ref);
        issueByKey.set(key, issue);
      }
    }
    if (!membership.length) diagnostics.push({ type: "empty", issue: null, reason: `Explicit workset '${name}' has no accessible members.` });
  } else if (definition.source.type === "epic") {
    const root = normalizeIssueRef(definition.source.issue);
    const parentIssue = await fetchIssue(root, "epic");
    if (parentIssue) parent = issueFact(parentIssue, root.repository);
    const visited = new Set([issueRefKey(root)]);
    const ancestry = new Set([issueRefKey(root)]);

    const visit = async (container, ancestors) => {
      let children;
      try {
        children = await subIssueLoader(container.repository, container.number, { repoPath });
      } catch (error) {
        diagnostics.push({ type: "relationship-unavailable", issue: container, reason: `Cannot completely resolve documented sub-issues for ${container.repository}#${container.number}: ${error.message}` });
        return;
      }
      if (!Array.isArray(children)) {
        diagnostics.push({ type: "partial", issue: container, reason: `GitHub returned an incomplete sub-issue result for ${container.repository}#${container.number}.` });
        return;
      }
      for (const child of children) {
        let ref;
        try {
          ref = normalizeIssueRef(child, child.repository?.nameWithOwner || child.repository || container.repository);
        } catch (error) {
          diagnostics.push({ type: "invalid-reference", issue: container, reason: error.message });
          continue;
        }
        const key = issueRefKey(ref);
        if (ancestors.has(key)) {
          diagnostics.push({ type: "cycle", issue: ref, reason: `Epic hierarchy contains a cycle through ${ref.repository}#${ref.number}.` });
          continue;
        }
        if (visited.has(key)) {
          diagnostics.push({ type: "duplicate", issue: ref, reason: `${ref.repository}#${ref.number} appears more than once in the epic hierarchy.` });
          continue;
        }
        visited.add(key);
        if (ref.repository.toLowerCase() !== repository.toLowerCase()) {
          diagnostics.push({ type: "cross-repository", issue: ref, reason: `Epic child ${ref.repository}#${ref.number} is outside ${repository}; it was not mapped to local issue #${ref.number}.` });
          continue;
        }
        const issue = await fetchIssue(ref, "epic child");
        if (!issue) continue;
        membership.push(ref);
        issueByKey.set(key, issue);
        await visit(ref, new Set([...ancestors, key]));
      }
    };
    if (parentIssue) await visit(root, ancestry);
    if (definition.source.includeParent && parentIssue) {
      membership.unshift(root);
      issueByKey.set(issueRefKey(root), parentIssue);
    }
    if (!membership.length) diagnostics.push({ type: "empty", issue: root, reason: `Epic ${root.repository}#${root.number} has no executable members.` });
  } else {
    throw new Error(`Workset '${name}' uses unsupported source type '${definition.source.type}'.`);
  }

  membership.sort((a, b) => a.repository.localeCompare(b.repository) || Number(a.number) - Number(b.number));
  const issues = membership.map((ref) => issueByKey.get(issueRefKey(ref))).filter(Boolean);
  const membershipKeys = new Set(membership.map(issueRefKey));
  const supportingByKey = new Map();
  for (const issue of issues) {
    for (const dependency of explicitDependencies(issue, repository)) {
      const ref = normalizeIssueRef({ repository: dependency.repository || repository, number: dependency.id });
      const key = issueRefKey(ref);
      if (dependency.unsupported) {
        diagnostics.push({ type: "cross-repository-dependency", issue: ref, reason: `Selected issue ${repository}#${issue.number} depends on unsupported ${ref.repository}#${ref.number}; it was not mapped to local issue #${ref.number}.` });
      } else if (!membershipKeys.has(key) && !supportingByKey.has(key)) {
        const supportingIssue = await fetchIssue(ref, "outside prerequisite");
        if (supportingIssue) supportingByKey.set(key, { ...supportingIssue, repository: ref.repository });
      }
    }
  }
  const supportingIssues = [...supportingByKey.values()].sort((a, b) => Number(a.number) - Number(b.number));
  return {
    version: 1,
    name,
    definition,
    repository,
    membership,
    issueIds: membership.map((ref) => ref.number),
    issues,
    supportingIssues,
    supportingIssueIds: supportingIssues.map((issue) => String(issue.number)),
    parent,
    diagnostics,
    complete: diagnostics.length === 0,
    revision: scopeRevision(definition, membership, issues, parent, supportingIssues)
  };
}

function assertExecutableScope(snapshot) {
  if (!snapshot) throw new Error("No persisted workset scope snapshot exists. Run `maestro draft --workset <name> --write` first.");
  if (!snapshot.complete || snapshot.diagnostics?.length) {
    throw new Error(`Workset '${snapshot.name}' scope is incomplete: ${(snapshot.diagnostics || []).map((item) => item.reason).join(" ")}`);
  }
  return snapshot;
}

module.exports = {
  normalizeIssueRef,
  issueRefKey,
  stableWorksetName,
  validateWorksetName,
  epicWorkset,
  issueWorkset,
  issueFact,
  explicitIssueRevision,
  resolveWorksetScope,
  assertExecutableScope
};

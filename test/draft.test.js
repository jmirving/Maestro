const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { proposeDraft, writeManifest, detectExecutionDrift } = require("../src/draft");
const { loadGitHubIssues } = require("../src/github");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maestro-draft-test-"));
}

function issue(number, state = "OPEN") {
  return { number, state, title: `Issue ${number}`, body: "", labels: [] };
}

function agentAnalysis(output) {
  return {
    output: { version: 1, dependencies: [], conflicts: [], work: [], waves: [], unresolved: [], ...output },
    metadata: {
      analyzer: "agent", provider: "codex", contextDigest: "a".repeat(64), outputDigest: "b".repeat(64), attempts: 1, issueIds: ["1", "2"], files: []
    }
  };
}

test("GitHub adapter fetches the full issue set and enriches closure reasons", async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "issue") return { stdout: JSON.stringify([issue(1), { ...issue(2, "CLOSED"), closedAt: "2026-09-11T12:00:00Z" }]) };
    return { stdout: JSON.stringify([[{ number: 1, state_reason: null }, { number: 2, state_reason: "not_planned" }]]) };
  };
  const issues = await loadGitHubIssues("owner/repo", [], { repoPath: "/repo", runner });
  assert.equal(issues[1].stateReason, "not_planned");
  assert.ok(calls[0].includes("all"));
  assert.ok(calls[1].includes("--paginate"));
});

test("creates a valid minimal manifest from open GitHub issues", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    issues: [issue(12), issue(3)]
  });

  assert.equal(result.manifest.repository, "owner/repo");
  assert.deepEqual(Object.fromEntries(Object.entries(result.manifest.work).map(([id, item]) => [id, item.status])), { "3": "ready", "12": "ready" });
  assert.equal(result.manifest.work["3"].github.state, "OPEN");
  assert.deepEqual(result.added, ["3", "12"]);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.created, true);
});

test("refresh preserves completed work and all curated metadata", () => {
  const existing = {
    repository: "owner/repo",
    defaultConcurrency: 4,
    integration: { enabled: false, commands: ["npm test"] },
    work: {
      "1": { status: "complete", priority: 7, note: "retain me" },
      "2": { status: "blocked", blockedBy: ["1"], requires: ["node"], humanGate: "owner review" }
    }
  };
  const original = JSON.parse(JSON.stringify(existing));

  const result = proposeDraft({ repository: "owner/repo", existingConfig: existing, issues: [issue(1), issue(2), issue(3)] });

  assert.deepEqual(existing, original, "drafting must not mutate the loaded manifest");
  assert.deepEqual({ ...result.manifest.work["1"], github: undefined }, { ...original.work["1"], github: undefined });
  assert.deepEqual({ ...result.manifest.work["2"], github: undefined }, { ...original.work["2"], github: undefined });
  assert.equal(result.manifest.work["3"].status, "ready");
  assert.equal(result.manifest.defaultConcurrency, 4);
});

test("selected drafting leaves unrelated entries and returned issues untouched", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "9": { status: "complete" } } },
    issues: [issue(2), issue(3)],
    selectedIssueIds: ["2"]
  });

  assert.equal(result.manifest.work["2"].status, "ready");
  assert.deepEqual(result.manifest.work["9"], { status: "complete" });
  assert.deepEqual(result.added, ["2"]);
});

test("explicit issue dependencies become hard relationships while manual dependencies are preserved", () => {
  const existing = {
    repository: "owner/repo",
    work: {
      "1": { status: "complete" },
      "2": { status: "complete" },
      "3": { status: "ready", blockedBy: ["4", "1"], note: "curated" },
      "4": { status: "complete" }
    }
  };
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: existing,
    issues: [{ ...issue(3), body: "## Dependencies\n\nBlocked by #2." }]
  });
  assert.deepEqual({ ...result.manifest.work["3"], github: undefined }, { status: "ready", blockedBy: ["4", "1", "2"], note: "curated", github: undefined });
  assert.equal(result.dependencySources.find((entry) => entry.dependency === "1").source, "existing manifest blockedBy");
  assert.match(result.dependencySources.find((entry) => entry.dependency === "2").source, /GitHub issue #3 body/);
  assert.equal(result.writable, true);
});

test("injected advisory analyzers persist advisory metadata without adding blockedBy", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    issues: [issue(1), issue(2)],
    analyzers: [{
      name: "ownership-map",
      analyze: () => [{ issues: ["1", "2"], confidence: "high", source: "config paths: src/api", reason: "Likely file overlap." }]
    }]
  });
  assert.equal(result.manifest.work["2"].blockedBy, undefined);
  assert.deepEqual(result.manifest.planning.advisoryConflicts, [{
    issues: ["1", "2"],
    confidence: "high",
    source: "config paths: src/api",
    reason: "Likely file overlap.",
    analyzer: "ownership-map"
  }]);
  assert.deepEqual(result.planning.waves, [["1"], ["2"]]);
});

test("a full refresh replaces stale output owned by an active analyzer", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: {
      repository: "owner/repo",
      work: { "1": { status: "ready" }, "2": { status: "ready" } },
      planning: {
        advisoryConflicts: [{ issues: ["1", "2"], confidence: "medium", source: "old labels", reason: "Old result.", analyzer: "labels" }]
      }
    },
    issues: [issue(1), issue(2)],
    analyzers: [{ name: "labels", analyze: () => [] }]
  });
  assert.equal(result.manifest.planning, undefined);
  assert.equal(result.changed, true);
});

test("agent recommendations merge semantically while explicit manifest truth wins", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "1": { status: "ready", mode: "execute", priority: 7, requires: ["node"] } } },
    issues: [issue(1), issue(2)],
    agentAnalysis: agentAnalysis({
      dependencies: [{ issue: "2", blockedBy: "1", confidence: "high", reason: "Shared abstraction must land first.", evidence: ["src/core.js", "issue #2"] }],
      conflicts: [{ issues: ["1", "2"], confidence: "high", reason: "Both edit the core.", evidence: ["src/core.js"] }],
      work: [
        { issue: "1", confidence: "high", reason: "Database tests are required.", evidence: ["package.json"], mode: "research", priority: 1, requires: ["postgres"] },
        { issue: "2", confidence: "high", reason: "Implementation work.", evidence: ["issue #2"], mode: "execute", priority: 20 }
      ],
      waves: [{ issues: ["1"], confidence: "high", reason: "Foundation first.", evidence: ["dependency inference"] }]
    })
  });
  assert.deepEqual({ ...result.manifest.work["1"], github: undefined }, { status: "ready", mode: "execute", priority: 7, requires: ["node", "postgres"], github: undefined });
  assert.deepEqual({ ...result.manifest.work["2"], github: undefined }, { status: "ready", blockedBy: ["1"], mode: "execute", priority: 20, github: undefined });
  assert.equal(result.manifest.planning.advisoryConflicts[0].analyzer, "agent");
  assert.equal(result.manifest.planning.agentAnalysis.contextDigest, "a".repeat(64));
  assert.match(result.dependencySources.find((entry) => entry.issue === "2").source, /src\/core.js/);
  assert.deepEqual(result.planning.waves, [["1"], ["2"]]);
  assert.equal(result.writable, true);
});

test("low-confidence agent decisions remain unresolved instead of mutating hard truth", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    issues: [issue(1), issue(2)],
    agentAnalysis: agentAnalysis({
      dependencies: [{ issue: "2", blockedBy: "1", confidence: "low", reason: "Possibly ordered.", evidence: ["similar wording"] }],
      conflicts: [{ issues: ["1", "2"], confidence: "low", reason: "Maybe overlap.", evidence: ["titles"] }],
      work: [{ issue: "2", confidence: "low", reason: "Might require research.", evidence: ["issue body"], mode: "research" }]
    })
  });
  assert.equal(result.manifest.work["2"].blockedBy, undefined);
  assert.equal(result.manifest.work["2"].mode, undefined);
  assert.equal(result.manifest.planning.advisoryConflicts, undefined);
  assert.equal(result.unresolved.length, 3);
});

test("agent dependency cycles and invalid references block the proposal", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    issues: [issue(1), issue(2)],
    agentAnalysis: agentAnalysis({ dependencies: [
      { issue: "1", blockedBy: "2", confidence: "high", reason: "First edge.", evidence: ["A"] },
      { issue: "2", blockedBy: "1", confidence: "high", reason: "Second edge.", evidence: ["B"] },
      { issue: "2", blockedBy: "99", confidence: "high", reason: "Unknown edge.", evidence: ["C"] }
    ] })
  });
  assert.equal(result.writable, false);
  assert.match(result.diagnostics.map((entry) => entry.reason).join("\n"), /cycle detected/);
  assert.match(result.diagnostics.map((entry) => entry.reason).join("\n"), /not present in the manifest/);
});

test("cycles and unresolved dependency references block persistence", () => {
  const missing = proposeDraft({
    repository: "owner/repo",
    issues: [{ ...issue(2), body: "Depends on #99" }]
  });
  assert.equal(missing.writable, false);
  assert.match(missing.diagnostics[0].reason, /#99 is not present/);
  assert.throws(() => writeManifest(path.join(tempDir(), ".maestro.json"), missing.manifest), /Cannot write unsafe Maestro manifest/);

  const cycle = proposeDraft({
    repository: "owner/repo",
    existingConfig: {
      repository: "owner/repo",
      work: { "1": { status: "ready", blockedBy: ["2"] }, "2": { status: "ready", blockedBy: ["1"] } }
    },
    issues: [issue(1), issue(2)]
  });
  assert.equal(cycle.writable, false);
  assert.match(cycle.diagnostics.map((entry) => entry.reason).join("\n"), /cycle detected/);
});

test("closed, malformed, missing, and duplicate issue data stays unresolved", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    issues: [issue(2, "CLOSED"), { state: "OPEN" }, issue(4), issue(4)],
    selectedIssueIds: ["2", "3", "4"]
  });

  assert.deepEqual(result.manifest.work, {});
  assert.match(result.unresolved.map((entry) => entry.reason).join("\n"), /not open/);
  assert.match(result.unresolved.map((entry) => entry.reason).join("\n"), /no positive integer/);
  assert.match(result.unresolved.map((entry) => entry.reason).join("\n"), /did not return/);
  assert.match(result.unresolved.map((entry) => entry.reason).join("\n"), /duplicate records/);
});

test("open to closed reconciliation makes work inactive while preserving history and closure evidence", () => {
  const initial = proposeDraft({ repository: "owner/repo", issues: [issue(7)] }).manifest;
  initial.work["7"].note = "curated";
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: initial,
    issues: [{ ...issue(7, "CLOSED"), stateReason: "NOT_PLANNED", closedAt: "2026-09-11T12:00:00Z" }]
  });

  assert.equal(result.manifest.work["7"].status, "inactive");
  assert.equal(result.manifest.work["7"].note, "curated");
  assert.equal(result.manifest.work["7"].github.stateReason, "NOT_PLANNED");
  assert.deepEqual(result.manifest.work["7"].reconciliationHistory, [{ from: "ready", to: "inactive", reason: "GitHub issue closed (NOT_PLANNED)." }]);
  assert.equal(result.drift[0].classification, "safe");
  assert.equal(result.planning.waves.length, 0);
});

test("closed to reopened reconciliation restores inactive work but preserves integrated completion", () => {
  const closed = proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "7": { status: "ready" } } },
    issues: [{ ...issue(7, "CLOSED"), stateReason: "COMPLETED" }]
  }).manifest;
  const reopened = proposeDraft({ repository: "owner/repo", existingConfig: closed, issues: [issue(7)] });
  assert.equal(reopened.manifest.work["7"].status, "ready");

  const completedWhileClosed = JSON.parse(JSON.stringify(closed));
  completedWhileClosed.work["7"].status = "complete";
  const reopenedComplete = proposeDraft({ repository: "owner/repo", existingConfig: completedWhileClosed, issues: [issue(7)] });
  assert.equal(reopenedComplete.manifest.work["7"].status, "ready");

  const integrated = proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "8": { status: "complete" } } },
    issues: [issue(8)]
  });
  assert.equal(integrated.manifest.work["8"].status, "complete");
  assert.match(integrated.preserved[0].reason, /completion is preserved/);
});

test("GitHub dependencies and configured label mappings reconcile reversibly without deleting manual metadata", () => {
  const config = {
    repository: "owner/repo",
    github: { labelMappings: {
      priority: { urgent: 1 }, mode: { docs: "research" }, requires: { database: ["postgres"] }, humanGate: { legal: "Legal approval" }
    } },
    work: { "1": { status: "complete" }, "2": { status: "complete" }, "3": { status: "ready", blockedBy: ["1"], requires: ["node"], priority: 7, mode: "execute" } }
  };
  const first = proposeDraft({
    repository: "owner/repo", existingConfig: config,
    issues: [{ ...issue(3), body: "Blocked by #2", labels: [{ name: "urgent" }, { name: "docs" }, { name: "database" }, { name: "legal" }] }]
  });
  assert.deepEqual(first.manifest.work["3"].blockedBy, ["1", "2"]);
  assert.deepEqual(first.manifest.work["3"].requires, ["node", "postgres"]);
  assert.equal(first.manifest.work["3"].priority, 1);
  assert.equal(first.manifest.work["3"].mode, "research");
  assert.equal(first.manifest.work["3"].status, "human_gate");

  const second = proposeDraft({ repository: "owner/repo", existingConfig: first.manifest, issues: [issue(3)] });
  assert.deepEqual(second.manifest.work["3"].blockedBy, ["1"]);
  assert.deepEqual(second.manifest.work["3"].requires, ["node"]);
  assert.equal(second.manifest.work["3"].priority, 7);
  assert.equal(second.manifest.work["3"].mode, "execute");
  assert.equal(second.manifest.work["3"].status, "ready");
});

test("legacy metadata retains manual provenance when it overlaps GitHub-owned values", () => {
  const config = {
    repository: "owner/repo",
    github: { labelMappings: { requires: { database: ["postgres", "redis"] } } },
    work: {
      "1": { status: "complete" },
      "2": { status: "complete" },
      "3": { status: "ready", blockedBy: ["1"], requires: ["postgres"] }
    }
  };
  const first = proposeDraft({
    repository: "owner/repo",
    existingConfig: config,
    issues: [{ ...issue(3), body: "Blocked by #1 and #2", labels: [{ name: "database" }] }]
  });
  assert.deepEqual(first.manifest.work["3"].blockedBy, ["1", "2"]);
  assert.deepEqual(first.manifest.work["3"].requires, ["postgres", "redis"]);
  assert.deepEqual(first.manifest.work["3"].github.manual.blockedBy, ["1"]);
  assert.deepEqual(first.manifest.work["3"].github.manual.requires, ["postgres"]);
  assert.match(first.dependencySources.find((entry) => entry.dependency === "1").source, /existing manifest blockedBy; GitHub issue #3 body/);

  const second = proposeDraft({ repository: "owner/repo", existingConfig: first.manifest, issues: [issue(3)] });
  assert.deepEqual(second.manifest.work["3"].blockedBy, ["1"]);
  assert.deepEqual(second.manifest.work["3"].requires, ["postgres"]);
  assert.deepEqual(second.manifest.work["3"].github.manual.blockedBy, ["1"]);
  assert.deepEqual(second.manifest.work["3"].github.manual.requires, ["postgres"]);

  const third = proposeDraft({ repository: "owner/repo", existingConfig: second.manifest, issues: [issue(3)] });
  assert.equal(third.changed, false);
});

test("material GitHub changes conflict with unresolved Maestro execution state", () => {
  const existing = proposeDraft({ repository: "owner/repo", issues: [issue(7)] }).manifest;
  const result = proposeDraft({
    repository: "owner/repo", existingConfig: existing,
    issues: [issue(7, "CLOSED")],
    executionStates: [{ runId: "run-1", status: "running", mode: "execute", plan: { selected: [{ id: "7" }] }, workers: [] }]
  });
  assert.equal(result.manifest.work["7"].status, "ready");
  assert.equal(result.manifest.work["7"].github.state, "OPEN");
  assert.match(result.conflicts[0].reason, /run-1 is running/);
});

test("full reconciliation reports vanished GitHub issues and selected reconciliation preserves unrelated provenance", () => {
  const existing = proposeDraft({ repository: "owner/repo", issues: [issue(1), issue(2)] }).manifest;
  const full = proposeDraft({ repository: "owner/repo", existingConfig: existing, issues: [issue(1)] });
  assert.equal(full.conflicts[0].type, "missing-github");
  const selected = proposeDraft({ repository: "owner/repo", existingConfig: existing, issues: [issue(1, "CLOSED")], selectedIssueIds: ["1"] });
  assert.equal(selected.manifest.work["2"].github.state, "OPEN");
  assert.equal(selected.conflicts.length, 0);
});

test("execution drift detection blocks closed and materially changed reconciled issues", () => {
  const config = proposeDraft({ repository: "owner/repo", issues: [{ ...issue(7), body: "Blocked by #2" }], existingConfig: { repository: "owner/repo", work: { "2": { status: "complete" } } } }).manifest;
  const findings = detectExecutionDrift(config, [{ ...issue(7, "CLOSED"), body: "" }], ["7"]);
  assert.match(findings.map((entry) => entry.reason).join(" "), /closed/);
  assert.match(findings.map((entry) => entry.reason).join(" "), /dependency metadata changed/);
});

test("execution drift detection fails closed for legacy entries without GitHub provenance", () => {
  const config = { repository: "owner/repo", work: { "7": { status: "ready" } } };
  const findings = detectExecutionDrift(config, [issue(7)], ["7"]);
  assert.match(findings.map((entry) => entry.reason).join(" "), /no GitHub reconciliation provenance/);
});

test("manifest writes reject an intervening edit without overwriting it", () => {
  const dir = tempDir();
  const file = path.join(dir, ".maestro.json");
  const original = `${JSON.stringify({ repository: "owner/repo", work: {} }, null, 2)}\n`;
  fs.writeFileSync(file, original);
  const intervening = `${JSON.stringify({ repository: "owner/repo", work: { "9": { status: "ready" } } }, null, 2)}\n`;
  fs.writeFileSync(file, intervening);
  assert.throws(() => writeManifest(file, { repository: "owner/repo", work: { "1": { status: "ready" } } }, { expectedContents: original }), /changed after reconciliation/);
  assert.equal(fs.readFileSync(file, "utf8"), intervening);

  fs.writeFileSync(`${file}.lock`, "another writer");
  assert.throws(() => writeManifest(file, { repository: "owner/repo", work: {} }), /EEXIST/);
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), "another writer");
});

test("start refuses to execute a reconciled issue that GitHub has since closed", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  const config = proposeDraft({ repository: "owner/repo", issues: [issue(7)] }).manifest;
  fs.writeFileSync(path.join(repoPath, ".maestro.json"), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue" && args[1] === "view") process.stdout.write('{"number":7,"state":"CLOSED","stateReason":"NOT_PLANNED","title":"Seven","body":"","labels":[]}');
else process.exit(3);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/maestro.js"), "start"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub\/manifest drift blocks execution.*#7 GitHub issue is closed/);
  assert.match(result.stderr, /maestro draft --write/);
});

test("start refuses a closed ready legacy entry without creating a run", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  fs.writeFileSync(path.join(repoPath, ".maestro.json"), `${JSON.stringify({
    repository: "owner/repo",
    work: { "7": { status: "ready" } }
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue" && args[1] === "view") process.stdout.write('{"number":7,"state":"CLOSED","stateReason":"NOT_PLANNED","title":"Seven","body":"","labels":[]}');
else process.exit(3);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/maestro.js"), "start"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8"
  });
  const reportRoot = path.join(path.dirname(repoPath), ".maestro-worktrees", path.basename(repoPath), ".maestro-reports");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub\/manifest drift blocks execution.*#7 GitHub issue is closed/);
  assert.match(result.stderr, /#7 Manifest entry has no GitHub reconciliation provenance/);
  assert.match(result.stderr, /maestro draft --write/);
  assert.equal(fs.existsSync(reportRoot), false, "preflight must fail before run persistence");
});

test("invalid existing metadata fails schema validation before it can be written", () => {
  assert.throws(() => proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "1": { status: "invented" } } },
    issues: []
  }), /repository-config schema/);

  assert.throws(() => proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo" },
    issues: []
  }), /repository-config schema/);

  assert.throws(() => writeManifest(path.join(tempDir(), ".maestro.json"), {
    repository: "owner/repo",
    work: { "1": {} }
  }), /repository-config schema/);

  assert.throws(() => proposeDraft({
    repository: "owner/repo",
    existingConfig: {
      repository: "owner/repo",
      work: { "1": { status: "ready" } },
      planning: { agentAnalysis: { ...agentAnalysis({}).metadata, recommendations: { version: 1 } } }
    },
    issues: [issue(1)]
  }), /repository-config schema/);
});

test("repeated draft CLI runs are dry by default and idempotent when written", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  const fakeGh = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: "owner/repo" }));
} else if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(process.env.MAESTRO_TEST_ISSUES);
} else if (args[0] === "issue" && args[1] === "view") {
  const found = JSON.parse(process.env.MAESTRO_TEST_ISSUES).find((item) => String(item.number) === args[2]);
  if (!found) process.exit(1);
  process.stdout.write(JSON.stringify(found));
} else {
  process.exit(2);
}
`;
  fs.writeFileSync(path.join(binPath, "gh"), fakeGh, { mode: 0o755 });
  const cliPath = path.resolve(__dirname, "../bin/maestro.js");
  const env = {
    ...process.env,
    PATH: `${binPath}${path.delimiter}${process.env.PATH}`,
    MAESTRO_TEST_ISSUES: JSON.stringify([issue(8), issue(5)])
  };

  const dry = spawnSync(process.execPath, [cliPath, "draft"], { cwd: repoPath, env, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\+ #5 ready/);
  assert.match(dry.stdout, /Expected execution waves:/);
  assert.match(dry.stdout, /Wave 1: #5, #8/);
  assert.match(dry.stdout, /2-way dependency independence available; repository limit is 2/);
  assert.match(dry.stdout, /Dry run/);
  assert.equal(fs.existsSync(path.join(repoPath, ".maestro.json")), false);

  const write = spawnSync(process.execPath, [cliPath, "draft", "--write"], { cwd: repoPath, env, encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /Writing schema-valid manifest/);
  const firstContents = fs.readFileSync(path.join(repoPath, ".maestro.json"), "utf8");

  const repeated = spawnSync(process.execPath, [cliPath, "draft", "--write"], { cwd: repoPath, env, encoding: "utf8" });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /\(no changes\)/);
  assert.equal(fs.readFileSync(path.join(repoPath, ".maestro.json"), "utf8"), firstContents);
});

test("selected draft CLI reads only selected issues and preserves unrelated work", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  fs.writeFileSync(path.join(repoPath, ".maestro.json"), JSON.stringify({
    repository: "owner/repo",
    work: { "99": { status: "complete", note: "curated" } }
  }));
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue" && args[1] === "view" && args[2] === "7") process.stdout.write('{"number":7,"state":"OPEN","title":"Seven","body":"","labels":[]}');
else process.exit(3);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/maestro.js"), "draft", "7", "--write"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const writtenWork = JSON.parse(fs.readFileSync(path.join(repoPath, ".maestro.json"), "utf8")).work;
  assert.equal(writtenWork["7"].status, "ready");
  assert.equal(writtenWork["7"].github.state, "OPEN");
  assert.deepEqual(writtenWork["99"], { status: "complete", note: "curated" });
});

test("draft CLI reports unsafe dependencies and leaves the manifest unchanged", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  const manifestPath = path.join(repoPath, ".maestro.json");
  const original = `${JSON.stringify({ repository: "owner/repo", work: { "1": { status: "ready" } } }, null, 2)}\n`;
  fs.writeFileSync(manifestPath, original);
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue" && args[1] === "list") process.stdout.write('[{"number":1,"state":"OPEN","title":"One","body":"Blocked by #99","labels":[]}]');
else process.exit(3);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/maestro.js"), "draft", "--write"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8"
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Hard dependency #99 is not present/);
  assert.match(result.stdout, /Write blocked/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
});

test("draft --agent invokes the bounded planner and writes an inspectable semantic proposal", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue") process.stdout.write('[{"number":1,"state":"OPEN","title":"Core","body":"","labels":[]},{"number":2,"state":"OPEN","title":"API","body":"","labels":[]}]');
else process.exit(3);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(outputPath, process.env.MAESTRO_TEST_AGENT_OUTPUT);
`, { mode: 0o755 });
  const plannerOutput = {
    version: 1,
    dependencies: [{ issue: "2", blockedBy: "1", confidence: "high", reason: "API builds on core.", evidence: ["issue titles"] }],
    conflicts: [], work: [], waves: [{ issues: ["1"], confidence: "high", reason: "Core first.", evidence: ["dependency"] }], unresolved: []
  };
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/maestro.js"), "draft", "--agent", "--write"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}`, MAESTRO_TEST_AGENT_OUTPUT: JSON.stringify(plannerOutput) },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent-assisted recommendations:/);
  assert.match(result.stdout, /1 high-confidence hard dependencies accepted/);
  const manifest = JSON.parse(fs.readFileSync(path.join(repoPath, ".maestro.json"), "utf8"));
  assert.deepEqual(manifest.work["2"].blockedBy, ["1"]);
  assert.equal(manifest.planning.agentAnalysis.recommendations.dependencies[0].reason, "API builds on core.");
  assert.match(manifest.planning.agentAnalysis.contextDigest, /^[a-f0-9]{64}$/);
});

test("successful draft --agent dry run isolates user integrations and preserves the manifest byte-for-byte", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  const codexHome = path.join(repoPath, "codex-home");
  fs.mkdirSync(binPath);
  fs.mkdirSync(codexHome);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  const manifestPath = path.join(repoPath, ".maestro.json");
  const original = '{\n  "repository": "owner/repo",\n  "work": { "1": { "status": "ready" } }\n}\n';
  fs.writeFileSync(manifestPath, original);
  fs.writeFileSync(path.join(codexHome, "config.toml"), '[mcp_servers.writer]\ncommand = "dangerous-writer"\n[[hooks.SessionStart]]\nmatcher = "*"\n');
  fs.writeFileSync(path.join(codexHome, "hooks.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"dangerous-hook"}]}]}}');
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue") process.stdout.write('[{"number":1,"state":"OPEN","title":"One","body":"","labels":[]}]');
else process.exit(3);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const required = ["--ignore-user-config", "--ignore-rules", "mcp_servers={}", "hooks={}", "apps._default.enabled=false", "tools.web_search=false", "features.shell_tool=false"];
if (required.some((value) => !args.includes(value))) process.exit(8);
const outputPath = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(outputPath, '{"version":1,"dependencies":[],"conflicts":[],"work":[],"waves":[],"unresolved":[]}');
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/maestro.js"), "draft", "--agent"], {
    cwd: repoPath,
    env: { ...process.env, CODEX_HOME: codexHome, PATH: `${binPath}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent-assisted recommendations:/);
  assert.match(result.stdout, /Dry run; use --write/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
});

test("draft --agent failure leaves an existing manifest byte-for-byte untouched", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  const manifestPath = path.join(repoPath, ".maestro.json");
  const original = `${JSON.stringify({ repository: "owner/repo", work: { "1": { status: "ready" } } }, null, 2)}\n`;
  fs.writeFileSync(manifestPath, original);
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue") process.stdout.write('[{"number":1,"state":"OPEN","title":"One","body":"","labels":[]}]');
else process.exit(3);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binPath, "codex"), "#!/usr/bin/env node\nprocess.exit(9);\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bin/maestro.js"), "draft", "--agent", "--write"], {
    cwd: repoPath,
    env: { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Agent-assisted planning failed after 2 attempt/);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), original);
});

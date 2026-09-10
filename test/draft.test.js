const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { proposeDraft, writeManifest } = require("../src/draft");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maestro-draft-test-"));
}

function issue(number, state = "OPEN") {
  return { number, state, title: `Issue ${number}`, body: "", labels: [] };
}

test("creates a valid minimal manifest from open GitHub issues", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    issues: [issue(12), issue(3)]
  });

  assert.deepEqual(result.manifest, {
    repository: "owner/repo",
    work: {
      "3": { status: "ready" },
      "12": { status: "ready" }
    }
  });
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
  assert.deepEqual(result.manifest.work["1"], original.work["1"]);
  assert.deepEqual(result.manifest.work["2"], original.work["2"]);
  assert.deepEqual(result.manifest.work["3"], { status: "ready" });
  assert.equal(result.manifest.defaultConcurrency, 4);
});

test("selected drafting leaves unrelated entries and returned issues untouched", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "9": { status: "complete" } } },
    issues: [issue(2), issue(3)],
    selectedIssueIds: ["2"]
  });

  assert.deepEqual(result.manifest.work, {
    "2": { status: "ready" },
    "9": { status: "complete" }
  });
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
  assert.deepEqual(result.manifest.work["3"], { status: "ready", blockedBy: ["4", "1", "2"], note: "curated" });
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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repoPath, ".maestro.json"), "utf8")).work, {
    "7": { status: "ready" },
    "99": { status: "complete", note: "curated" }
  });
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

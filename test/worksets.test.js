const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { validateRepositoryConfig } = require("../src/config-validator");
const { proposeDraft } = require("../src/draft");
const { computePlan } = require("../src/planner");
const { reconcilePlan } = require("../src/work-state");
const { executeRun } = require("../src/controller");
const { epicWorkset, issueWorkset, resolveWorksetScope } = require("../src/worksets");
const { saveScopeSnapshot, loadScopeSnapshot } = require("../src/scope-store");
const { persistScopedDraft } = require("../src/scoped-persistence");
const { reportRootForRepo } = require("../src/reporter");
const { loadGitHubSubIssues } = require("../src/github");

function issue(number, state = "OPEN", repository = "owner/repo") {
  return { number: Number(number), state, title: `Issue ${number}`, body: `Requirements for ${number}`, labels: [], updatedAt: `2026-09-${String(number).padStart(2, "0")}T00:00:00Z`, repository };
}

function analysis(issueIds = ["1"]) {
  return {
    output: { version: 1, dependencies: [], conflicts: [], work: [], waves: [], unresolved: [] },
    metadata: { analyzer: "agent", provider: "codex", contextDigest: "a".repeat(64), outputDigest: "b".repeat(64), attempts: 1, issueIds, files: [] }
  };
}

test("workset schema preserves legacy manifests and validates canonical repository-qualified sources", () => {
  assert.doesNotThrow(() => validateRepositoryConfig({ repository: "owner/repo", work: {} }));
  const manifest = {
    repository: "owner/repo",
    work: { "7": { status: "ready" } },
    worksets: {
      release: epicWorkset("owner/repo", "42"),
      selected: issueWorkset("owner/repo", ["7"])
    }
  };
  assert.equal(validateRepositoryConfig(manifest), manifest);
  assert.throws(() => validateRepositoryConfig({ ...manifest, worksets: { Bad: manifest.worksets.release } }), /property name must be valid/);
});

test("GitHub sub-issue adapter fetches every REST page without relying on newer gh flags", async () => {
  const calls = [];
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, repository_url: "https://api.github.com/repos/owner/repo" }));
  const issues = await loadGitHubSubIssues("owner/repo", "42", {
    repoPath: "/repo",
    runner: async (_command, args) => {
      calls.push(args);
      return { stdout: JSON.stringify(args.at(-1).endsWith("page=1") ? pageOne : [{ number: 101, repository_url: "https://api.github.com/repos/owner/repo" }]) };
    }
  });
  assert.equal(issues.length, 101);
  assert.equal(calls.length, 2);
  assert.equal(issues[100].repository, "owner/repo");
});

test("epic resolution walks nested documented relationships and keeps the parent as read-only context", async () => {
  const records = new Map([["42", issue(42)], ["7", issue(7)], ["8", issue(8, "CLOSED")], ["9", issue(9)]]);
  const children = new Map([
    ["42", [{ number: 7, repository: "owner/repo" }, { number: 8, repository: "owner/repo" }]],
    ["7", [{ number: 9, repository: "owner/repo" }]],
    ["8", []], ["9", []]
  ]);
  const scope = await resolveWorksetScope("release", epicWorkset("owner/repo", "42"), {
    repository: "owner/repo",
    issueLoader: async (_repo, ids) => ids.map((id) => records.get(String(id))),
    subIssueLoader: async (_repo, id) => children.get(String(id))
  });

  assert.equal(scope.complete, true);
  assert.deepEqual(scope.issueIds, ["7", "8", "9"]);
  assert.equal(scope.parent.number, "42");
  assert.equal(scope.parent.body, "Requirements for 42");
  assert.equal(scope.issues.find((entry) => entry.number === 8).state, "CLOSED");
  assert.match(scope.revision, /^[a-f0-9]{64}$/);
});

test("epic resolution fails closed for cycles, duplicate paths, cross-repository children, missing children, and empty scopes", async () => {
  const records = new Map([["42", issue(42)], ["7", issue(7)], ["8", issue(8)]]);
  const scope = await resolveWorksetScope("unsafe", epicWorkset("owner/repo", "42"), {
    repository: "owner/repo",
    issueLoader: async (_repo, ids) => {
      const record = records.get(String(ids[0]));
      if (!record) throw new Error("not found");
      return [record];
    },
    subIssueLoader: async (_repo, id) => ({
      "42": [{ number: 7, repository: "owner/repo" }, { number: 8, repository: "other/repo" }, { number: 99, repository: "owner/repo" }],
      "7": [{ number: 42, repository: "owner/repo" }, { number: 7, repository: "owner/repo" }]
    }[String(id)] || [])
  });
  assert.equal(scope.complete, false);
  assert.deepEqual(new Set(scope.diagnostics.map((entry) => entry.type)), new Set(["cross-repository", "missing-or-inaccessible", "cycle"]));

  const empty = await resolveWorksetScope("empty", epicWorkset("owner/repo", "42"), {
    repository: "owner/repo",
    issueLoader: async () => [issue(42)],
    subIssueLoader: async () => []
  });
  assert.equal(empty.diagnostics.at(-1).type, "empty");
});

test("scope resolution captures outside prerequisites as read-only facts and rejects cross-repository dependency identity", async () => {
  const records = new Map([
    ["42", issue(42)],
    ["7", { ...issue(7), body: "Blocked by #10." }],
    ["10", issue(10)]
  ]);
  const definition = epicWorkset("owner/repo", "42");
  const options = {
    repository: "owner/repo",
    issueLoader: async (_repo, ids) => [records.get(String(ids[0]))],
    subIssueLoader: async (_repo, id) => String(id) === "42" ? [{ number: 7, repository: "owner/repo" }] : []
  };
  const scope = await resolveWorksetScope("release", definition, options);
  assert.equal(scope.complete, true);
  assert.deepEqual(scope.issueIds, ["7"]);
  assert.deepEqual(scope.supportingIssueIds, ["10"]);

  records.set("7", { ...issue(7), body: "Blocked by other/repo#10." });
  const unsafe = await resolveWorksetScope("release", definition, options);
  assert.equal(unsafe.complete, false);
  assert.equal(unsafe.diagnostics.find((entry) => entry.type === "cross-repository-dependency").issue.repository, "other/repo");
});

test("scoped planning selects only members, retains outside prerequisites, and excludes unrelated ready work", () => {
  const config = {
    repository: "owner/repo",
    defaultConcurrency: 3,
    work: {
      "1": { status: "ready" },
      "2": { status: "ready", blockedBy: ["10"] },
      "10": { status: "ready" },
      "99": { status: "ready" }
    }
  };
  const plan = computePlan(config, { issueIds: ["1", "2"], workset: "release", scopeRevision: "rev" });
  assert.deepEqual(plan.selected.map((entry) => entry.id), ["1"]);
  assert.deepEqual(plan.blocked[0].outsideScope, ["10"]);
  assert.equal(plan.ready.some((entry) => entry.id === "99"), false);
  assert.deepEqual(plan.authorizedIssueIds, ["1", "2"]);
});

test("scoped planning fails closed when an authorized member is absent from the shared graph", () => {
  assert.throws(() => computePlan({
    repository: "owner/repo",
    work: { "1": { status: "ready" } }
  }, { issueIds: ["1", "2"], workset: "release", scopeRevision: "rev" }), /authorized issue #2 is absent from the shared work graph/);
});

test("workset draft reconciles an outside prerequisite into the shared graph without authorizing it", () => {
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "99": { status: "ready" } } },
    issues: [{ ...issue(2), body: "Blocked by #10." }, issue(10)],
    selectedIssueIds: ["2"],
    supportingIssueIds: ["10"],
    worksetProposal: { name: "release", definition: issueWorkset("owner/repo", ["2"]) }
  });
  assert.deepEqual(result.manifest.work["2"].blockedBy, ["10"]);
  assert.equal(result.manifest.work["10"].status, "ready");
  assert.deepEqual(result.planning.waves, []);
  assert.equal(result.writable, true);
  const plan = computePlan(result.manifest, { issueIds: ["2"], workset: "release", scopeRevision: "r" });
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.blocked[0].outsideScope, ["10"]);
});

test("closed workset members are retained as inactive and reopen through the shared lifecycle", () => {
  const definition = issueWorkset("owner/repo", ["7"]);
  const closed = proposeDraft({
    repository: "owner/repo",
    issues: [issue(7, "CLOSED")],
    selectedIssueIds: ["7"],
    worksetProposal: { name: "release", definition }
  });
  assert.equal(closed.manifest.work["7"].status, "inactive");
  const reopened = proposeDraft({
    repository: "owner/repo",
    existingConfig: closed.manifest,
    issues: [issue(7, "OPEN")],
    selectedIssueIds: ["7"],
    worksetProposal: { name: "release", definition }
  });
  assert.equal(reopened.manifest.work["7"].status, "ready");
  assert.equal(reopened.manifest.work["7"].reconciliationHistory.at(-1).reason, "GitHub issue reopened.");
});

test("global lifecycle and active conflicts still protect an issue selected by multiple worksets", () => {
  const config = {
    repository: "owner/repo",
    planning: { advisoryConflicts: [{ issues: ["1", "99"], confidence: "high", source: "paths", reason: "same files", analyzer: "test" }] },
    work: { "1": { status: "ready" }, "99": { status: "ready" } }
  };
  const states = [{ runId: "20260912010101-aaaaaa", status: "running", mode: "execute", plan: { selected: [{ id: "99" }] }, workers: [], validations: [], reviews: {} }];
  const plan = reconcilePlan(config, states, { issueIds: ["1"], workset: "one", scopeRevision: "r" });
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.deferred[0].lifecycle.state, "active-conflict");

  const shared = reconcilePlan(config, [{ ...states[0], plan: { selected: [{ id: "1" }] } }], { issueIds: ["1"], workset: "two", scopeRevision: "r" });
  assert.deepEqual(shared.selected, []);
  assert.equal(shared.deferred[0].lifecycle.state, "running");
});

test("workset drafting preserves other definitions and scoped agent evidence while reporting shared explicit members", () => {
  const existing = {
    repository: "owner/repo",
    work: { "1": { status: "ready" } },
    worksets: { other: issueWorkset("owner/repo", ["1"]) },
    planning: { agentAnalyses: { other: { ...analysis().metadata, recommendations: analysis().output } } }
  };
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: existing,
    issues: [issue(1)],
    selectedIssueIds: ["1"],
    worksetProposal: { name: "release", definition: issueWorkset("owner/repo", ["1"]) },
    analysisScope: "release",
    agentAnalysis: analysis()
  });
  assert.deepEqual(result.manifest.worksets.other, existing.worksets.other);
  assert.deepEqual(result.manifest.planning.agentAnalyses.other, existing.planning.agentAnalyses.other);
  assert.equal(result.manifest.planning.agentAnalyses.release.provider, "codex");
  assert.deepEqual(result.workset.sharedIssueEffects, ["1"]);
  assert.equal(result.manifest.planning.agentAnalysis, undefined);
});

test("scoped agent changes are bounded to members and scoped conflict evidence has an independent owner", () => {
  const recommendation = analysis(["1"]);
  recommendation.output.dependencies = [{ issue: "1", blockedBy: "10", confidence: "high", reason: "Needs prerequisite.", evidence: ["issue"] }];
  recommendation.output.conflicts = [
    { issues: ["1", "10"], confidence: "high", reason: "Shared files.", evidence: ["tree"] },
    { issues: ["10", "99"], confidence: "high", reason: "Outside only.", evidence: ["tree"] }
  ];
  const result = proposeDraft({
    repository: "owner/repo",
    existingConfig: { repository: "owner/repo", work: { "1": { status: "ready" }, "10": { status: "ready" }, "99": { status: "ready" } } },
    issues: [issue(1), issue(10)],
    selectedIssueIds: ["1"],
    supportingIssueIds: ["10"],
    worksetProposal: { name: "release", definition: issueWorkset("owner/repo", ["1"]) },
    analysisScope: "release",
    agentAnalysis: recommendation
  });
  assert.deepEqual(result.manifest.work["1"].blockedBy, ["10"]);
  assert.equal(result.manifest.planning.advisoryConflicts[0].analyzer, "agent:release");
  assert.equal(result.manifest.planning.advisoryConflicts.some((entry) => entry.issues.includes("99")), false);
  assert.match(result.diagnostics.at(-1).reason, /does not involve a selected workset member/);
  assert.equal(result.writable, false);
});

test("scoped configured analyzers add and remove cross-boundary conflicts using repository-wide context", () => {
  const definition = issueWorkset("owner/repo", ["1"]);
  const configured = {
    repository: "owner/repo",
    work: { "1": { status: "ready" }, "99": { status: "ready" } },
    planning: { analyzers: [{ type: "shared-label", labels: ["area:api"] }] }
  };
  const withConflict = proposeDraft({
    repository: "owner/repo",
    existingConfig: configured,
    issues: [{ ...issue(1), labels: ["area:api"] }, { ...issue(99), labels: ["area:api"] }],
    selectedIssueIds: ["1"],
    worksetProposal: { name: "release", definition }
  });
  assert.deepEqual(withConflict.manifest.planning.advisoryConflicts.map((entry) => entry.issues), [["1", "99"]]);

  const withoutConflict = proposeDraft({
    repository: "owner/repo",
    existingConfig: withConflict.manifest,
    issues: [{ ...issue(1), labels: ["area:api"] }, { ...issue(99), labels: [] }],
    selectedIssueIds: ["1"],
    worksetProposal: { name: "release", definition }
  });
  assert.equal(withoutConflict.manifest.planning.advisoryConflicts, undefined);
  assert.deepEqual(withoutConflict.manifest.planning.analyzers, configured.planning.analyzers);
});

test("scope snapshots live outside the manifest and execution records explicit authorization", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-workset-test-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  const snapshot = { version: 1, name: "release", definition: epicWorkset("owner/repo", "42"), issueIds: ["1"], membership: [{ repository: "owner/repo", number: "1" }], diagnostics: [], complete: true, revision: "r" };
  await saveScopeSnapshot(repoPath, "release", snapshot);
  assert.deepEqual((await loadScopeSnapshot(repoPath, "release")).issueIds, ["1"]);

  const saved = [];
  const result = await executeRun({ repository: "owner/repo", work: {} }, {
    repoPath,
    runId: "run-empty",
    plan: { selected: [] },
    scope: { workset: "release", authorizedIssueIds: ["1"], revision: "r", source: "explicit-workset-launch" },
    stateSaver: async (_repo, _run, state) => saved.push(state)
  });
  assert.equal(result.status, "no-ready-work");
  assert.equal(saved[0].scope.workset, "release");
  assert.equal(saved[0].scope.source, "explicit-workset-launch");
});

test("scoped draft persistence leaves both artifacts unchanged when either persistence stage fails", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-scoped-persistence-test-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  const manifestPath = path.join(repoPath, ".maestro.json");
  const originalManifest = `${JSON.stringify({ repository: "owner/repo", work: { "1": { status: "ready" } } }, null, 2)}\n`;
  const originalScope = { version: 1, name: "release", definition: issueWorkset("owner/repo", ["1"]), issueIds: ["1"], membership: [{ repository: "owner/repo", number: "1" }], diagnostics: [], complete: true, revision: "old" };
  fs.writeFileSync(manifestPath, originalManifest);
  await saveScopeSnapshot(repoPath, "release", originalScope);
  const scopeFile = path.join(reportRootForRepo(repoPath), "scope-release.json");
  const originalScopeContents = fs.readFileSync(scopeFile, "utf8");
  const nextManifest = { repository: "owner/repo", work: { "1": { status: "ready" }, "2": { status: "ready" } }, worksets: { release: issueWorkset("owner/repo", ["1", "2"]) } };
  const nextScope = { ...originalScope, definition: nextManifest.worksets.release, issueIds: ["1", "2"], membership: [{ repository: "owner/repo", number: "1" }, { repository: "owner/repo", number: "2" }], revision: "new" };

  for (const stage of ["manifest", "scope"]) {
    assert.throws(() => persistScopedDraft({
      repoPath,
      manifestPath,
      manifest: nextManifest,
      expectedManifestContents: originalManifest,
      expectedSnapshotContents: originalScopeContents,
      name: "release",
      snapshot: nextScope
    }, {
      beforeManifestPersist: stage === "manifest" ? () => { throw new Error("injected manifest failure"); } : undefined,
      beforeScopePersist: stage === "scope" ? () => { throw new Error("injected scope failure"); } : undefined
    }), new RegExp(`injected ${stage} failure`));
    assert.equal(fs.readFileSync(manifestPath, "utf8"), originalManifest, `${stage} failure changed the manifest`);
    assert.equal(fs.readFileSync(scopeFile, "utf8"), originalScopeContents, `${stage} failure changed the scope snapshot`);
  }
});

test("scoped draft persistence rejects a stale snapshot-only refresh under the manifest lock", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-scope-cas-test-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  const manifestPath = path.join(repoPath, ".maestro.json");
  const manifest = { repository: "owner/repo", work: { "1": { status: "ready" } }, worksets: { release: issueWorkset("owner/repo", ["1"]) } };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, manifestText);
  const original = { version: 1, name: "release", definition: manifest.worksets.release, issueIds: ["1"], membership: [{ repository: "owner/repo", number: "1" }], diagnostics: [], complete: true, revision: "old" };
  await saveScopeSnapshot(repoPath, "release", original);
  const scopeFile = path.join(reportRootForRepo(repoPath), "scope-release.json");
  const expectedScope = fs.readFileSync(scopeFile, "utf8");

  persistScopedDraft({
    repoPath, manifestPath, manifest, persistManifest: false,
    expectedManifestContents: manifestText,
    expectedSnapshotContents: expectedScope,
    name: "release", snapshot: { ...original, revision: "first" }
  }, { now: () => new Date("2026-09-13T12:00:00Z") });
  const firstWrite = fs.readFileSync(scopeFile, "utf8");

  assert.throws(() => persistScopedDraft({
    repoPath, manifestPath, manifest, persistManifest: false,
    expectedManifestContents: manifestText,
    expectedSnapshotContents: expectedScope,
    name: "release", snapshot: { ...original, revision: "stale-second" }
  }), /scope snapshot changed after reconciliation was proposed/);
  assert.equal(fs.readFileSync(scopeFile, "utf8"), firstWrite);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestText);
});

test("draft --epic writes a definition and snapshot while plan --workset excludes unrelated work", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-workset-cli-test-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  fs.writeFileSync(path.join(repoPath, ".maestro.json"), JSON.stringify({ repository: "owner/repo", work: { "99": { status: "ready" } } }));
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args.at(-1);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue" && args[1] === "view") {
  const number = Number(args[2]);
  process.stdout.write(JSON.stringify({number,state:"OPEN",title:"Issue "+number,body:number === 42 ? "Epic acceptance" : "",labels:[],updatedAt:"2026-09-12T00:00:00Z"}));
} else if (args[0] === "api" && endpoint.includes("sub_issues")) {
  process.stdout.write(endpoint.includes("/42/") ? '[{"number":7,"repository_url":"https://api.github.com/repos/owner/repo"}]' : '[]');
} else if (args[0] === "api") {
  const number = Number(endpoint.split("/").at(-1));
  process.stdout.write(JSON.stringify({number,state_reason:null}));
} else process.exit(3);
`, { mode: 0o755 });
  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const env = { ...process.env, PATH: `${binPath}${path.delimiter}${process.env.PATH}` };
  const drafted = spawnSync(process.execPath, [cli, "draft", "--epic", "42", "--name", "release", "--write"], { cwd: repoPath, env, encoding: "utf8" });
  assert.equal(drafted.status, 0, drafted.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(repoPath, ".maestro.json"), "utf8"));
  assert.equal(manifest.worksets.release.source.issue.number, "42");
  assert.equal(manifest.work["7"].status, "ready");
  assert.deepEqual((await loadScopeSnapshot(repoPath, "release")).issueIds, ["7"]);

  const planned = spawnSync(process.execPath, [cli, "plan", "--workset", "release"], { cwd: repoPath, env, encoding: "utf8" });
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(JSON.parse(planned.stdout).selected.map((entry) => entry.id), ["7"]);
});

test("start --workset rejects membership, requirement, and outside-prerequisite drift without creating a run", async (t) => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-workset-launch-test-"));
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }));
  const binPath = path.join(repoPath, "bin");
  fs.mkdirSync(binPath);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  fs.writeFileSync(path.join(repoPath, ".maestro.json"), JSON.stringify({ repository: "owner/repo", work: { "99": { status: "ready" } } }));
  fs.writeFileSync(path.join(binPath, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args.at(-1);
const facts = JSON.parse(process.env.MAESTRO_TEST_FACTS);
const children = JSON.parse(process.env.MAESTRO_TEST_CHILDREN);
if (args[0] === "repo") process.stdout.write('{"nameWithOwner":"owner/repo"}');
else if (args[0] === "issue" && args[1] === "view") process.stdout.write(JSON.stringify(facts[args[2]]));
else if (args[0] === "api" && endpoint.includes("sub_issues")) {
  const number = endpoint.match(/issues\\/(\\d+)\\/sub_issues/)[1];
  process.stdout.write(JSON.stringify((children[number] || []).map((child) => ({number:child,repository_url:"https://api.github.com/repos/owner/repo"}))));
} else if (args[0] === "api") {
  const number = endpoint.split("/").at(-1);
  process.stdout.write(JSON.stringify({number:Number(number),state_reason:null}));
} else process.exit(3);
`, { mode: 0o755 });
  const fact = (number, overrides = {}) => ({ number, state: "OPEN", title: `Issue ${number}`, body: "", labels: [], updatedAt: "2026-09-12T00:00:00Z", ...overrides });
  const baselineFacts = {
    "42": fact(42, { body: "Epic acceptance" }),
    "7": fact(7, { body: "Blocked by #10" }),
    "10": fact(10, { title: "Outside prerequisite" }),
    "8": fact(8),
    "99": fact(99)
  };
  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const baseEnv = {
    ...process.env,
    PATH: `${binPath}${path.delimiter}${process.env.PATH}`,
    MAESTRO_TEST_FACTS: JSON.stringify(baselineFacts),
    MAESTRO_TEST_CHILDREN: JSON.stringify({ "42": [7] })
  };
  const drafted = spawnSync(process.execPath, [cli, "draft", "--epic", "42", "--name", "release", "--write"], { cwd: repoPath, env: baseEnv, encoding: "utf8" });
  assert.equal(drafted.status, 0, drafted.stderr);

  const cases = [
    ["membership", { MAESTRO_TEST_CHILDREN: JSON.stringify({ "42": [7, 8] }) }],
    ["requirement", { MAESTRO_TEST_FACTS: JSON.stringify({ ...baselineFacts, "42": fact(42, { body: "Changed epic acceptance" }) }) }],
    ["outside prerequisite", { MAESTRO_TEST_FACTS: JSON.stringify({ ...baselineFacts, "10": fact(10, { title: "Changed outside prerequisite" }) }) }]
  ];
  for (const [description, changes] of cases) {
    const started = spawnSync(process.execPath, [cli, "start", "--workset", "release"], { cwd: repoPath, env: { ...baseEnv, ...changes }, encoding: "utf8" });
    assert.equal(started.status, 1, `${description} drift unexpectedly launched:\n${started.stdout}\n${started.stderr}`);
    assert.match(started.stderr, /changed since its saved scope revision/);
    const reportNames = fs.readdirSync(reportRootForRepo(repoPath));
    assert.equal(reportNames.some((name) => name.startsWith("run-")), false, `${description} drift created a run`);
  }

  const manifestPath = path.join(repoPath, ".maestro.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.work["7"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const missingMember = spawnSync(process.execPath, [cli, "start", "--workset", "release"], { cwd: repoPath, env: baseEnv, encoding: "utf8" });
  assert.equal(missingMember.status, 1, missingMember.stdout);
  assert.match(missingMember.stderr, /authorized issue #7 is absent from the shared work graph/);
  assert.equal(fs.readdirSync(reportRootForRepo(repoPath)).some((name) => name.startsWith("run-")), false, "missing member created a run");
});

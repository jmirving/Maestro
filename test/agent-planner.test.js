const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validateAgentOutput, assembleAgentContext, invokeAgentPlanner, createAgentPlanner, plannerPrompt } = require("../src/agent-planner");

function output(overrides = {}) {
  return { version: 1, dependencies: [], conflicts: [], work: [], waves: [], unresolved: [], ...overrides };
}

test("agent planner requires schema-valid structured output with evidence", () => {
  const valid = output();
  assert.equal(validateAgentOutput(valid), valid);
  assert.throws(() => validateAgentOutput(output({ dependencies: [{ issue: "2", blockedBy: "1", confidence: "high", reason: "Ordering." }] })), /structured-output schema.*evidence/);
  assert.throws(() => validateAgentOutput({ version: 1 }), /structured-output schema/);
});

test("agent context is bounded, reproducible, and records source digests", async () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-agent-context-"));
  fs.writeFileSync(path.join(repoPath, "AGENTS.md"), "rules\n");
  fs.mkdirSync(path.join(repoPath, "src"));
  fs.writeFileSync(path.join(repoPath, "src", "app.js"), "x".repeat(100));
  const runner = async () => ({ code: 0, stdout: "src/app.js\0AGENTS.md\0ignored.secret\0", stderr: "" });
  const args = { repoPath, repository: "owner/repo", issues: [{ number: 1, state: "OPEN", title: "One", body: "Body", labels: [] }], manifest: { repository: "owner/repo", work: { "1": { status: "ready" } } }, deterministicFindings: {}, runner, maxBytes: 3700 };
  const first = await assembleAgentContext(args);
  const second = await assembleAgentContext(args);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.context.repositoryTree, ["AGENTS.md", "ignored.secret", "src/app.js"]);
  assert.deepEqual(first.files.map((file) => file.path), ["AGENTS.md", "src/app.js"]);
  assert.equal(first.files[1].truncated, true);
  assert.equal(JSON.stringify(first.context).includes("ignored.secret"), true);
  assert.equal(first.context.files.some((file) => file.path === "ignored.secret"), false);
  assert.equal(Buffer.byteLength(`${plannerPrompt(first.context)}\n`) <= args.maxBytes, true);
});

test("agent context aggregate limit rejects an oversized manifest before invocation", async () => {
  let invoked = false;
  const planner = createAgentPlanner({
    maxContextBytes: 1024,
    contextRunner: async () => ({ code: 0, stdout: "", stderr: "" }),
    runner: async () => {
      invoked = true;
      throw new Error("must not invoke Codex");
    }
  });
  await assert.rejects(() => planner.analyze({
    repoPath: os.tmpdir(),
    repository: "owner/repo",
    issues: [],
    manifest: { repository: "owner/repo", work: { "1": { status: "ready", note: "x".repeat(1024 * 1024) } } },
    deterministicFindings: {}
  }), /aggregate limit is 1024 bytes/);
  assert.equal(invoked, false);
});

test("agent invocation retries, isolates user-configured tools and hooks, and returns auditable metadata", async () => {
  const contextBundle = { context: { issues: [{ number: 2 }] }, digest: "a".repeat(64), files: [] };
  let calls = 0;
  const expected = output({ dependencies: [{ issue: "2", blockedBy: "1", confidence: "high", reason: "API follows core.", evidence: ["docs/architecture.md"] }] });
  const runner = async (_command, args) => {
    calls += 1;
    assert.equal(args.includes("--skip-git-repo-check"), true);
    assert.equal(args.includes("--ephemeral"), true);
    assert.equal(args.includes("--ignore-user-config"), true);
    assert.equal(args.includes("--ignore-rules"), true);
    assert.equal(args.includes("--output-schema"), true);
    assert.equal(args.includes("shell_environment_policy.inherit=none"), true);
    assert.equal(args.includes("mcp_servers={}"), true);
    assert.equal(args.includes("hooks={}"), true);
    assert.equal(args.includes("apps._default.enabled=false"), true);
    assert.equal(args.includes("tools.web_search=false"), true);
    assert.equal(args.includes("features.shell_tool=false"), true);
    if (calls === 1) return { code: 1, stdout: "", stderr: "temporary failure" };
    await fsp.writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(expected));
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await invokeAgentPlanner({ contextBundle, runner, command: "test-codex", retries: 1, timeoutMs: 25, maxOutputBytes: 4096 });
  assert.deepEqual(result.output, expected);
  assert.equal(result.metadata.attempts, 2);
  assert.equal(result.metadata.provider, "test-codex");
  assert.match(result.metadata.outputDigest, /^[a-f0-9]{64}$/);
});

test("agent timeout and invalid output fail with actionable bounded diagnostics", async () => {
  const contextBundle = { context: { issues: [] }, digest: "b".repeat(64), files: [] };
  await assert.rejects(() => invokeAgentPlanner({ contextBundle, retries: 0, timeoutMs: 12, runner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }) }), /timed out after 12ms/);
  await assert.rejects(() => invokeAgentPlanner({ contextBundle, retries: 0, runner: async (_command, args) => {
    await fsp.writeFile(args[args.indexOf("--output-last-message") + 1], "not-json");
    return { code: 0, stdout: "", stderr: "" };
  } }), /returned invalid JSON/);
});

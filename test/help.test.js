const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { COMMANDS } = require("../src/command-registry");
const { parseInvocation, renderTopLevelHelp, resolveHelp } = require("../src/help");

const CLI = path.resolve(__dirname, "../bin/maestro.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maestro-help-test-"));
}

function invoke(cwd, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

test("help cannot invoke repository, GitHub, or agent executables", () => {
  const repoPath = tempDir();
  const binPath = path.join(repoPath, "fake-bin");
  const manifestPath = path.join(repoPath, ".maestro.json");
  fs.mkdirSync(binPath);
  fs.writeFileSync(manifestPath, '{"repository":"owner/repo","work":{"57":{"status":"ready"}}}\n');
  const originalManifest = fs.readFileSync(manifestPath, "utf8");
  for (const executable of ["git", "gh", "codex"]) {
    const marker = path.join(repoPath, `${executable}-invoked`);
    const shim = path.join(binPath, executable);
    fs.writeFileSync(shim, `#!/bin/sh\nprintf invoked > '${marker}'\nexit 99\n`);
    fs.chmodSync(shim, 0o755);
  }

  const result = spawnSync(process.execPath, [CLI, "start", "--help"], {
    cwd: repoPath,
    env: { ...process.env, PATH: binPath },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), originalManifest);
  for (const executable of ["git", "gh", "codex"]) {
    assert.equal(fs.existsSync(path.join(repoPath, `${executable}-invoked`)), false);
  }
});

test("top-level help teaches the workflow and separates everyday commands from advanced controls", () => {
  const text = renderTopLevelHelp();
  assert.match(text, /draft → plan → start → status\/details → rework or approve → commit → next/);
  assert.match(text, /Planning:\n[\s\S]*draft[\s\S]*plan/);
  assert.match(text, /Execution:\n[\s\S]*start \(s\)[\s\S]*next \(n\)/);
  assert.match(text, /Inspection:\n[\s\S]*status \(st\)[\s\S]*details[\s\S]*output \(o\)/);
  assert.match(text, /Review:\n[\s\S]*approve \(a\)[\s\S]*rework[\s\S]*discard/);
  assert.match(text, /Integration:\n[\s\S]*commit \(c\)/);
  assert.match(text, /Advanced \/ debugging:\n[\s\S]*run[\s\S]*reconcile[\s\S]*integrate-run/);
  assert.match(text, /start\/next never integrate/);
});

test("help works outside a Git checkout and both command forms are identical", () => {
  const outsideRepo = tempDir();
  const top = invoke(outsideRepo, "help");
  const explicit = invoke(outsideRepo, "help", "start");
  const flag = invoke(outsideRepo, "start", "--help");
  const recovery = invoke(outsideRepo, "reconcile", "--help");

  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /Normal workflow/);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(flag.status, 0, flag.stderr);
  assert.equal(flag.stdout, explicit.stdout);
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.match(recovery.stdout, /Git conflict recovery/);
  assert.match(recovery.stdout, /does not approve, complete, or integrate/i);
  assert.deepEqual(fs.readdirSync(outsideRepo), []);
});

test("command help documents operational state boundaries and realistic next actions", () => {
  const start = invoke(tempDir(), "help", "s");
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /State requirements/);
  assert.match(start.stdout, /State changes/);
  assert.match(start.stdout, /Does not approve, integrate, push the default branch, or close issues/);
  assert.match(start.stdout, /maestro status/);

  const approve = invoke(tempDir(), "approve", "--help");
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(approve.stdout, /Validator approval is not human approval/);
  assert.match(approve.stdout, /--override requires explicit issues/);

  const workflow = invoke(tempDir(), "help", "workflow");
  assert.equal(workflow.status, 0, workflow.stderr);
  assert.match(workflow.stdout, /A saved draft is scope, not launch or integration authorization/);
  assert.match(workflow.stdout, /No ready work/);
  assert.match(workflow.stdout, /Advanced compatibility/);
  assert.match(workflow.stdout, /maestro run --continuous/);
});

test("every registered help example passes the same pre-dispatch syntax parser as the CLI", () => {
  for (const command of COMMANDS) {
    assert.equal(resolveHelp(["help", command.name]).text, resolveHelp([command.name, "--help"]).text);
    assert.ok(command.examples.length >= 1, `${command.name} must register an example`);
    assert.ok(command.examples.length <= 2, `${command.name} should keep terminal help to at most two examples`);
    for (const example of command.examples) {
      const parsed = parseInvocation(example);
      assert.equal(parsed.command, command.name, `invalid example: maestro ${example.join(" ")}`);
      if (command.category !== "Advanced / debugging") {
        assert.equal(example.includes("--run"), false, `everyday example should not require a run ID: maestro ${example.join(" ")}`);
      }
    }
  }
});

test("aliases and important documented flags are accepted by the shared registry", () => {
  assert.equal(parseInvocation(["s"]).command, "start");
  assert.equal(parseInvocation(["st", "57", "--watch"]).command, "status");
  assert.equal(parseInvocation(["a", "57", "--override"]).command, "approve");
  assert.equal(parseInvocation(["run", "--continuous", "--allow-failing-baseline"]).command, "run");
  assert.equal(parseInvocation(["review", "--run", "run-1", "--issue", "57", "--disposition", "approve"]).command, "review");
  assert.throws(() => parseInvocation(["run", "--execute", "--integrate"]), /only one/);
  assert.throws(() => parseInvocation(["approve", "--override"]), /explicit issue numbers/);
  assert.throws(() => parseInvocation(["plan", "--repo-path", "../target", "config.json"]), /manifest path.*first argument/);
  assert.throws(() => parseInvocation(["details"]), /requires at least 1 issue number/);
  assert.throws(() => parseInvocation(["discard"]), /explicit issue number/);
  assert.throws(() => parseInvocation(["reconcile"]), /requires --run/);
  assert.throws(() => parseInvocation(["review", "--run", "run-1", "--issue", "not-an-issue", "--disposition", "approve"]), /positive issue number/);
});

test("unknown commands and options fail before repository discovery with actionable help", () => {
  const outsideRepo = tempDir();
  const command = invoke(outsideRepo, "frobnicate");
  const option = invoke(outsideRepo, "start", "--frobnicate");
  const topic = invoke(outsideRepo, "help", "frobnicate");

  assert.equal(command.status, 1);
  assert.match(command.stderr, /Unknown Maestro command: frobnicate.*maestro help/s);
  assert.doesNotMatch(command.stderr, /could not find a Git repository/i);
  assert.equal(option.status, 1);
  assert.match(option.stderr, /Unknown option.*maestro help start/s);
  assert.doesNotMatch(option.stderr, /manifest not found/i);
  assert.equal(topic.status, 1);
  assert.match(topic.stderr, /Unknown Maestro command or help topic/);
  assert.deepEqual(fs.readdirSync(outsideRepo), []);
});

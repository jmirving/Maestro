const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { proposeDraft } = require("../src/draft");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

function issue(number) {
  return {
    number,
    state: "OPEN",
    stateReason: null,
    closedAt: null,
    updatedAt: "2026-09-19T12:00:00Z",
    title: `Issue ${number}`,
    body: "",
    labels: []
  };
}

test("ordinary start backfills a freed slot before a slow original sibling finishes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-start-backfill-"));
  const repoPath = path.join(root, "target");
  const originPath = path.join(root, "origin.git");
  const binPath = path.join(root, "bin");
  const eventPath = path.join(root, "events.log");
  await fs.mkdir(repoPath);
  await fs.mkdir(binPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  run("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
  run("git", ["config", "user.name", "Test"], { cwd: repoPath });
  run("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "tracked.txt"), "base\n");
  run("git", ["add", "tracked.txt"], { cwd: repoPath });
  run("git", ["commit", "-qm", "base"], { cwd: repoPath });
  run("git", ["clone", "-q", "--bare", repoPath, originPath]);
  run("git", ["remote", "add", "origin", originPath], { cwd: repoPath });

  const issues = [issue(1), issue(2), issue(3)];
  const manifest = proposeDraft({ repository: "owner/repo", issues }).manifest;
  manifest.defaultBranch = "main";
  manifest.defaultConcurrency = 2;
  await fs.writeFile(path.join(repoPath, ".maestro.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  await fs.writeFile(path.join(binPath, "gh"), `#!/usr/bin/env node
const issues = JSON.parse(process.env.MAESTRO_TEST_ISSUES);
const args = process.argv.slice(2);
if (args[0] === "repo") process.stdout.write(JSON.stringify({ nameWithOwner: "owner/repo" }));
else if (args[0] === "issue" && args[1] === "view") process.stdout.write(JSON.stringify(issues.find((item) => String(item.number) === args[2])));
else if (args[0] === "api") {
  const number = args[1].split("/").at(-1);
  process.stdout.write(JSON.stringify({ number: Number(number), state_reason: null }));
} else process.exit(2);
`);
  await fs.writeFile(path.join(binPath, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const reportIndex = args.indexOf("--output-last-message");
const reportPath = args[reportIndex + 1];
if (args.includes("read-only")) {
  fs.writeFileSync(reportPath, "VERDICT: APPROVE\\n");
  process.exit(0);
}
const issue = path.basename(process.cwd()).match(/^(\\d+)-/)[1];
fs.appendFileSync(process.env.MAESTRO_TEST_EVENTS, "start " + issue + "\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, issue === "2" ? 1200 : 75);
const filename = "issue-" + issue + ".txt";
fs.writeFileSync(filename, "issue " + issue + "\\n");
spawnSync("git", ["add", filename], { stdio: "inherit" });
spawnSync("git", ["commit", "-qm", "implement " + issue], { stdio: "inherit" });
fs.appendFileSync(process.env.MAESTRO_TEST_EVENTS, "finish " + issue + "\\n");
fs.writeFileSync(reportPath, "Result: complete\\n");
`);
  await fs.chmod(path.join(binPath, "gh"), 0o755);
  await fs.chmod(path.join(binPath, "codex"), 0o755);

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const result = run(process.execPath, [cli, "start", "--repo-path", repoPath], {
    cwd: repoPath,
    env: {
      ...process.env,
      PATH: `${binPath}${path.delimiter}${process.env.PATH}`,
      MAESTRO_TEST_ISSUES: JSON.stringify(issues),
      MAESTRO_TEST_EVENTS: eventPath
    }
  });
  const output = JSON.parse(result.stdout.split("\n\nIssue #", 1)[0]);
  const events = (await fs.readFile(eventPath, "utf8")).trim().split("\n");

  assert.deepEqual(output.plan.selected.map((item) => item.id), ["1", "2"]);
  assert.deepEqual(output.backfill.map((entry) => entry.plan.selected[0].id), ["3"]);
  assert.ok(events.indexOf("start 3") > events.indexOf("finish 1"), events.join(", "));
  assert.ok(events.indexOf("start 3") < events.indexOf("finish 2"), events.join(", "));
});

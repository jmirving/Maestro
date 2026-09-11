const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { statusSnapshot, formatStatus } = require("../src/display");
const { saveRunState } = require("../src/run-store");

function mixedRun({ reviewed = false } = {}) {
  return {
    runId: "20260910010101-aaaaaa",
    mode: "execute",
    status: "awaiting-review",
    plan: { selected: [{ id: "2", title: "Passing change" }, { id: "7", title: "Needs correction" }] },
    workers: [
      { issue: "2", exitCode: 0, headSha: "approved-commit" },
      { issue: "7", exitCode: 0, headSha: "rework-commit" }
    ],
    validations: [{ issue: "2", verdict: "approve" }, { issue: "7", verdict: "rework" }],
    reviews: reviewed ? {
      "2": { disposition: "approve" },
      "7": { disposition: "rework-original" }
    } : {},
    integration: []
  };
}

const config = {
  repository: "example/repo",
  defaultConcurrency: 2,
  work: {
    "2": { status: "ready" },
    "7": { status: "ready" },
    "12": { status: "complete" },
    "13": { status: "blocked", blockedBy: ["2"] }
  }
};

test("mixed status separates validator results from missing human dispositions", async () => {
  const snapshot = await statusSnapshot(config, "/unused", [], { stateLoader: async () => [mixedRun()] });
  const text = formatStatus(snapshot);

  assert.match(text, /Issue #2 — Passing change — validator approved, awaiting human approval/);
  assert.match(text, /Issue #7 — Needs correction — validator requested rework, awaiting human rework disposition/);
  assert.match(text, /Issue #12 — integrated\/complete/);
  assert.match(text, /Issue #13 — blocked, waiting on #2/);
  assert.match(text, /Commit: not ready — #2 needs human approval; #7 needs human rework disposition/);
  assert.match(text, /Recommended: `maestro rework 7`/);
  assert.match(text, /Also available: `maestro details 7`, `maestro approve 2`/);
  assert.match(text, /`maestro review --run 20260910010101-aaaaaa --issue 7 --disposition rework-original`/);
  assert.doesNotMatch(text, /Issue #2 .*— approved$/m);
});

test("reviewed mixed status shows exactly what commit integrates and skips", async () => {
  const snapshot = await statusSnapshot(config, "/unused", [], { stateLoader: async () => [mixedRun({ reviewed: true })] });
  const text = formatStatus(snapshot);

  assert.match(text, /Issue #2 — Passing change — human approved, ready to integrate/);
  assert.match(text, /Issue #7 — Needs correction — human rework disposition recorded, excluded from integration/);
  assert.match(text, /Commit: ready — integrates #2; skips #7 for rework/);
  assert.match(text, /Recommended: `maestro commit`/);
  assert.match(text, /Also available: `maestro rework 7`/);
});

test("focused issue status includes commit, validator, human review, integration, and next action", async () => {
  const snapshot = await statusSnapshot(config, "/unused", ["7"], { stateLoader: async () => [mixedRun()] });
  const text = formatStatus(snapshot);

  assert.match(text, /Issue #7 — Needs correction — validator requested rework, awaiting human rework disposition/);
  assert.match(text, /Worker commit: rework-commit/);
  assert.match(text, /Validator: rework/);
  assert.match(text, /Human review: none/);
  assert.match(text, /Integration: not eligible; record rework-original to exclude it/);
  assert.doesNotMatch(text, /Issue #2 —/);
  assert.match(text, /Recommended: `maestro rework 7`/);
  assert.match(text, /`maestro review --run 20260910010101-aaaaaa --issue 7 --disposition rework-original`/);
  assert.match(text, /Commit: not ready — #2 needs human approval; #7 needs human rework disposition/);
});

test("status CLI accepts issue positionals and resolves the latest relevant run", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-status-cli-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  await fs.writeFile(manifestPath, `${JSON.stringify(config)}\n`);
  await saveRunState(repoPath, mixedRun().runId, mixedRun());

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const result = spawnSync(process.execPath, [cli, "status", "7", "--repo-path", repoPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Issue #7 — Needs correction/);
  assert.doesNotMatch(result.stdout, /Issue #2 —/);
});

test("focused status rejects issues absent from both manifest and persisted workflow", async () => {
  await assert.rejects(
    statusSnapshot(config, "/unused", ["404"], { stateLoader: async () => [mixedRun()] }),
    /No Maestro workflow state for issue #404/
  );
});

test("a child run does not hide the source disposition still required for sibling integration", async () => {
  const source = mixedRun({ reviewed: false });
  source.reviews["2"] = { disposition: "approve" };
  const child = {
    runId: "20260910020202-bbbbbb",
    parentRunId: source.runId,
    mode: "rework",
    status: "awaiting-review",
    plan: { selected: [{ id: "7" }] },
    workers: [{ issue: "7", exitCode: 0, headSha: "child-commit" }],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: {},
    integration: []
  };

  const text = formatStatus(await statusSnapshot(config, "/unused", [], {
    stateLoader: async () => [source, child]
  }));

  assert.match(text, /Commit: not ready — #7 needs human rework disposition/);
  assert.match(text, /maestro review --run 20260910010101-aaaaaa --issue 7 --disposition rework-original/);
});

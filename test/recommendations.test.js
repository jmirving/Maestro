const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { reportRootForRepo } = require("../src/reporter");
const { saveRunState } = require("../src/run-store");
const {
  buildRecommendations,
  formatRecommendations,
  formatRecommendationFooter,
  appendRecommendationFooter
} = require("../src/recommendations");

test("mixed validator results recommend rework and keep inspect and approval commands available", () => {
  const recommendations = buildRecommendations([
    { issue: "2", validator: "approve", humanReview: null },
    { issue: "5", validator: "approve", humanReview: null },
    { issue: "7", validator: "rework", humanReview: null, runId: "run-1" },
    { issue: "12", validator: "approve", humanReview: null }
  ], [{ runId: "run-1", ready: false, missing: [], blocked: [] }], []);

  assert.equal(recommendations.recommended, "maestro rework 7");
  assert.deepEqual(recommendations.alternatives.slice(0, 2), [
    "maestro details 7",
    "maestro approve 2 5 12"
  ]);
  assert.equal(
    formatRecommendations(recommendations),
    "Recommended: `maestro rework 7`\nAlso available: `maestro details 7`, `maestro approve 2 5 12`\n"
  );
});

test("validator approval, human approval, and completed integration produce accepted next commands", () => {
  assert.deepEqual(
    buildRecommendations([{ issue: "7", validator: "approve", humanReview: null }], [], []),
    { recommended: "maestro approve 7", alternatives: ["maestro details 7"] }
  );

  assert.deepEqual(
    buildRecommendations(
      [{ issue: "7", validator: "approve", humanReview: "approve" }],
      [{ runId: "run-1", ready: true, command: "maestro commit", missing: [], blocked: [] }],
      []
    ),
    { recommended: "maestro commit", alternatives: [] }
  );

  assert.deepEqual(
    buildRecommendations([{ issue: "7", validator: "approve", humanReview: "approve" }], [], [{ id: "8" }], {
      states: [{ integration: [{ issue: "7", integratedSha: "integrated" }] }]
    }),
    { recommended: "maestro next", alternatives: [] }
  );

  assert.deepEqual(
    buildRecommendations([], [], [{ id: "8" }]),
    { recommended: "maestro start", alternatives: [] }
  );
});

test("the shareable artifact ends with the same compact issue summary and recommendation footer", () => {
  const snapshot = {
    items: [{ issue: "7", title: "Correction", state: "validator approved, awaiting human approval" }],
    recommendations: { recommended: "maestro approve 7", alternatives: ["maestro details 7"] }
  };
  const text = appendRecommendationFooter("# Maestro run run-1\n\nworker output\n", formatRecommendationFooter(snapshot, { includeIssues: true }));

  assert.match(text, /worker output\n\nIssue #7 — Correction — validator approved, awaiting human approval/);
  assert.ok(text.endsWith("Recommended: `maestro approve 7`\nAlso available: `maestro details 7`\n"));
});

test("maestro output prints and copies the identical artifact including its recommendation footer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-output-footer-"));
  const repoPath = path.join(root, "target");
  const binPath = path.join(root, "bin");
  const clipboardPath = path.join(root, "clipboard.txt");
  const runId = "20260911010101-aaaaaa";
  await fs.mkdir(repoPath);
  await fs.mkdir(binPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repoPath }).status, 0);
  await fs.writeFile(path.join(repoPath, ".maestro.json"), `${JSON.stringify({
    repository: "example/repo",
    work: { "7": { status: "ready", title: "Correction" } }
  })}\n`);
  await saveRunState(repoPath, runId, {
    runId,
    mode: "rework",
    status: "awaiting-review",
    plan: { selected: [{ id: "7", title: "Correction" }] },
    workers: [{ issue: "7", exitCode: 0, headSha: "head-7" }],
    validations: [{ issue: "7", verdict: "approve" }],
    reviews: {}
  });
  const reportRoot = reportRootForRepo(repoPath);
  await fs.writeFile(path.join(reportRoot, `worker-7-${runId}.md`), "worker evidence\n");
  await fs.writeFile(path.join(reportRoot, `validator-7-${runId}.md`), "VERDICT: APPROVE\n");
  const clipboard = path.join(binPath, "wl-copy");
  await fs.writeFile(clipboard, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.MAESTRO_TEST_CLIPBOARD, require("node:fs").readFileSync(0));\n`);
  await fs.chmod(clipboard, 0o755);
  const wslpath = path.join(binPath, "wslpath");
  await fs.writeFile(wslpath, "#!/usr/bin/env node\nprocess.exitCode = 1;\n");
  await fs.chmod(wslpath, 0o755);

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const result = spawnSync(process.execPath, [cli, "output", "--repo-path", repoPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binPath}${path.delimiter}${process.env.PATH}`,
      MAESTRO_TEST_CLIPBOARD: clipboardPath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.endsWith("Recommended: `maestro approve 7`\nAlso available: `maestro details 7`\n"));
  assert.equal(await fs.readFile(clipboardPath, "utf8"), result.stdout);
});

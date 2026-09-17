const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadIssueDetails, formatDetails } = require("../src/details");
const { saveRunState } = require("../src/run-store");

function persistedRun(runId, issue, {
  mode = "execute",
  parentRunId = null,
  verdict = "approve",
  workerReport = "Result: complete",
  validatorReport = "VERDICT: APPROVE",
  disposition = null,
  integrated = false,
  title = null
} = {}) {
  return {
    runId,
    ...(parentRunId ? { parentRunId } : {}),
    mode,
    status: "awaiting-review",
    plan: { selected: [{ id: String(issue), ...(title ? { title } : {}) }] },
    workers: [{
      issue: String(issue),
      status: "worker-finished",
      exitCode: 0,
      baseSha: `base-${issue}`,
      headSha: `head-${issue}-${runId}`,
      branch: `maestro/${issue}-${runId}`,
      worktreePath: `/tmp/${issue}-${runId}`,
      report: workerReport
    }],
    validations: [{ issue: String(issue), exitCode: 0, verdict, report: validatorReport }],
    reviews: disposition ? { [String(issue)]: { disposition, recordedAt: "2026-09-11T12:00:00.000Z" } } : {},
    integration: integrated ? [{ issue: String(issue), branch: `maestro/${issue}`, integratedSha: `merged-${issue}` }] : []
  };
}

async function fixture(t) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "maestro-details-"));
  const repoPath = path.join(root, "target");
  await fsPromises.mkdir(repoPath);
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  return { root, repoPath };
}

test("original issue details resolve the latest relevant run and render persisted evidence", async (t) => {
  const { repoPath } = await fixture(t);
  const relevant = persistedRun("20260910010101-aaaaaa", "7", {
    title: "Explain the scheduler",
    disposition: "approve",
    integrated: true
  });
  const unrelated = persistedRun("20260910020202-bbbbbb", "12");
  await saveRunState(repoPath, relevant.runId, relevant);
  await saveRunState(repoPath, unrelated.runId, unrelated);

  const details = await loadIssueDetails(repoPath, ["7"], {
    config: { work: { "7": { status: "complete" } } }
  });
  const text = formatDetails(details, { repository: "owner/repo" });

  assert.equal(details[0].runId, relevant.runId);
  assert.match(text, /# Issue #7 — Explain the scheduler/);
  assert.match(text, /Provenance: original\/source run/);
  assert.match(text, /Manifest state: complete/);
  assert.match(text, /Commit: head-7-20260910010101-aaaaaa/);
  assert.match(text, /Verdict: approve/);
  assert.match(text, /Disposition: approve/);
  assert.match(text, /State: integrated/);
  assert.doesNotMatch(text, /# Issue #12/);
});

test("details shows external completion provenance alongside preserved historical evidence", async (t) => {
  const { repoPath } = await fixture(t);
  const historical = persistedRun("20260910010101-aaaaaa", "13", { verdict: "rework" });
  await saveRunState(repoPath, historical.runId, historical);
  const config = { work: { "13": {
    status: "complete",
    completion: {
      source: "external",
      reconciledAt: "2026-09-11T12:00:00Z",
      githubState: "CLOSED",
      githubStateReason: "completed"
    }
  } } };

  const text = formatDetails(await loadIssueDetails(repoPath, ["13"], { config }));
  assert.match(text, /Completion provenance: external/);
  assert.match(text, /GitHub evidence: CLOSED \/ completed/);
  assert.match(text, /Resolved run: 20260910010101-aaaaaa/);
  assert.match(text, /Verdict: rework/);
});

test("details shows external completion even when no Maestro run exists", async (t) => {
  const { repoPath } = await fixture(t);
  const config = { work: { "14": {
    status: "complete",
    github: { title: "Completed elsewhere" },
    completion: { source: "external", githubState: "CLOSED", githubStateReason: "completed" }
  } } };

  const text = formatDetails(await loadIssueDetails(repoPath, ["14"], { config }));
  assert.match(text, /# Issue #14 — Completed elsewhere/);
  assert.match(text, /Completion provenance: external/);
  assert.match(text, /Maestro execution history: none/);
});

test("rework details relate the correction to source worker and validator evidence", async (t) => {
  const { repoPath } = await fixture(t);
  const source = persistedRun("20260910010101-aaaaaa", "7", {
    verdict: "rework",
    validatorReport: "VERDICT: REWORK\nMissing regression coverage."
  });
  const child = persistedRun("20260910020202-bbbbbb", "7", {
    mode: "rework",
    parentRunId: source.runId,
    workerReport: "Result: complete\nAdded regression coverage.",
    validatorReport: "VERDICT: APPROVE\nCoverage is present."
  });
  child.correction = { attempts: { "7": {
    number: 1,
    automatic: true,
    rootRunId: source.runId,
    sourceRunId: source.runId,
    phase: "completed",
    outcome: "approved",
    trigger: { verdict: "rework", report: "VERDICT: REWORK\nMissing regression coverage." },
    implementation: { branch: "maestro/7", worktreePath: "/tmp/7", baseSha: "base-7", targetBranch: "main" }
  } } };
  await saveRunState(repoPath, source.runId, source);
  await saveRunState(repoPath, child.runId, child);

  const text = formatDetails(await loadIssueDetails(repoPath, ["7"]));
  assert.match(text, new RegExp(`Provenance: rework child run of ${source.runId}`));
  assert.match(text, /Added regression coverage/);
  assert.match(text, /Correction attempt:/);
  assert.match(text, /Number: 1/);
  assert.match(text, /Automatic: yes/);
  assert.match(text, /Outcome: approved/);
  assert.match(text, /Trigger verdict: rework/);
  assert.match(text, /Implementation worktree: \/tmp\/7/);
  assert.match(text, /## Original\/source evidence for #7/);
  assert.match(text, /Verdict: rework/);
  assert.match(text, /Missing regression coverage/);
});

test("details renders technical conflict evidence and exact continuation", async (t) => {
  const { repoPath } = await fixture(t);
  const state = persistedRun("20260910020202-bbbbbb", "7", { mode: "rework" });
  state.status = "failed";
  state.workers = [];
  state.validations = [];
  state.correction = { attempts: { "7": {
    number: 1,
    automatic: true,
    phase: "stopped",
    outcome: "technical-conflict",
    conflict: {
      type: "content",
      operation: "rebase",
      operationState: "aborted",
      interruptedStage: "rework-refresh",
      worktreePath: "/tmp/7",
      conflictedFiles: ["src/shared.js"],
      sourceSha: "source-implementation-sha",
      targetBranch: "main",
      targetRef: "origin/main",
      targetSha: "target-main-sha",
      operationOriginalHeadSha: "source-implementation-sha",
      operationCurrentHeadSha: "target-main-sha",
      operationHeadSha: "source-commit-being-replayed",
      operationOntoSha: "target-main-sha",
      continuationAction: "maestro rework 7 --run 20260910010101-aaaaaa",
      stderr: "CONFLICT (content): Merge conflict in src/shared.js"
    }
  } } };
  await saveRunState(repoPath, state.runId, state);

  const text = formatDetails(await loadIssueDetails(repoPath, ["7"]));
  assert.match(text, /Outcome: technical-conflict/);
  assert.match(text, /Operation state: aborted/);
  assert.match(text, /Conflicted files: src\/shared\.js/);
  assert.match(text, /Source SHA: source-implementation-sha/);
  assert.match(text, /Target SHA: target-main-sha/);
  assert.match(text, /Operation original HEAD: source-implementation-sha/);
  assert.match(text, /Operation current HEAD: target-main-sha/);
  assert.match(text, /Operation head: source-commit-being-replayed/);
  assert.match(text, /Rebase onto SHA: target-main-sha/);
  assert.match(text, /Continuation action: maestro rework 7 --run 20260910010101-aaaaaa/);
  assert.match(text, /Manual recovery .*:\n      cd \/tmp\/7\n      git fetch origin main\n      git rebase origin\/main\n      git add -A -- src\/shared\.js\n      GIT_EDITOR=true git rebase --continue\n      maestro rework 7 --run 20260910010101-aaaaaa/);
});

test("multiple issues resolve independently and explicit runs inspect history", async (t) => {
  const { repoPath } = await fixture(t);
  const historical = persistedRun("20260910010101-aaaaaa", "7", { verdict: "rework" });
  const current = persistedRun("20260910030303-cccccc", "7");
  const issue12 = persistedRun("20260910020202-bbbbbb", "12");
  await saveRunState(repoPath, historical.runId, historical);
  await saveRunState(repoPath, issue12.runId, issue12);
  await saveRunState(repoPath, current.runId, current);

  const latest = await loadIssueDetails(repoPath, ["7", "12"]);
  assert.deepEqual(latest.map((entry) => [entry.issue, entry.runId]), [
    ["7", current.runId],
    ["12", issue12.runId]
  ]);
  const explicit = await loadIssueDetails(repoPath, ["7"], { runId: historical.runId });
  assert.equal(explicit[0].runId, historical.runId);
  assert.equal(explicit[0].evidence.validation.verdict, "rework");
});

test("details reports missing issues and missing issues in an explicit run", async (t) => {
  const { repoPath } = await fixture(t);
  const state = persistedRun("20260910010101-aaaaaa", "7");
  await saveRunState(repoPath, state.runId, state);

  await assert.rejects(loadIssueDetails(repoPath, ["404"]), /No relevant Maestro run for issue #404/);
  await assert.rejects(loadIssueDetails(repoPath, ["404"], { runId: state.runId }), new RegExp(`No relevant Maestro run for issue #404 in explicit run ${state.runId}`));
});

test("maestro details accepts issue positionals and a historical run override", async (t) => {
  const { repoPath } = await fixture(t);
  const manifestPath = path.join(repoPath, ".maestro.json");
  const runId = "20260910010101-aaaaaa";
  await fsPromises.writeFile(manifestPath, `${JSON.stringify({
    repository: "owner/repo",
    work: { "7": { status: "ready" } }
  })}\n`);
  await saveRunState(repoPath, runId, persistedRun(runId, "7"));

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const result = spawnSync(process.execPath, [
    cli, "details", "7", "--run", runId, "--repo-path", repoPath
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Issue #7/);
  assert.match(result.stdout, new RegExp(`Resolved run: ${runId}`));
  assert.equal(fs.existsSync(manifestPath), true);
});

test("details renders validator override provenance", async (t) => {
  const { repoPath } = await fixture(t);
  const runId = "20260910010101-aaaaaa";
  const state = persistedRun(runId, "7", {
    verdict: "rework",
    validatorReport: "VERDICT: REWORK\nKnown false positive."
  });
  state.reviews["7"] = {
    disposition: "approve-override",
    validatorOverride: {
      verdict: "rework",
      exitCode: 0,
      report: "VERDICT: REWORK\nKnown false positive."
    },
    recordedAt: "2026-09-11T12:00:00.000Z"
  };
  await saveRunState(repoPath, runId, state);

  const text = formatDetails(await loadIssueDetails(repoPath, ["7"]));
  assert.match(text, /Issue state: awaiting-integration/);
  assert.match(text, /Disposition: approve-override/);
  assert.match(text, /Overridden validator verdict: rework/);
  assert.match(text, /Overridden validator exit code: 0/);
  assert.match(text, /Overridden validator report:/);
  assert.match(text, /Known false positive/);
});

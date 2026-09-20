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

  assert.match(text, /Needs attention \(1\)[\s\S]*#7 Needs correction - validator requested rework/);
  assert.match(text, /Awaiting human approval \(1\)[\s\S]*#2 Passing change - validator approved/);
  assert.match(text, /Blocked \(1\)[\s\S]*#13 - blocked, waiting on #2/);
  assert.match(text, /Complete: 1 \(history collapsed; use maestro status --completed\)/);
  assert.doesNotMatch(text, /#12 .*integrated\/complete/);
  assert.match(text, /Commit: not ready — #2 needs human approval; #7 needs human rework disposition/);
  assert.match(text, /Recommended: `maestro rework 7`/);
  assert.match(text, /Also available: `maestro details 7`, `maestro approve 7 --override`, `maestro discard 7`, `maestro approve 2`/);
  assert.match(text, /`maestro review --run 20260910010101-aaaaaa --issue 7 --disposition rework-original`/);
  assert.doesNotMatch(text, /Issue #2 .*— approved$/m);
});

test("reviewed mixed status shows exactly what commit integrates and skips", async () => {
  const snapshot = await statusSnapshot(config, "/unused", [], { stateLoader: async () => [mixedRun({ reviewed: true })] });
  const text = formatStatus(snapshot);

  assert.match(text, /Ready to integrate \(1\)[\s\S]*#2 Passing change - human approved, ready to integrate/);
  assert.match(text, /Needs attention \(1\)[\s\S]*#7 Needs correction - human rework disposition recorded/);
  assert.match(text, /Commit: ready — integrates #2; skips #7 for rework/);
  assert.match(text, /Recommended: `maestro commit`/);
  assert.match(text, /Also available: `maestro rework 7`/);
});

test("reviewed work is not labeled ready to integrate while its run still needs a disposition", async () => {
  const run = mixedRun();
  run.reviews["2"] = { disposition: "approve" };
  const text = formatStatus(await statusSnapshot(config, "/unused", [], { stateLoader: async () => [run] }));

  assert.match(text, /Awaiting integration readiness \(1\)[\s\S]*#2 Passing change - human approved, awaiting other run dispositions/);
  assert.doesNotMatch(text, /Ready to integrate \(1\)/);
  assert.match(text, /Commit: not ready/);
});

test("focused issue status includes commit, validator, human review, integration, and next action", async () => {
  const snapshot = await statusSnapshot(config, "/unused", ["7"], { stateLoader: async () => [mixedRun()] });
  const text = formatStatus(snapshot);

  assert.match(text, /Issue #7 — Needs correction — validator requested rework, awaiting human rework disposition/);
  assert.match(text, /Worker commit: rework-commit/);
  assert.match(text, /Validator: rework/);
  assert.match(text, /Human review: none/);
  assert.match(text, /Integration: not eligible; correct, override, or discard it/);
  assert.doesNotMatch(text, /Issue #2 —/);
  assert.match(text, /Recommended: `maestro rework 7`/);
  assert.match(text, /Also available: `maestro details 7`, `maestro approve 7 --override`, `maestro discard 7`/);
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

  const completed = spawnSync(process.execPath, [cli, "status", "--completed", "--repo-path", repoPath], { encoding: "utf8" });
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /Complete \(1\)[\s\S]*#12 - integrated\/complete/);
  assert.doesNotMatch(completed.stdout, /#7 Needs correction/);

  const all = spawnSync(process.execPath, [cli, "status", "--all", "--repo-path", repoPath], { encoding: "utf8" });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /Needs attention \(1\)[\s\S]*#7 Needs correction/);
  assert.match(all.stdout, /Complete \(1\)[\s\S]*#12 - integrated\/complete/);

  const invalid = spawnSync(process.execPath, [cli, "status", "7", "--all", "--repo-path", repoPath], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /either issue numbers or --all/);
});

test("repository status derives start versus next from persisted integration history", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-status-advance-"));
  const repoPath = path.join(root, "target");
  const manifestPath = path.join(repoPath, ".maestro.json");
  const runId = "20260910030303-cccccc";
  const advancedConfig = {
    repository: "example/repo",
    defaultConcurrency: 1,
    work: {
      "2": { status: "complete", title: "Integrated work" },
      "3": { status: "ready", title: "Newly ready work", blockedBy: ["2"] }
    }
  };
  const integratedRun = {
    runId,
    mode: "execute",
    status: "awaiting-review",
    plan: { selected: [{ id: "2", title: "Integrated work" }] },
    workers: [{ issue: "2", exitCode: 0, headSha: "head-2" }],
    validations: [{ issue: "2", verdict: "approve" }],
    reviews: { "2": { disposition: "approve" } },
    integration: [{ issue: "2", integratedSha: "integrated-2" }],
    integratedAt: "2026-09-10T03:03:03.000Z"
  };
  await fs.mkdir(repoPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(manifestPath, `${JSON.stringify(advancedConfig)}\n`);
  await saveRunState(repoPath, runId, integratedRun);

  const initial = formatStatus(await statusSnapshot({
    repository: "example/repo",
    defaultConcurrency: 1,
    work: { "2": { status: "ready", title: "Initial work" } }
  }, "/unused", [], { stateLoader: async () => [] }));
  assert.match(initial, /Recommended: `maestro start`/);

  const snapshotText = formatStatus(await statusSnapshot(advancedConfig, repoPath));
  assert.match(snapshotText, /Next \(1, scheduler order\)[\s\S]*#3 Newly ready work/);
  assert.match(snapshotText, /Recommended: `maestro next`/);
  assert.doesNotMatch(snapshotText, /Recommended: `maestro start`/);

  const cli = path.resolve(__dirname, "../bin/maestro.js");
  const result = spawnSync(process.execPath, [cli, "status", "--repo-path", repoPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Next \(1, scheduler order\)[\s\S]*#3 Newly ready work/);
  assert.match(result.stdout, /Recommended: `maestro next`/);
  assert.doesNotMatch(result.stdout, /Recommended: `maestro start`/);
});

test("focused status rejects issues absent from both manifest and persisted workflow", async () => {
  await assert.rejects(
    statusSnapshot(config, "/unused", ["404"], { stateLoader: async () => [mixedRun()] }),
    /No Maestro workflow state for issue #404/
  );
  await assert.rejects(
    statusSnapshot(config, "/unused", ["12"], { stateLoader: async () => [], view: "completed" }),
    /Focused status issue selections cannot be combined/
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

test("manifest completion without integration evidence is a reconciliation conflict, never a stale commit or review action", async () => {
  const historical = mixedRun({ reviewed: true });
  historical.workers = historical.workers.filter((entry) => entry.issue === "2");
  historical.validations = historical.validations.filter((entry) => entry.issue === "2");
  historical.plan.selected = historical.plan.selected.filter((entry) => entry.id === "2");
  delete historical.reviews["7"];
  const text = formatStatus(await statusSnapshot({
    repository: "example/repo",
    work: { "2": { status: "complete", title: "Passing change" } }
  }, "/unused", [], { stateLoader: async () => [historical] }));

  assert.match(text, /Needs attention \(1\)[\s\S]*#2 Passing change - consistency conflict: manifest says complete, but execution history has no integration record/);
  assert.match(text, /Commit: not ready — #2 needs manifest\/run reconciliation/);
  assert.doesNotMatch(text, /Commit: ready/);
  assert.doesNotMatch(text, /Recommended: `maestro (approve|rework|commit)/);
});

test("status reports adopted external completion and suppresses stale lifecycle actions", async () => {
  const historical = mixedRun({ reviewed: true });
  historical.workers = historical.workers.filter((entry) => entry.issue === "2");
  historical.validations = historical.validations.filter((entry) => entry.issue === "2");
  historical.plan.selected = historical.plan.selected.filter((entry) => entry.id === "2");
  delete historical.reviews["7"];
  const text = formatStatus(await statusSnapshot({
    repository: "example/repo",
    work: { "2": {
      status: "complete",
      title: "Passing change",
      completion: { source: "external", githubState: "CLOSED", githubStateReason: "completed" }
    } }
  }, "/unused", [], { stateLoader: async () => [historical] }));

  assert.match(text, /Issue #2 .*complete \(external\)/);
  assert.doesNotMatch(text, /consistency conflict/);
  assert.doesNotMatch(text, /Recommended: `maestro (approve|rework|commit)/);
});

test("integration in a newer reconciliation run suppresses an older approved implementation and its actions", async () => {
  const historical = mixedRun({ reviewed: true });
  historical.workers = historical.workers.filter((entry) => entry.issue === "2");
  historical.validations = historical.validations.filter((entry) => entry.issue === "2");
  historical.plan.selected = historical.plan.selected.filter((entry) => entry.id === "2");
  delete historical.reviews["7"];
  const reconciliation = {
    runId: "20260910020202-bbbbbb",
    parentRunId: historical.runId,
    mode: "reconcile",
    status: "integrated",
    plan: { selected: [{ id: "2" }] },
    workers: [],
    validations: [],
    reviews: {},
    integration: [{ issue: "2", integratedSha: "corrected-2" }]
  };
  const text = formatStatus(await statusSnapshot({
    repository: "example/repo",
    work: { "2": { status: "complete", title: "Passing change" } }
  }, "/unused", [], { stateLoader: async () => [historical, reconciliation] }));

  assert.match(text, /Complete: 1 \(history collapsed/);
  assert.doesNotMatch(text, /#2 .*integrated\/complete/);
  assert.doesNotMatch(text, /Commit:/);
  assert.doesNotMatch(text, /Recommended:/);
});

test("a superseded source implementation is excluded while its current sibling remains commit-ready", async () => {
  const source = mixedRun({ reviewed: true });
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

  assert.match(text, /Commit: ready — integrates #2; skips #7 for rework/);
  assert.doesNotMatch(text, /integrates #2, #7/);
});

test("settled source history creates no phantom blocker after all integration work is terminal", async () => {
  const source = mixedRun({ reviewed: false });
  source.reviews["2"] = { disposition: "approve" };
  source.integration = [{ issue: "2", integratedSha: "integrated-2" }];
  const child = {
    runId: "20260910020202-bbbbbb",
    parentRunId: source.runId,
    mode: "rework",
    status: "awaiting-review",
    plan: { selected: [{ id: "7" }] },
    workers: [{ issue: "7", exitCode: 0, headSha: "child-commit" }],
    validations: [{ issue: "7", verdict: "rework" }],
    reviews: { "7": { disposition: "rework-original" } },
    integration: []
  };
  const text = formatStatus(await statusSnapshot({
    ...config,
    work: { ...config.work, "2": { status: "complete" } }
  }, "/unused", [], { stateLoader: async () => [source, child] }));

  assert.doesNotMatch(text, /Commit: not ready — #7/);
});

test("override-approved status remains visibly distinct from ordinary approval", async () => {
  const state = mixedRun();
  state.reviews["2"] = { disposition: "approve" };
  state.reviews["7"] = {
    disposition: "approve-override",
    validatorOverride: { verdict: "rework", exitCode: null, report: null }
  };
  const text = formatStatus(await statusSnapshot(config, "/unused", ["7"], {
    stateLoader: async () => [state]
  }));

  assert.match(text, /human override approved, ready to integrate/);
  assert.match(text, /Human review: approve-override/);
  assert.match(text, /Integration: eligible when every item in its run has a human disposition/);
});

test("retry exhaustion is a human-review stop with lineage details instead of another automatic recommendation", async () => {
  const run = mixedRun();
  run.workers = run.workers.filter((worker) => worker.issue === "7");
  run.validations = run.validations.filter((validation) => validation.issue === "7");
  run.plan.selected = run.plan.selected.filter((item) => item.id === "7");
  run.autoRework = {
    "7": { status: "retry-exhausted", retryLimit: 3, attemptsUsed: 3, finalVerdict: "rework", action: "maestro details 7" }
  };
  const text = formatStatus(await statusSnapshot(config, "/unused", ["7"], {
    stateLoader: async () => [run]
  }));
  assert.match(text, /automatic rework exhausted after 3 of 3 correction attempts; human review required/);
  assert.match(text, /Recommended: `maestro details 7`/);
  assert.doesNotMatch(text, /Recommended: `maestro rework 7`/);
  assert.match(text, /Also available: `maestro rework 7`/);
});

test("status distinguishes a rework refresh conflict and shows its continuation", async () => {
  const run = mixedRun();
  run.status = "failed";
  run.workers = [];
  run.validations = [];
  run.plan.selected = [{ id: "7", title: "Needs correction" }];
  run.correction = { attempts: { "7": {
    number: 1,
    phase: "stopped",
    outcome: "technical-conflict",
    conflict: {
      operationState: "aborted",
      continuationAction: "maestro rework 7"
    }
  } } };
  run.autoRework = { "7": {
    status: "technical-conflict",
    retryLimit: 3,
    attemptsUsed: 1,
    action: "maestro details 7"
  } };

  const text = formatStatus(await statusSnapshot(config, "/unused", ["7"], {
    stateLoader: async () => [run]
  }));
  assert.match(text, /charged attempt 1: rebase content conflict \(aborted\); resolve safely, then run maestro rework 7/);
  assert.match(text, /Recommended: `maestro details 7`/);
  assert.doesNotMatch(text, /validator requested rework/);
  assert.doesNotMatch(text, /human decision/);
});

test("status presents resolver ambiguity as an explicit human-required conflict", async () => {
  const run = mixedRun();
  run.status = "failed";
  run.workers = [];
  run.validations = [];
  run.plan.selected = [{ id: "7", title: "Needs correction" }];
  run.correction = { attempts: { "7": {
    number: 1,
    phase: "stopped",
    outcome: "human-required",
    conflict: { operationState: "active", resolution: { status: "human-required" } }
  } } };
  run.autoRework = { "7": { status: "human-required", attemptsUsed: 1, action: "maestro details 7" } };

  const text = formatStatus(await statusSnapshot(config, "/unused", ["7"], {
    stateLoader: async () => [run]
  }));
  assert.match(text, /rebase conflict requires human resolution \(active\)/);
  assert.match(text, /conflicted implementation and recovery evidence are preserved/);
  assert.match(text, /Recommended: `maestro details 7`/);
});

test("status displays timeout and no-progress as distinct automatic correction stops", async () => {
  const timeout = mixedRun();
  timeout.status = "failed";
  timeout.workers = [{ issue: "7", exitCode: 1, timedOut: true }];
  timeout.validations = [];
  timeout.correction = { attempts: { "7": { number: 2, phase: "completed", outcome: "timeout", timeoutStage: "worker" } } };
  timeout.autoRework = { "7": { status: "timeout", retryLimit: 3, attemptsUsed: 2, timeoutStage: "worker", action: "maestro details 7" } };

  const timeoutText = formatStatus(await statusSnapshot(config, "/unused", ["7"], { stateLoader: async () => [timeout] }));
  assert.match(timeoutText, /session timeout during worker/);
  assert.match(timeoutText, /Recommended: `maestro details 7`/);

  const noProgress = structuredClone(timeout);
  noProgress.workers = [{ issue: "7", exitCode: 0, baseSha: "same", headSha: "same" }];
  noProgress.correction.attempts["7"].outcome = "no-progress";
  delete noProgress.correction.attempts["7"].timeoutStage;
  noProgress.autoRework["7"].status = "no-progress";
  delete noProgress.autoRework["7"].timeoutStage;
  const noProgressText = formatStatus(await statusSnapshot(config, "/unused", ["7"], { stateLoader: async () => [noProgress] }));
  assert.match(noProgressText, /worker completed without a new commit/);
  assert.match(noProgressText, /Recommended: `maestro details 7`/);
});

test("default status is bounded, follows scheduler order, and collapses completed history", async () => {
  const work = {};
  for (let issue = 1; issue <= 1000; issue += 1) {
    work[String(issue)] = { status: "complete", title: `Historical item ${issue}` };
  }
  for (let issue = 1001; issue <= 1012; issue += 1) {
    work[String(issue)] = { status: "ready", priority: 1100 - issue, title: `Ready item ${issue}` };
  }
  const snapshot = await statusSnapshot({ repository: "example/large", defaultConcurrency: 2, work }, "/unused", [], {
    stateLoader: async () => []
  });
  const text = formatStatus(snapshot);

  assert.match(text, /Next \(2, scheduler order\)[\s\S]*#1012 Ready item 1012[\s\S]*#1011 Ready item 1011/);
  assert.match(text, /Remaining ready \(10\)/);
  assert.match(text, /\.\.\. 5 more \(use maestro status --all\)/);
  assert.match(text, /Complete: 1000 \(history collapsed/);
  assert.doesNotMatch(text, /Historical item 1/);
  assert.ok(text.split("\n").length < 35, "routine status should remain near one screen");
});

test("all and completed views expand one effective row per issue", async () => {
  const viewConfig = {
    repository: "example/history",
    work: {
      "1": { status: "complete", title: "Done one" },
      "2": { status: "complete" },
      "3": { status: "ready", title: "Current work" }
    }
  };
  const all = formatStatus(await statusSnapshot(viewConfig, "/unused", [], {
    stateLoader: async () => [],
    view: "all"
  }));
  const completed = formatStatus(await statusSnapshot(viewConfig, "/unused", [], {
    stateLoader: async () => [],
    view: "completed"
  }));

  assert.match(all, /Next \(1, scheduler order\)[\s\S]*#3 Current work/);
  assert.match(all, /Complete \(2\)[\s\S]*#1 Done one - integrated\/complete[\s\S]*#2 - integrated\/complete/);
  assert.match(completed, /Complete \(2\)[\s\S]*#1 Done one - integrated\/complete[\s\S]*#2 - integrated\/complete/);
  assert.doesNotMatch(completed, /#3 Current work/);
  assert.doesNotMatch(completed, /Recommended:/);
});

test("action groups precede ready work and narrow output wraps deterministically", async () => {
  const longConfig = {
    ...config,
    work: {
      ...config.work,
      "20": { status: "ready", priority: 1, title: "A deliberately very long title that must wrap on narrow terminals" }
    }
  };
  const text = formatStatus(await statusSnapshot(longConfig, "/unused", [], {
    stateLoader: async () => [mixedRun()]
  }), { columns: 40 });

  assert.ok(text.indexOf("Needs attention") < text.indexOf("Next"));
  assert.ok(text.split("\n").every((line) => line.length <= 40), text);
  assert.match(text, /#20 A deliberately very long title/);
});

test("advisory-deferred ready work explains its scheduler constraint", async () => {
  const text = formatStatus(await statusSnapshot({
    repository: "example/conflicts",
    defaultConcurrency: 2,
    planning: { advisoryConflicts: [{ issues: ["1", "2"], reason: "same subsystem" }] },
    work: {
      "1": { status: "ready", priority: 1, title: "First" },
      "2": { status: "ready", priority: 2, title: "Second" }
    }
  }, "/unused", [], { stateLoader: async () => [] }));

  assert.match(text, /Next \(1, scheduler order\)[\s\S]*#1 First/);
  assert.match(text, /Remaining ready \(1\)[\s\S]*#2 Second - ready; scheduled separately from #1 \(same subsystem\)/);
});

test("no-history empty scope is explicit", async () => {
  const text = formatStatus(await statusSnapshot({ repository: "example/empty", work: {} }, "/unused", [], {
    stateLoader: async () => []
  }));
  assert.match(text, /No known work\./);
  assert.doesNotMatch(text, /Recommended:/);
});

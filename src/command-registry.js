const COMMON_REPO_OPTION = { value: "<path>", description: "Target repository path; defaults to the current Git checkout." };
const RUN_OPTION = { value: "<run-id>", description: "Select a persisted historical run explicitly." };
const CONCURRENCY_OPTIONS = {
  "-j": { value: "<count>", description: "Use this concurrency limit for this invocation only (1-8)." },
  "--concurrency": { value: "<count>", description: "Alias for -j; never changes the saved manifest default." }
};

const COMMANDS = [
  {
    name: "draft",
    category: "Planning",
    summary: "Preview or reconcile GitHub issue truth with repository work.",
    when: "Use before planning and whenever GitHub issue state, dependencies, or mapped labels may have changed.",
    usages: ["maestro draft [manifest.json] [issue ...|--all|--epic <number>|--workset <name>] [--name <name>] [-j <count>] [--agent] [--write] [--verbose|--json]"],
    positionals: "Optional manifest path followed by issue numbers. Omit issues to reconcile the full issue set.",
    options: {
      "--repo-path": COMMON_REPO_OPTION,
      ...CONCURRENCY_OPTIONS,
      "--all": { description: "Explicitly reconsider the full open and closed issue set; cannot be combined with issue numbers." },
      "--epic": { value: "<number>", description: "Resolve documented GitHub sub-issue relationships recursively and propose a named workset." },
      "--workset": { value: "<name>", description: "Refresh an existing named workset using its recorded source." },
      "--name": { value: "<name>", description: "Name a new epic or explicit-issue workset; epic defaults to epic-<number>." },
      "--agent": { description: "Add bounded, read-only semantic planning recommendations." },
      "--write": { description: "Persist the schema-valid proposal; otherwise draft is a preview." },
      "--verbose": { description: "Show complete planning evidence, provenance, all projected waves, and the proposed manifest." },
      "--json": { description: "Emit only the complete structured draft result as parseable JSON." }
    },
    prerequisites: "A Git checkout and readable GitHub repository. Writing requires a safe, schema-valid dependency graph.",
    effects: "Reads issues and builds a proposal; only --write changes the manifest. Scoped writes also save a revisioned scope snapshot beside run evidence.",
    cautions: "Repository configuration controls execution, a workset selects canonical work, and a run records authorization/history. Saving either draft artifact does not launch work, expand delegated scope, grant human approval, or authorize integration. Lifecycle and epic-resolution conflicts remain fail-closed; drafting never mutates GitHub. If Codex rejects the agent output schema, retry deterministically without --agent; that provider error does not mean the repository manifest is invalid.",
    next: ["maestro status", "maestro start"],
    examples: [
      ["draft", "--agent", "--verbose"],
      ["draft", "101", "102", "--write"]
    ],
    positionalKind: "manifest-issues",
    conflicts: [["--all", "$issues"], ["--epic", "$issues"], ["--workset", "$issues"], ["--all", "--epic"], ["--all", "--workset"], ["--all", "--name"], ["--epic", "--workset"]],
    numericOptions: ["--epic"],
    exclusive: [["--verbose", "--json"], ["-j", "--concurrency"]]
  },
  {
    name: "config",
    category: "Planning",
    summary: "Read or save the repository's default concurrency.",
    when: "Use config get to inspect the resolved setting, or config set to change future independent invocations.",
    usages: [
      "maestro config [manifest.json] get defaultConcurrency [--repo-path <path>]",
      "maestro config [manifest.json] set defaultConcurrency <count> [--repo-path <path>]"
    ],
    positionals: "Optional manifest path, then action (`get` or `set`), the defaultConcurrency key, and a value for set.",
    options: {
      "--repo-path": COMMON_REPO_OPTION,
      "--manifest": { value: "<path>", description: "Explicit manifest path; defaults to .maestro.json in the target repository." }
    },
    prerequisites: "An existing, readable, schema-valid target manifest.",
    effects: "get is read-only. set atomically changes only defaultConcurrency in the local manifest; it does not execute work or run Git commands.",
    cautions: "A saved default affects new independent invocations, not running or captured sessions. Commit and push it through the normal Git workflow to share it.",
    next: ["maestro plan", "Commit the manifest through your normal Git workflow"],
    examples: [["config", "get", "defaultConcurrency"], ["config", "set", "defaultConcurrency", "4"]],
    positionalKind: "config"
  },
  {
    name: "plan",
    category: "Planning",
    summary: "Show the next dependency- and concurrency-aware wave without executing it.",
    when: "Use for a manifest-only planning/debugging preview; ordinary workflow can use status instead.",
    usages: ["maestro plan [manifest.json] [--repo-path <path>] [--workset <name>] [-j <count>]"],
    positionals: "Optional manifest path; defaults to .maestro.json in the target repository.",
    options: { "--repo-path": COMMON_REPO_OPTION, ...CONCURRENCY_OPTIONS, "--workset": { value: "<name>", description: "Limit the preview to a saved workset scope snapshot." } },
    prerequisites: "A target Git repository and Maestro manifest.",
    effects: "Prints a deterministic plan. It creates no run and changes no files or remote state.",
    cautions: "A plan reflects manifest state, not unresolved product decisions outside the manifest.",
    next: ["maestro start", "maestro status"],
    examples: [["plan"], ["plan", "config/maestro.json", "--repo-path", "../target"]],
    positionalKind: "optional-manifest",
    exclusive: [["-j", "--concurrency"]]
  },
  {
    name: "start",
    aliases: ["s"],
    category: "Execution",
    summary: "Execute the current ready wave in isolated workers and fresh validators.",
    when: "Use after planning when status shows ready work and required capabilities are available.",
    usages: ["maestro start [manifest.json] [issue ...|--workset <name>] [-j <count>] [--delegate [--renew <authorization-id>]] [--auto-rework]"],
    positionals: "Optional manifest path. Issue numbers are accepted only with --delegate and create a bounded one-shot scope.",
    options: {
      "--repo-path": COMMON_REPO_OPTION,
      ...CONCURRENCY_OPTIONS,
      "--workset": { value: "<name>", description: "Execute only a previously drafted scope after checking it for drift." },
      "--rerun": { description: "Intentionally bypass persisted lifecycle deferrals and retry manifest-ready work." },
      "--auto-rework": { description: "Automatically correct and revalidate REWORK results, up to three attempts within a 30-minute session." },
      "--delegate": { description: "Explicitly authorize this resolved scope/session to integrate passing current results without per-issue human review." },
      "--preview": { description: "Resolve and print the exact delegated authorization without persisting it or starting work." },
      "--renew": { value: "<authorization-id>", description: "Create a new authorization after explicitly resolving scope and policy again; the prior record is retained." }
    },
    prerequisites: "Ready reconciled work, a clean usable repository, current GitHub issue facts, and every capability required by the selected items.",
    effects: "Atomically reserves repository worker slots, persists a run, creates isolated branches/worktrees, validates changed branches, and backfills authorized ready work. With --delegate, eligible passing results are integrated serially under a durable scoped authorization.",
    cautions: "Without --delegate: Does not approve, integrate, push the default branch, or close issues. Delegation does not override human gates, validation failures, drift, checks, closure policy, or unrelated/live operations. --rerun cannot be combined with --workset.",
    next: ["maestro status", "maestro details <issue>", "maestro output"],
    examples: [["start"], ["start", "57", "63", "--delegate"]],
    positionalKind: "manifest-issues",
    conflicts: [["--workset", "--rerun"]],
    exclusive: [["-j", "--concurrency"]]
  },
  {
    name: "next",
    aliases: ["n"],
    category: "Execution",
    summary: "Start the next ready wave while respecting all persisted lifecycle deferrals.",
    when: "Use after reviewed work is integrated, or whenever status recommends the next eligible wave.",
    usages: ["maestro next [manifest.json] [--repo-path <path>] [--workset <name>] [-j <count>] [--rerun] [--auto-rework]"],
    positionals: "Optional manifest path; defaults to .maestro.json in the target repository.",
    options: {
      "--repo-path": COMMON_REPO_OPTION,
      ...CONCURRENCY_OPTIONS,
      "--workset": { value: "<name>", description: "Continue only the authorized members of a previously drafted workset." },
      "--rerun": { description: "Intentionally retry manifest-ready work despite prior lifecycle evidence." },
      "--auto-rework": { description: "Automatically correct and revalidate REWORK results, up to three attempts within a 30-minute session." },
      "--delegate": { description: "Begin a new explicit delegated session for the resolved scope; existing next semantics remain supervised without it." },
      "--preview": { description: "Resolve and print the exact delegated authorization without persisting it or starting work." },
      "--renew": { value: "<authorization-id>", description: "Renew a prior authorization only after re-resolving the current scope and protected policy." }
    },
    prerequisites: "The same requirements as start. Existing running, review, rework, and integration states remain deferred.",
    effects: "Runs workers and validators for newly eligible work and backfills freed original-worker slots from the authorized manifest scope; --auto-rework may also resume corrections. It does not integrate work.",
    cautions: "No ready work is not proof that all repository or workset work is complete; inspect status for outside prerequisites, gates, and deferred items. Automatic correction never satisfies human review or integration gates. --rerun cannot be combined with --workset.",
    next: ["maestro status", "maestro output"],
    examples: [["next"], ["next", "--workset", "release", "--delegate"]],
    positionalKind: "optional-manifest",
    conflicts: [["--workset", "--rerun"]],
    exclusive: [["-j", "--concurrency"]]
  },
  {
    name: "revoke",
    category: "Integration",
    summary: "Revoke a delegated authorization so it cannot integrate further work.",
    when: "Use to pause a delegated session before any additional integration.",
    usages: ["maestro revoke <authorization-id> [--repo-path <path>]"],
    positionals: "The exact authorization id printed and persisted by a delegated start/next invocation.",
    options: { "--repo-path": COMMON_REPO_OPTION },
    prerequisites: "The authorization must exist in this coordinated repository session.",
    effects: "Atomically marks the authorization revoked. Existing run and validation evidence remains auditable but non-integrable.",
    cautions: "Revocation does not undo commits already integrated. Resume requires an explicit new --delegate invocation, optionally with --renew.",
    next: ["maestro status", "maestro start 57 --delegate --renew <authorization-id>"],
    examples: [["revoke", "delegation-20260910010101-aaaaaa-deadbeef1234"]],
    positionalKind: "authorization-id"
  },
  {
    name: "status",
    aliases: ["st"],
    category: "Inspection",
    summary: "Show current issue states and executable next-action recommendations.",
    when: "Use between every workflow action, especially for mixed validator or review outcomes.",
    usages: ["maestro status [manifest.json] [issue ...] [--all|--completed] [--repo-path <path>] [-j <count>] [--watch]"],
    positionals: "Optional manifest path and optional issue numbers for a focused view. Issue numbers cannot be combined with --all or --completed.",
    options: {
      "--repo-path": COMMON_REPO_OPTION,
      ...CONCURRENCY_OPTIONS,
      "--all": { description: "Expand the full issue inventory, run readiness, and recommended actions." },
      "--completed": { description: "Show completed items that are collapsed in the default operational view." },
      "--watch": { description: "Continuously refresh the current or issue-focused status view." }
    },
    prerequisites: "A target repository and manifest. Persisted runs are optional.",
    effects: "Reads manifest and run evidence only; --watch repeats the read until interrupted.",
    cautions: "Default output is bounded and collapses completed history. Validator approval, human approval, and integration remain distinct.",
    next: ["Follow the Recommended command", "maestro details <issue>"],
    examples: [["status"], ["status", "--completed"]],
    positionalKind: "manifest-issues",
    conflicts: [["--all", "$issues"], ["--completed", "$issues"]],
    exclusive: [["-j", "--concurrency"], ["--all", "--completed"]]
  },
  {
    name: "details",
    category: "Inspection",
    summary: "Show verbose persisted evidence for one or more issues.",
    when: "Use when status is too compact to review a worker, validator, review, or integration result.",
    usages: ["maestro details [manifest.json] <issue ...> [--repo-path <path>] [--run <run-id>]"],
    positionals: "One or more issue numbers, optionally preceded by a manifest path.",
    options: { "--repo-path": COMMON_REPO_OPTION, "--run": RUN_OPTION },
    prerequisites: "The requested issue must have relevant persisted run evidence; --run selects history deliberately.",
    effects: "Reads and formats evidence. It never reruns a worker or validator.",
    cautions: "Normal inspection resolves each issue's current run independently; use --run only for historical evidence.",
    next: ["maestro approve <issue>", "maestro rework <issue>", "maestro status"],
    examples: [["details", "57"], ["details", "57", "63"]],
    positionalKind: "manifest-issues",
    minIssues: 1
  },
  {
    name: "output",
    aliases: ["o"],
    category: "Inspection",
    summary: "Print and copy the latest combined worker/validator report.",
    when: "Use to inspect or share the complete latest run bundle.",
    usages: ["maestro output [--repo-path <path>]"],
    options: { "--repo-path": COMMON_REPO_OPTION },
    prerequisites: "A target repository with a persisted run.",
    effects: "Prints the latest bundle and copies the same text to the system clipboard.",
    cautions: "It does not change Maestro workflow state.",
    next: ["maestro status", "maestro details <issue>"],
    examples: [["output"], ["output", "--repo-path", "../target"]],
    positionalKind: "none"
  },
  {
    name: "approve",
    aliases: ["a"],
    category: "Review",
    summary: "Record human approval for current validator-approved work.",
    when: "Use after inspecting validator-approved results; omit issues to approve all current approvable items.",
    usages: ["maestro approve [manifest.json] [issue ...] [--run <run-id>] [--override]"],
    positionals: "Optional manifest path followed by optional issue numbers.",
    options: { "--repo-path": COMMON_REPO_OPTION, "--run": RUN_OPTION, "--override": { description: "Explicitly approve selected validator-REWORK issues with audited provenance." } },
    prerequisites: "Current validator approval, unless explicit issue numbers and --override authorize a validator-REWORK result.",
    effects: "Records a human review disposition in persisted run state. It does not integrate code.",
    cautions: "Validator approval is not human approval. Human approval is not integration permission. --override requires explicit issues.",
    next: ["maestro commit", "maestro rework <issue>", "maestro status"],
    examples: [["approve"], ["approve", "57", "--override"]],
    positionalKind: "manifest-issues",
    requiresIssuesWith: ["--override"]
  },
  {
    name: "rework",
    category: "Review",
    summary: "Create correction runs for current validator- or human-rejected work.",
    when: "Use when status recommends rework; issue-oriented selection is the normal form.",
    usages: ["maestro rework [issue ...] [manifest.json] [--run <source-run-id>] [-j <count>] [--allow-failing-baseline]"],
    positionals: "Optional issue numbers and at most one manifest path. With neither issues nor --run, selects the newest actionable rejected set.",
    options: { "--repo-path": COMMON_REPO_OPTION, ...CONCURRENCY_OPTIONS, "--run": { ...RUN_OPTION, description: "Deliberately select a historical source run." }, "--allow-failing-baseline": { description: "Explicitly continue despite a failing configured baseline." } },
    prerequisites: "Current rejected evidence, or an explicitly selected historical source run containing eligible work.",
    effects: "Creates child run(s), reuses existing implementation worktrees, and shares repository capacity with safe ready backfill from the resolved manifest.",
    cautions: "Manual rework performs one correction generation. start/next --auto-rework repeat validator-directed corrections up to three attempts. Backfill never expands manifest scope or grants review/integration authority.",
    next: ["maestro status", "maestro details <issue>", "maestro approve <issue>"],
    examples: [["rework", "57"], ["rework"]],
    positionalKind: "loose-manifest-issues",
    exclusive: [["-j", "--concurrency"]]
  },
  {
    name: "discard",
    category: "Review",
    summary: "Abandon selected validator-REWORK results without integrating them.",
    when: "Use when rejected implementation evidence should be settled and manifest truth should decide future scheduling.",
    usages: ["maestro discard [manifest.json] <issue ...> [--run <run-id>]"],
    positionals: "Optional manifest path followed by one or more explicit issue numbers.",
    options: { "--repo-path": COMMON_REPO_OPTION, "--run": RUN_OPTION },
    prerequisites: "Each selected item must have an unreviewed validator-REWORK result.",
    effects: "Records a discard disposition and preserves branch, worktree, and run evidence for audit.",
    cautions: "Does not complete manifest work, delete evidence, close the issue, or integrate code.",
    next: ["maestro status", "maestro start"],
    examples: [["discard", "57"]],
    positionalKind: "manifest-issues",
    minIssues: 1
  },
  {
    name: "resolve",
    category: "Execution",
    summary: "Hand the current merge/rebase conflict to a bounded agent and validate it.",
    when: "Use for the current managed issue conflict, or add --adopt to explicitly hand Maestro an already-active user merge/rebase.",
    usages: ["maestro resolve <issue> [manifest.json] --agent", "maestro resolve [<issue>] [manifest.json] --adopt --agent [--continue]"],
    positionals: "At most one issue number and one optional manifest path. --adopt does not require prior Maestro evidence; --continue resumes the current checkout's persisted adopted operation.",
    options: {
      "--repo-path": COMMON_REPO_OPTION,
      "--agent": { description: "Authorize one bounded code-changing resolver under persisted attempt/time limits.", required: true },
      "--adopt": { description: "Explicitly adopt only the merge/rebase already active in the selected checkout." },
      "--continue": { description: "Resume or validate the persisted adopted operation for this checkout without creating a duplicate run." },
      "--allow-failing-baseline": { description: "Explicitly continue despite a failing configured baseline for managed recovery." }
    },
    prerequisites: "Managed use requires current eligible conflict evidence. Adoption requires an active merge/rebase and resolution.commands (or integration.commands) in the manifest.",
    effects: "Preserves operation/user-state evidence, lets the agent finish only that operation, independently verifies Git state, and runs configured checks. Managed recovery returns to fresh validation/review.",
    cautions: "Adoption authorizes no push, default-branch integration, issue closure, unrelated edits, or stale approval. Unsupported operations and semantic ambiguity stop with recoverable evidence.",
    next: ["maestro status", "maestro details <issue>", "maestro resolve --continue --agent"],
    examples: [["resolve", "57", "--agent"], ["resolve", "--adopt", "--agent"]],
    positionalKind: "loose-manifest-issues",
    conflicts: [["--continue", "$issues"]]
  },
  {
    name: "commit",
    aliases: ["c"],
    category: "Integration",
    summary: "Integrate reviewed work serially and persist completed manifest state.",
    when: "Use only when status reports that the intended current run is ready to commit.",
    usages: ["maestro commit [manifest.json] [--repo-path <path>] [--run <run-id>] [--close-issues]"],
    positionals: "Optional manifest path; defaults to .maestro.json in the target repository.",
    options: { "--repo-path": COMMON_REPO_OPTION, "--run": RUN_OPTION, "--close-issues": { description: "Also close integrated GitHub issues when repository integration policy permits it." } },
    prerequisites: "Every run item needs a valid human disposition; integration gates and repository cleanliness must pass.",
    effects: "Integrates eligible commits one at a time, runs configured gates, advances and commits the manifest, and pushes progress.",
    cautions: "This is the everyday integration boundary and can mutate Git/GitHub state. Rework and discarded items are not integrated.",
    next: ["maestro status", "maestro next"],
    examples: [["commit"], ["commit", "--repo-path", "../target"]],
    positionalKind: "optional-manifest"
  },
  {
    name: "run",
    category: "Advanced / debugging",
    summary: "Use the explicit legacy runner for dry-run, execution, integration, or continuous modes.",
    when: "Use for explicit low-level control or compatibility; prefer start/status/approve/commit/next for supervised work.",
    usages: ["maestro run [manifest.json] [-j <count>] [--execute|--integrate|--continuous] [--allow-failing-baseline]"],
    positionals: "Optional manifest path; defaults to .maestro.json in the target repository.",
    options: { "--repo-path": COMMON_REPO_OPTION, ...CONCURRENCY_OPTIONS, "--execute": { description: "Execute and validate one wave without integration." }, "--integrate": { description: "Execute, validate, and integrate one wave when manifest policy enables it." }, "--continuous": { description: "Repeat the execute-and-integrate loop until a stop condition." }, "--delegate": { description: "Explicitly grant a bounded delegated authorization for --integrate or --continuous." }, "--allow-failing-baseline": { description: "Explicitly continue despite a failing configured baseline." } },
    prerequisites: "Mode-specific capabilities and gates. Integration modes require repository authorization in the manifest.",
    effects: "With no mode flag, prints a dry run. Other modes can create workers or integrate according to the explicit flag.",
    cautions: "--integrate and --continuous fail closed without --delegate. Delegation remains scoped to each resolved wave and is not proof of epic completion.",
    next: ["maestro report", "maestro status"],
    examples: [["run"], ["run", "--execute"]],
    positionalKind: "optional-manifest",
    exclusive: [["--execute", "--integrate", "--continuous"], ["-j", "--concurrency"]]
  },
  {
    name: "reconcile",
    category: "Advanced / debugging",
    summary: "Continue structured Git conflict recovery for retained integration work.",
    when: "Use after commit/integrate-run reports a conflict; select the current recovery by issue number.",
    usages: ["maestro reconcile <issue> [manifest.json] [--allow-failing-baseline]", "maestro reconcile [manifest.json] --run <source-run-id> [--issue <number>]"],
    positionals: "One current issue number for normal recovery and an optional manifest path. Omit the issue only with historical --run selection.",
    options: { "--repo-path": COMMON_REPO_OPTION, "--run": { ...RUN_OPTION, description: "Deliberately select historical source evidence." }, "--issue": { value: "<number>", description: "Legacy issue selector for an explicit historical --run." }, "--allow-failing-baseline": { description: "Explicitly continue despite a failing configured baseline." } },
    prerequisites: "An approved, unintegrated source worker and its retained clean worktree.",
    effects: "Verifies a completed manual operation or rebases the existing implementation, delegates conflict-only repair if needed, then freshly validates a child run.",
    cautions: "Git conflict recovery is not manifest/GitHub reconciliation. User-owned operations are preserved. A clean branch must contain the current target; resolution does not approve, complete, or integrate the issue.",
    next: ["maestro status", "maestro details <issue>", "maestro approve <issue>"],
    examples: [["reconcile", "57"], ["reconcile", "--run", "20260910010101-aaaaaa", "--issue", "57"]],
    positionalKind: "loose-manifest-issues",
    numericOptions: ["--issue"]
  },
  {
    name: "report",
    category: "Advanced / debugging",
    summary: "Print the raw latest persisted run bundle.",
    when: "Use for low-level run diagnostics; output is the everyday shareable form.",
    usages: ["maestro report [--repo-path <path>] [--copy]"],
    options: { "--repo-path": COMMON_REPO_OPTION, "--copy": { description: "Copy the report to the system clipboard." } },
    prerequisites: "A target repository with a persisted run.",
    effects: "Reads the latest run and optionally writes to the clipboard; workflow state is unchanged.",
    cautions: "Unlike output, copy is opt-in and no state-derived recommendation footer is added.",
    next: ["maestro status", "maestro details <issue>"],
    examples: [["report"], ["report", "--copy"]],
    positionalKind: "none"
  },
  {
    name: "review",
    category: "Advanced / debugging",
    summary: "Record a low-level disposition against one explicit persisted run item.",
    when: "Use for historical or human-gate dispositions not covered by everyday approve/discard commands.",
    usages: ["maestro review [manifest.json] --run <run-id> --issue <number> --disposition <value> [--title <title>] [--notes <notes>]"],
    positionals: "Optional manifest path.",
    options: { "--repo-path": COMMON_REPO_OPTION, "--run": { ...RUN_OPTION, required: true }, "--issue": { value: "<number>", description: "Issue in the selected run.", required: true }, "--disposition": { value: "<approve|rework-original|approve-with-follow-up>", description: "Human decision to record.", required: true }, "--title": { value: "<title>", description: "Follow-up issue title; required with approve-with-follow-up." }, "--notes": { value: "<notes>", description: "Follow-up issue body; required with approve-with-follow-up." } },
    prerequisites: "The issue must exist in the selected run. Follow-up approval requires both title and notes.",
    effects: "Writes persisted human review state; a follow-up GitHub issue is created later during integration.",
    cautions: "Recording a disposition does not itself integrate or complete work.",
    next: ["maestro status", "maestro integrate-run --run <run-id>", "maestro rework <issue>"],
    examples: [["review", "--run", "20260910010101-aaaaaa", "--issue", "57", "--disposition", "rework-original"], ["review", "--run", "20260910010101-aaaaaa", "--issue", "57", "--disposition", "approve"]],
    positionalKind: "optional-manifest",
    numericOptions: ["--issue"],
    allowedValues: { "--disposition": ["approve", "rework-original", "approve-with-follow-up"] }
  },
  {
    name: "integrate-run",
    category: "Advanced / debugging",
    summary: "Integrate one explicitly selected, fully reviewed persisted run.",
    when: "Use for deliberate run-ID-oriented recovery or compatibility; prefer commit for current work.",
    usages: ["maestro integrate-run [manifest.json] --run <run-id> [--close-issues]"],
    positionals: "Optional manifest path.",
    options: { "--repo-path": COMMON_REPO_OPTION, "--run": { ...RUN_OPTION, required: true }, "--close-issues": { description: "Close integrated GitHub issues when repository policy permits it." } },
    prerequisites: "A fully reviewed run plus all repository integration gates.",
    effects: "Integrates eligible commits serially and may push/close issues according to configuration and flags.",
    cautions: "Unlike commit, this low-level command does not advance and commit manifest completion.",
    next: ["maestro status", "maestro commit --run <run-id>"],
    examples: [["integrate-run", "--run", "20260910010101-aaaaaa"]],
    positionalKind: "optional-manifest"
  }
];

const WALKTHROUGHS = [
  {
    name: "workflow",
    aliases: ["workflows"],
    summary: "The supervised lifecycle and common exception paths.",
    render: () => `Maestro supervised workflow

1. Scope work:  maestro draft             Preview newly eligible GitHub issues.
                maestro draft --write     Save a reviewed manifest proposal.
2. Inspect:     maestro status            See lifecycle state and the exact next wave.
3. Execute:     maestro start             Run isolated workers and fresh validators.
                maestro start --auto-rework  Also cycle actionable REWORK results (max 3).
4. Inspect:     maestro status            Read states and the recommended next command.
                maestro details 57        Review issue-level evidence when needed.
5. Resolve:     maestro rework 57         Correct rejected work, then inspect again.
                maestro resolve 57 --agent  Repair the current managed Git conflict.
                maestro approve 57        Record human approval of passing work.
6. Integrate:   maestro commit            Serialize integration and persist completion.
7. Continue:    maestro next              Execute newly unblocked work.

Mixed outcomes
  Treat each issue independently: rework rejected items, approve passing siblings,
  and commit only after every item in the selected run has a valid disposition.
  Use maestro status after each action; it derives next steps from persisted state.

Boundaries
  A saved draft is scope, not launch or integration authorization.
  Named worksets select from one shared repository graph; they do not copy lifecycle.
  Epic membership uses recursive GitHub sub-issues, not body mentions or checklists.
  start/next --workset recheck the saved scope revision before recording authorization.
  Validator approval, human approval, delegated eligibility, and integration are separate evidence.
  Selected issues: maestro start 57 63 --delegate --preview, then omit --preview to authorize.
  Workset: maestro start --workset release --delegate. Revoke with maestro revoke <authorization-id>.
  draft --agent --write saves planning evidence only; it never grants delegation.
  Automatic and manual rework create new evidence; neither grants human approval.
  Worker capacity is repository-wide across runs, manifests, and linked worktrees.
  Rework shares spare slots with safe in-scope backfill; capacity never expands scope.
  HUMAN_GATE, technical failure/conflict, invalid validation, and retry exhaustion stop
  automatic correction for that issue while independent passing siblings stay usable.
  Rework and Git-conflict reconciliation create new evidence; neither completes work.
  Explicit adoption (maestro resolve --adopt --agent) is limited to the active
  merge/rebase and configured checks; it never grants push or integration authority.
  Resume with status/next. Use --rerun only to intentionally retry deferred work.
  "No ready work" can still mean blocked, human-gated, or bookkeeping-pending work.

Advanced compatibility
  maestro run --continuous is the existing explicit execute-and-integrate loop. It is
  separate from the supervised persisted-review lifecycle; inspect its stop reason.

See docs/workflows.md for task-based walkthroughs and maestro help <command> for
prerequisites, state changes, and examples.`
  }
];

const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));
const COMMAND_ALIASES = new Map(COMMANDS.flatMap((command) => (command.aliases || []).map((alias) => [alias, command.name])));
const WALKTHROUGH_BY_NAME = new Map(WALKTHROUGHS.flatMap((item) => [
  [item.name, item],
  ...(item.aliases || []).map((alias) => [alias, item])
]));

module.exports = { COMMANDS, COMMAND_BY_NAME, COMMAND_ALIASES, WALKTHROUGHS, WALKTHROUGH_BY_NAME };

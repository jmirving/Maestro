# Maestro

Maestro is a repository agent orchestrator for safe, continuous, dependency-aware software execution.

It coordinates disposable workers, validators, and serialized integration around product truth owned by the target repository. Maestro owns execution mechanics; target repositories own their issues, documentation, tests, capabilities, and human gates.

## Operating model

1. inspect a target repository and its execution manifest;
2. compute work that is actually ready;
3. preflight required capabilities;
4. create isolated branches/worktrees;
5. run bounded Codex workers in parallel;
6. validate each result in a fresh read-only agent context;
7. record explicit human review dispositions;
8. integrate approved changes one at a time;
9. run configured merge-gate validation;
10. persist completed work in the target manifest and repeat.

## Safety defaults

Dry-run remains available through the advanced `run` command. Ordinary `start`/`next` stays supervised: it executes workers and validators but never integrates them. A user may explicitly add `--delegate` for one resolved issue selection or named workset; that creates a durable, revisioned authorization and permits only current in-scope passing results to integrate serially. Workers and validators never grant that authority themselves.

## Install the CLI locally

From the Maestro checkout:

```bash
npm test
npm link
```

`npm link` exposes the repository's existing `bin/maestro.js` as the `maestro` command in the active Node environment.

## CLI help

Start with `maestro help`. It is the canonical interactive guide to Maestro's operating model and groups commands by workflow purpose. `maestro help <command>` and `maestro <command> --help` show the same command-specific guidance, including prerequisites, state changes, likely next actions, and examples. Help resolves before repository discovery, so it also works outside a configured checkout.

Use `maestro help workflow` or [docs/workflows.md](docs/workflows.md) for the expanded supervised lifecycle, mixed outcomes, resume/retry behavior, conflict recovery, and the advanced `run --continuous` compatibility path.

## Everyday target-repository workflow

When run from a target repository containing `.maestro.json`, Maestro now discovers both the Git root and manifest automatically:

```bash
cd ~/Nexus

maestro plan
maestro start
maestro status
maestro details 57
maestro output
# review the pretty-printed output; the same output is also on the clipboard
maestro approve
maestro commit
maestro next
```

`maestro draft` also reconciles work completed outside Maestro. When GitHub records a completed closure, the manifest already says `complete`, and no current Maestro lifecycle conflicts, `maestro draft --write` records external completion provenance. `maestro status` then reports `complete (external)`, while `maestro details <issue>` continues to show older Maestro execution evidence. Not-planned or ambiguous closures remain inactive rather than satisfying dependencies.

Concurrency defaults to two when `defaultConcurrency` is absent. Use `-j` (or
`--concurrency`) on a scheduling command to change only that invocation:

```bash
maestro plan -j 4                 # preview four slots
maestro start --concurrency 4     # execute this wave with four slots
maestro status -j 4               # show the same temporary projection
maestro draft -j 4                # project draft waves; --write still will not save 4
maestro run -j 4 --execute        # advanced runner, same resolution rules
maestro rework -j 2               # bound this correction run
```

The precedence is invocation override, then the repository's saved
`defaultConcurrency`, then the built-in fallback of two. Output identifies the
effective value and source. The value is an upper bound: dependencies, advisory
conflicts, active-work exclusions, human gates, and capability requirements can
still select fewer items, and integration remains serialized. An override is
recorded with execution evidence but never written to the manifest, so a later
independent invocation returns to the saved default.

Use the deliberately narrow config command to inspect or save the repository
default:

```bash
maestro config get defaultConcurrency
maestro config set defaultConcurrency 4
maestro config config/maestro.json set defaultConcurrency 4 --repo-path ../target
```

`config set` validates and atomically updates only `defaultConcurrency` while
preserving the rest of the manifest. It does not launch agents or workers, mutate
GitHub, or run Git commands. Commit and push the changed manifest through the
repository's normal Git workflow when the new default should be shared with other
checkouts. Changing the saved default affects new independent invocations; it does
not resize a running process or a future durable session that has already captured
its effective setting.

Create or refresh that manifest from GitHub issues before planning:

```bash
maestro draft                 # preview GitHub/manifest drift for all issues
maestro draft --write         # persist the schema-valid proposal
maestro draft 101 102 --write # update only these issues; preserve all other work
maestro draft --all           # explicitly reconsider the full issue set
maestro draft --agent         # add bounded semantic recommendations to the dry run
maestro draft --verbose       # expand all evidence, waves, and proposed manifest
maestro draft --json          # emit the complete structured result as JSON only
```

For a bounded epic or named selection, keep using the same draft pipeline:

```bash
maestro draft --epic 42 --agent
maestro draft --epic 42 --name scheduling --write
maestro draft 101 102 --name release-fix --write
maestro draft --workset scheduling --agent --write
maestro plan --workset scheduling
maestro start --workset scheduling
maestro next --workset scheduling
```

To delegate a bounded selection without creating a workset, or delegate a saved workset. The preview includes the exact repository/branch/scope revision, permitted actions, checks, baseline policy, concurrency, and automatic-correction retry/deadline limits that renewal protects:

```bash
maestro start 101 102 --delegate
maestro start 101 102 --delegate --preview
maestro start --workset scheduling --delegate
maestro revoke delegation-20260910010101-aaaaaa-deadbeef1234
maestro start 101 102 --delegate --renew delegation-20260910010101-aaaaaa-deadbeef1234
```

Delegation binds repository checkout identity, target branch, exact scope/revision, policy version, capabilities, baseline policy, integration checks, invocation/available actor, and run lineage. `draft --write`, `draft --agent --write`, ordinary `start`, and `VERDICT: APPROVE` never create it. Revocation is serialized with the final authorization decision: once `maestro revoke` succeeds, an integration that has not entered its final merge/push boundary cannot proceed. It does not undo commits already integrated; renewal creates a new record after scope and policy are resolved again. Issue closure is authorized only when `integration.closeIssues` was explicitly configured. Deployment, force-push, follow-up admission, arbitrary GitHub mutations, and unrelated work are never implied.

Repository configuration, worksets, and execution sessions have distinct jobs. `.maestro.json` contains one repository-wide `work` graph and execution configuration; `worksets.<name>` only records a repository-qualified epic or explicit issue source plus explicit-refresh policy. It does not copy issue lifecycle or grant permission to execute. A successful scoped `--write` stores the resolved, revisioned membership snapshot outside the editable manifest with other Maestro evidence. `start`/`next --workset` is the explicit authorization event: Maestro resolves the source again, refuses scope or requirement drift, and records the authorized membership in that run.

Epic membership uses GitHub's documented parent/sub-issue relationship recursively; ordinary body mentions are never inferred as members. The epic is organizational by default and its body remains read-only planning context. Cycles, duplicate paths, missing/inaccessible children, empty scopes, incomplete relationship retrieval, and cross-repository children block persistence. Closed children remain visible and reconcile to non-runnable history. Dependencies outside membership remain hard prerequisites labeled `outsideScope`; unrelated ready issues are not selected. Shared issues retain one global lifecycle, capacity, and conflict state across worksets.

The default draft is a compact operational summary: proposed change counts and a bounded change list, the manifest-only next-wave projection and concurrency limit, current prerequisites/advisory separation/human decisions/errors, and the exact preview/write/no-op/failure outcome. Current prerequisites are grouped by dependent issue with readable issue titles when available; completed dependencies remain in the manifest and verbose evidence but are not shown as active blockers. Long lists report how many entries were omitted.

Use `--verbose` for full planning decisions, dependency and conflict provenance, every projected wave, agent reasoning/evidence, and the complete proposed manifest. Use `--json` for one parseable JSON document containing the full result, manifest, changes, diagnostics, planning evidence, and final write outcome. `--verbose` and `--json` are mutually exclusive; both work with issue selection, `--all`, `--agent`, and `--write`. `--all` continues to control issue scope only. Formatting modes do not change the proposal, invoke an additional agent, affect validation, or alter write eligibility.

Drafting is deterministic unless `--agent` is selected and never starts workers, changes a delegated scope, or mutates GitHub. It fetches open and closed issues, records GitHub provenance, adds unknown open issues as `ready`, makes closed actionable entries `inactive`, and restores previously reconciled inactive entries when GitHub reopens them. `inactive` preserves closure reason and history without claiming that implementation was accepted. Integrated `complete` history and metadata that GitHub cannot reconstruct remain authoritative. Explicit `Blocked by #123` or `Depends on #123` lines and configured label mappings are GitHub-owned and reversible; manually authored metadata is preserved even when the same dependency or capability is also present in GitHub.

The preview separates safe drift, preserved Maestro state, and lifecycle conflicts. If GitHub changes an issue while its persisted execution, review, rework, or integration state is unresolved, Maestro reports a conflict and leaves that item untouched. `--write` validates the resulting schema and dependency graph, takes a lock, and refuses to overwrite an intervening manifest edit. Selected issue drafting only reconciles those entries. Discovery or reconciliation is planning evidence, not authorization for a worker or a narrower delegated session.

Repositories may opt into exact label mappings without teaching Maestro repository-specific conventions:

```json
{
  "github": {
    "labelMappings": {
      "priority": { "priority:urgent": 1 },
      "mode": { "planning:research": "research" },
      "requires": { "needs:database": ["postgres"] },
      "humanGate": { "review:legal": "Legal approval" }
    }
  }
}
```

`--agent` opts into a planning-only Codex invocation. Maestro supplies a reproducible, size-bounded context made from selected issue data, the deterministic proposal, the tracked repository tree, and prioritized excerpts from `AGENTS.md`, `README.md`, `docs/`, schemas, package metadata, and source. The analyzer runs read-only and ephemerally in a temporary directory, ignores user configuration and rules, and has MCP, hooks, apps, web search, and shell tools disabled. Codex receives a provider-compatible wire schema; Maestro normalizes nullable no-recommendation fields and then enforces the fuller local schema, including uniqueness and nonempty evidence. It has a 120-second timeout, one retry for transient failures, a 200-issue/64 KiB issue budget, a 96 KiB aggregate prompt budget (including the schema, policy, manifest, findings, issues, tree, and excerpts), and a 256 KiB output limit. Definitive provider schema rejections are not retried. Larger inputs must be reduced or selected in smaller explicit batches.

Agent output never starts work or writes directly. Existing manifest values and explicit issue dependencies take precedence. Only high-confidence semantic dependencies enter the proposed `blockedBy` graph; medium- and low-confidence dependency suggestions and all low-confidence work/conflict suggestions remain unresolved for review. References and cycles are validated after merging, and any invocation, schema, reference, or graph failure leaves the existing manifest untouched. Accepted recommendations and non-secret context/output digests are visible in the draft and persisted under `planning.agentAnalysis` for repository-wide analysis or `planning.agentAnalyses.<workset>` for scoped analysis only when the user supplies `--write`. Re-drafting one workset preserves other scoped evidence and reports changes to issues shared by explicit worksets.

### Agent drafting troubleshooting and live smoke

An `invalid_json_schema` or `Invalid schema for response_format` error is a compatibility failure between Maestro's agent-planning wire schema and the Codex provider, not evidence that `.maestro.json` is corrupt. Leave `--agent` off to use the deterministic path explicitly: `maestro draft --write`. Other invalid-output, reference, and graph errors remain fail-closed and must be corrected rather than bypassed.

To opt into a real-Codex smoke test in a disposable or otherwise safe target checkout, first run preview mode with `maestro draft <issue> --agent --verbose`. After reviewing that proposal and preserving the current manifest, exercise persistence with `maestro draft <issue> --agent --write --verbose`, inspect the `planning.agentAnalysis` evidence, and restore the fixture if the write was only a smoke test. This manual procedure requires an authenticated Codex installation and is intentionally excluded from normal CI.

Advisory overlap is stored separately under `planning.advisoryConflicts`; it can serialize likely-conflicting work without inventing a product dependency. Analyzers are pluggable in the deterministic draft core. The built-in analyzer is opt-in and only considers repository-configured labels:

```json
{
  "planning": {
    "analyzers": [
      { "type": "shared-label", "labels": ["area:api", "area:database"], "confidence": "medium" }
    ]
  }
}
```

`maestro approve` without issue numbers approves every currently relevant validator-approved, unreviewed item across the active workflow state. Passing siblings remain approvable when another issue has moved into a child rework run. Rework-required items are skipped and reported with an issue-oriented next command. Supply issue numbers to approve their latest current approvable states, even when those states belong to different runs:

```bash
maestro approve 57 63
```

Validator rework remains a fail-closed state: plain `maestro approve 7` refuses it and `maestro rework 7` is the recommended correction path. When a human intentionally disagrees with that verdict, `maestro approve 7 --override` records a distinct `approve-override` disposition together with a snapshot of the overridden validator verdict, exit code, and report. The override flag requires explicit issue numbers.

`maestro discard 7` abandons an unreviewed validator-REWORK implementation without integrating it, completing the manifest item, or closing the GitHub issue. It records a `discard` disposition, preserves the isolated branch/worktree and run evidence for audit, and makes an item whose manifest status remains `ready` eligible for a fresh `start`/`next` run. Discard also requires explicit issue numbers.

Use `maestro approve --run <run-id>` only when intentionally reviewing one historical run.

`maestro rework` selects every currently relevant validator-rejected item from the newest actionable source run. `maestro rework <issue...>` resolves each requested issue to its authoritative current state, so the `Next:` command printed by approval or conflict evidence can be executed directly. It creates one capacity-reserved correction child for new corrections, but a refresh-conflict continuation resumes that same child and charged attempt. Use `maestro rework --run <run-id>` only for deliberate historical or whole-run rework; it is not the normal recovery command.

`maestro commit` integrates the latest reviewed run, updates the matching work items to `complete` in `.maestro.json`, commits and pushes that manifest progress, then re-evaluates the effective graph and backfills newly eligible work within the integrated run's authorization. If a prior attempt integrated only part of a run, invoking `commit` again skips the recorded integrations and resumes the remaining approved items. Its summary distinguishes newly integrated work, already integrated work, and a run with nothing remaining; `--run <run-id>` provides the same idempotent behavior for an explicitly selected run.

`maestro start` and `maestro next` reconcile manifest readiness with every persisted run and active isolated worktree. They perform a cheap GitHub preflight for every selected item and stop if state, explicit dependencies, or configured label mappings changed since the last draft. Pre-upgrade manifest entries without GitHub provenance fail closed until reconciled. Run `maestro draft --write`, inspect conflicts, then retry. Work already executing, awaiting review, awaiting rework, or awaiting integration is shown as deferred instead of being started again. Selection and slot reservation are atomic across invocations, so two callers cannot claim the same issue or exceed the repository worker budget. As each original worker settles, ordinary `start`/`next` immediately re-evaluates the authorized scope and backfills its released slot while slower siblings continue; the command output includes those separately persisted backfill runs. Use `--rerun` only when intentionally retrying lifecycle evidence; it never bypasses GitHub drift or active-capacity safety and does not broaden its explicit retry into ordinary backfill.

Add `--auto-rework` to `maestro start` or `maestro next` to send actionable validator `REWORK` results directly through correction and fresh validation. Rework and fresh eligible implementations share one capacity pool: while one slot stays occupied by a correction loop, another can execute independent ready work from the caller's authorized scope, and settled slots are backfilled without a second `next`. Plain `maestro rework` uses the same lifecycle-aware pool and re-reads effective eligibility after every worker settles rather than retaining a launch-time snapshot. An explicit `maestro rework <issue...>` authorizes only those issues; an unqualified rework inherits the source run's saved workset membership, or the resolved manifest when the source was unscoped. Hard dependencies, advisory conflicts, active worktrees, and persisted review/integration evidence still constrain every backfill. Maestro keeps passing siblings independent and stops each issue on `APPROVE`, `HUMAN_GATE`, worker/tool failure, invalid or missing validation, refresh failure, no progress, timeout, or exhaustion. The default budget is three correction attempts per issue within one 30-minute correction session and is persisted across child runs and later invocations. Workers and validators receive only the time remaining in that caller-wide session and are terminated when it expires. A successful worker that creates no new commit is recorded distinctly as `no-progress` without starting a validator. A correction attempt is charged when its child run is created, before preflight and branch refresh, so an interrupted refresh is visible and cannot create free retries. Manual `maestro rework` remains available and uses the same persisted attempt/lineage contract.

Capacity belongs to the coordinated Git repository, not to a manifest path, linked worktree, run, or command invocation. Alternate manifests may narrow which issues a caller authorizes, but they do not create another concurrency budget; active work outside that selection still consumes slots and can impose advisory conflicts. Reservations, validator terminal results, and human review dispositions share one repository ordering: a stale reservation cannot start after newer lifecycle evidence wins, and a transition that loses to a reservation reports the active owner instead of creating contradictory state. Reservations are persisted and released per issue after its worker/validator transition settles, so a slow sibling no longer holds every slot claimed by its original multi-item run. Rework and conflict-resolution agents count like original workers, while an item merely waiting at a human, review, or integration gate does not. The first active invocation fixes the aggregate limit for that active session. An overlapping invocation with a different effective setting joins that existing limit; a changed manifest takes effect after the active session drains. Capacity never expands issue scope, satisfies a human gate, or grants integration permission. `maestro status` shows active/limit usage and explains intentionally idle slots.

Automatic correction never converts validator approval into human approval or integration authority: an approved correction still waits for the normal human review and `maestro commit`. A genuine `HUMAN_GATE` never launches a code-changing worker. Retry exhaustion recommends inspection and retains the triggering validator report, attempt phase, branch, and worktree; the displayed `maestro rework <issue>`, `maestro approve <issue> --override`, and `maestro discard <issue>` alternatives remain executable as explicit human recovery choices. Manual rework may create another audited correction generation beyond the automatic cap, but still creates no approval or integration authority. An ordinary content conflict in Maestro's rework refresh preserves the active rebase and structured source/base/target evidence while a single bounded conflict-only resolver attempts repair in the retained worktree. Maestro accepts that result only after verifying the original branch, target ancestry, cleanliness, retained implementation, and file scope; it then continues the same correction worker and fresh validator without charging a duplicate generation. If manual help is required, `maestro details <issue>` distinguishes an active operation (resolve, `git add`, and `git rebase --continue`) from an aborted operation (fetch and recreate the displayed rebase first). After finishing it, run the issue-only `maestro rework <issue>` or `maestro reconcile <issue>` continuation. Maestro verifies the completed operation, refreshes against later target movement, and resumes the original stage in the same persisted conflict run; explicit `--run` selection is reserved for historical evidence. Non-content Git failures such as authentication, transport, invalid refs, locks, or a dirty worktree follow the ordinary failure path and never invoke the resolver.

`maestro details <issue...>` is the verbose issue-level evidence view. It resolves each issue's latest relevant persisted run independently and shows worker results, commits, validator verdicts and reports, human review, integration state, and branch/worktree debugging identifiers. Rework and reconciliation children also include their parent/source evidence so the reason for a correction remains visible. Use `--run <run-id>` to inspect an explicit historical run; no workers or validators are rerun.

`maestro status` is the concise decision surface between workflow actions. It projects each issue's latest relevant state, keeps validator verdicts distinct from human dispositions, reports whether commit is blocked or ready, and ends with executable next commands. In a mixed run it names every missing disposition; once settled, it says exactly which issues will integrate and which will remain out for rework. Use `maestro status <issue...>` for a focused view with the current worker commit, validator verdict, human-review state, integration eligibility, and next actions. `--watch` supports both the repository-wide and focused forms.

For validator-REWORK items, status recommends rework first and shows override and discard only as explicit alternatives. `maestro details` displays the resulting disposition and any validator override provenance.

The resolved manifest may be untracked, ignored, or contain pending edits when `maestro commit` starts. Maestro preserves that file while it integrates approved worker branches, restores it unchanged, and only then records completed work. An ignored manifest is explicitly force-added when that progress is committed. Changes to any other file still block integration. Worker or incoming changes that conflict with the preserved manifest stop with an explicit recovery message; the original manifest remains available in the named Git stash.

Short aliases are available for the high-frequency loop:

```text
s   start
st  status
o   output
a   approve
c   commit
n   next
```

`maestro start`, `next`, `rework`, `approve`, `commit`, `status`, and `output` end with the same state-derived recommendation footer. Mixed validator results prioritize issue-oriented rework while keeping inspection and unaffected approvals available; validator-approved work recommends human approval, fully reviewed runs recommend commit, and integrated work with another ready wave recommends `maestro next`. Recommendations omit run IDs unless a historical run is required by the accepted command.

`maestro output` always pretty-prints the latest combined worker/validator bundle plus its compact operational summary and recommendation footer to the terminal, and copies that identical shareable text to the clipboard.

## Explicit / advanced CLI

Explicit manifests and repo paths remain supported:

```bash
npm test

# Inspect ready work only
maestro plan examples/nexus-scheduling.json --repo-path ../Nexus

# Show the selected wave and capability preflights without executing
maestro run examples/nexus-scheduling.json --repo-path ../Nexus

# Execute isolated workers + fresh validators, but do not integrate
maestro run examples/nexus-scheduling.json --repo-path ../Nexus --execute

# Execute, validate, and integrate one wave (manifest must enable integration)
maestro run examples/nexus-scheduling.json --repo-path ../Nexus --integrate

# Repeat waves until blocked/complete/human-gated
maestro run examples/nexus-scheduling.json --repo-path ../Nexus --continuous

# Existing persisted-run controls remain available
maestro report --repo-path ../Nexus --copy
maestro review examples/nexus-scheduling.json --repo-path ../Nexus --run <run-id> --issue <number> --disposition approve
maestro integrate-run examples/nexus-scheduling.json --repo-path ../Nexus --run <run-id>
```

See `docs/architecture.md` and `docs/execution-model.md` for the execution contract.

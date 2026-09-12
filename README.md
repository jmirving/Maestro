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

Dry-run remains available through the advanced `run` command. The ergonomic `start`/`next` commands execute workers and validators but never integrate them. Integration still requires recorded human review for every item in the persisted run and remains serialized. Workers cannot close issues or merge the default branch themselves.

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

Create or refresh that manifest from GitHub issues before planning:

```bash
maestro draft                 # review all newly eligible open issues
maestro draft --write         # persist the schema-valid proposal
maestro draft 101 102 --write # update only these issues; preserve all other work
maestro draft --all           # explicitly reconsider every eligible open issue
maestro draft --agent         # add bounded semantic recommendations to the dry run
```

Drafting is deterministic and never starts workers or mutates GitHub. Existing work entries and manually authored `blockedBy` relationships are preserved. Previously unknown open issues are added as `ready`, while explicit `Blocked by #123` or `Depends on #123` lines become hard dependencies. The output explains the expected concurrency-bounded execution waves and the source of dependency and advisory decisions. Cycles and references to work absent from the manifest block `--write`.

`--agent` opts into a planning-only Codex invocation. Maestro supplies a reproducible, size-bounded context made from selected issue data, the deterministic proposal, the tracked repository tree, and prioritized excerpts from `AGENTS.md`, `README.md`, `docs/`, schemas, package metadata, and source. The analyzer runs read-only and ephemerally in a temporary directory, ignores user configuration and rules, and has MCP, hooks, apps, web search, and shell tools disabled. Codex and Maestro both enforce the structured JSON schema and its evidence/confidence requirements. It has a 120-second timeout, one retry, a 200-issue/64 KiB issue budget, a 96 KiB aggregate prompt budget (including the schema, policy, manifest, findings, issues, tree, and excerpts), and a 256 KiB output limit. Larger inputs must be reduced or selected in smaller explicit batches.

Agent output never starts work or writes directly. Existing manifest values and explicit issue dependencies take precedence. Only high-confidence semantic dependencies enter the proposed `blockedBy` graph; medium- and low-confidence dependency suggestions and all low-confidence work/conflict suggestions remain unresolved for review. References and cycles are validated after merging, and any invocation, schema, reference, or graph failure leaves the existing manifest untouched. Accepted recommendations and non-secret context/output digests are visible in the draft and persisted under `planning.agentAnalysis` only when the user supplies `--write`.

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

`maestro rework` selects every currently relevant validator-rejected item from the newest actionable source run. `maestro rework <issue...>` resolves each requested issue to its current rework-required run, so the `Next:` command printed by approval can be executed directly. If selected issues belong to different source runs, Maestro creates one rework child per source run. Use `maestro rework --run <run-id>` for deliberate historical or whole-run rework.

`maestro commit` integrates the latest reviewed run, updates the matching work items to `complete` in `.maestro.json`, commits that manifest progress, and pushes it so the next invocation advances to newly unblocked work. If a prior attempt integrated only part of a run, invoking `commit` again skips the recorded integrations and resumes the remaining approved items. Its summary distinguishes newly integrated work, already integrated work, and a run with nothing remaining; `--run <run-id>` provides the same idempotent behavior for an explicitly selected run.

`maestro start` and `maestro next` reconcile manifest readiness with every persisted run and active isolated worktree. Work already executing, awaiting review, awaiting rework, or awaiting integration is shown as deferred instead of being started again. Use `--rerun` only when intentionally retrying or discarding that lifecycle protection; reruns are never implicit.

Add `--auto-rework` to `maestro start` or `maestro next` to send actionable validator `REWORK` results directly through correction and fresh validation. Maestro follows only the caller's selected wave (or resumes already-deferred rework when there is no new wave), keeps passing siblings independent, and stops each issue on `APPROVE`, `HUMAN_GATE`, worker/tool failure, invalid or missing validation, refresh failure, no progress, timeout, or exhaustion. The default budget is three correction attempts per issue within one 30-minute correction session and is persisted across child runs and later invocations. Workers and validators receive only the time remaining in that caller-wide session and are terminated when it expires. A successful worker that creates no new commit is recorded distinctly as `no-progress` without starting a validator. A correction attempt is charged when its child run is created, before preflight and branch refresh, so an interrupted refresh is visible and cannot create free retries. Manual `maestro rework` remains available and uses the same persisted attempt/lineage contract.

Automatic correction never converts validator approval into human approval or integration authority: an approved correction still waits for the normal human review and `maestro commit`. A genuine `HUMAN_GATE` never launches a code-changing worker. Retry exhaustion recommends inspection and retains the triggering validator report, attempt phase, branch, and worktree; the displayed `maestro rework <issue>`, `maestro approve <issue> --override`, and `maestro discard <issue>` alternatives remain executable as explicit human recovery choices. Manual rework may create another audited correction generation beyond the automatic cap, but still creates no approval or integration authority. A rework refresh content conflict is persisted separately as `technical-conflict`, with conflicted files and abort/active state captured before Maestro attempts `rebase --abort`; status/details provide an exact source-qualified continuation command such as `maestro rework 7 --run <source-run-id>`, which remains executable even though the failed conflict child is now the current issue state. It consumes the charged attempt but is not treated as validator `REWORK`, a semantic `HUMAN_GATE`, or generic infrastructure failure.

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

# CLI workflows

`maestro help` is the canonical first stop for interactive CLI use. It gives a short workflow map and groups commands by purpose. Use `maestro help <command>` (or `maestro <command> --help`) for the command's prerequisites, state changes, cautions, next actions, and executable examples. Help is safe to run outside a configured repository.

This document holds expanded task walkthroughs so the terminal entrypoint remains scannable. It documents commands that exist today; future scope selection, delegation, and autonomous-session features must add their own walkthroughs when they ship.

## Named workset

Use a workset when delegation is bounded to an epic or explicit issue list rather than the whole repository:

```bash
maestro draft --epic 42 --name team-scheduling --agent
maestro draft --epic 42 --name team-scheduling --agent --write
maestro plan --workset team-scheduling
maestro start --workset team-scheduling
maestro next --workset team-scheduling
```

The first command previews the same deterministic/optional-agent proposal used by an ordinary draft. The second saves the workset definition and its separate scope snapshot; it still starts nothing and authorizes nothing. The explicit `start --workset` invocation re-resolves GitHub sub-issues and requirements, compares them with the saved revision, and records authorization in the execution run. Delegated integration repeats that saved-and-live revision check immediately before integration. If the epic changed, refresh with `draft --workset team-scheduling --write`, inspect additions/removals/closed or reopened members, and authorize a later launch explicitly.

GitHub sub-issues are recursive and paginated. Body checklists and issue mentions are not membership. The parent supplies acceptance context but is not implementation work unless the manifest's epic source explicitly sets `includeParent`. Outside prerequisites stay visible blockers but are not added to authorized execution; unrelated repository-ready items stay out. Review and integration operate on the run's exact selected items, while duplicate-run, advisory-conflict, and capacity protection remain repository-wide.

## Supervised wave

Start or refresh scope, preview the next wave, then execute it:

```bash
maestro draft
maestro draft --write
maestro plan
maestro start
```

The first draft command gives a compact four-part summary of changes, the manifest-only next-wave projection, items needing attention, and the preview/write outcome. It groups active prerequisites under their dependent issue, omits completed prerequisites from the blocker view, and distinguishes hard `waits for` relationships from advisory `scheduled separately` overlap. Use `maestro draft --verbose` for the full proposal and audit trail or `maestro draft --json` for one machine-readable result; those output modes are mutually exclusive and do not change scope or planning behavior. `--write` saves only the schema-valid proposal to `.maestro.json` and rejects an intervening edit; neither form launches work, expands a delegated scope, or grants integration permission. Closed issues become non-runnable `inactive` history rather than assumed-complete work. `plan` is also read-only. `start` checks every selected issue for GitHub drift and rejects legacy entries without reconciliation provenance, then executes the current ready wave in isolated worktrees and validates changed branches in fresh agent contexts, but it does not approve or integrate results.

For routine validator-guided correction, opt in to the bounded loop:

```bash
maestro start --auto-rework
# or, while continuing/resuming:
maestro next --auto-rework
```

Each validator `REWORK` is corrected and validated again, up to three persisted attempts per issue and within one 30-minute caller-wide correction session. Corrections and fresh eligible work in the manifest share the repository capacity pool, so a free slot is backfilled without another `next`; plain `maestro rework` has the same behavior. Workers and validators receive the remaining session time and are terminated when it expires. Approval returns to the normal human-review step. A genuine human gate, worker/tool or non-content refresh failure, invalid/missing validator output, a successful worker with no new commit (`no-progress`), timeout, or exhaustion stops that issue and preserves actionable evidence in `maestro details`; independent siblings may still finish. When Maestro's own rework refresh hits an ordinary content conflict, it preserves the active rebase, records source/base/target provenance and both sides' relevant diffs, and gives one time- and output-bounded resolver only conflict-repair authority. A verified resolution continues the same charged correction into its normal worker and fresh validator; it does not create another correction generation. Semantic ambiguity, resolver failure, or failed ancestry/cleanliness/retained-change verification stops as `human-required` with the active operation and evidence preserved. Authentication, transport, invalid-ref, lock, dirty-worktree, and other non-content failures never invoke the resolver. Automatic rework never approves or integrates code.

Capacity accounting is repository-wide. Alternate manifests and linked worktrees narrow authorization but do not create independent budgets, and active work outside the current selection is still counted. The first invocation with an active reservation owns the session limit until active workers drain; overlapping settings do not add limits or resize that session. Ordinary `start` and `next` re-query effective eligibility whenever an original worker settles, so newly free capacity is filled from the caller's authorized scope before a slower sibling finishes when safe. Explicit `--rerun` remains limited to the requested retry. Status names exhausted capacity, dependency/conflict constraints, gates, and the absence of authorized work separately. Additional capacity never authorizes outside-scope work, human decisions, or integration.

Inspect persisted state before deciding what to do:

```bash
maestro status
maestro details 57
maestro output
```

`status` is the decision surface and ends with state-derived next commands. `details` reads issue-level worker, validator, review, and integration evidence. `output` prints and copies the latest combined report. None reruns work.

Resolve every item in the wave, integrate reviewed work, and continue:

```bash
maestro rework 57
maestro approve 63
maestro status
maestro commit
maestro next
```

Validator approval, human approval, and integration are separate gates. Reworked items receive new worker and validator evidence and still need human review. `commit` is the normal integration boundary: it serializes eligible changes, runs configured gates, advances manifest completion, commits that progress, and pushes it. `next` starts newly eligible work without rerunning items still active elsewhere in the lifecycle.

## Mixed outcomes and partial integration

When one item passes and another needs correction, do not treat the wave as a single verdict:

```bash
maestro status
maestro details 57 63
maestro rework 57
maestro approve 63
maestro status
```

Passing siblings remain approvable while rejected work moves through child rework runs. Integration remains fail-closed until every item in the run being committed has a valid disposition. Once status reports commit readiness, `maestro commit` integrates only eligible approved items; rework and discarded items stay out.

Use `maestro approve 57 --override` only for an intentional, audited human override of a current validator-REWORK verdict. Use `maestro discard 57` to settle and preserve rejected evidence without integrating, completing the manifest item, deleting its worktree, or closing its GitHub issue.

When automatic correction exhausts its retry cap, inspect the lineage first. Status continues to offer `maestro rework 57`, `maestro approve 57 --override`, and `maestro discard 57` as executable, explicit human choices. Manual rework records another correction generation beyond the automatic cap and still waits for review before integration.

## Resume, retry, and no-ready states

Resume an interrupted workflow by reading persisted state:

```bash
maestro status
```

Then run its recommended issue-oriented action or `maestro next`. Resuming does not mean discarding or rerunning completed work. `start` and `next` defer issues already running, awaiting review, awaiting rework, or awaiting integration. Use `--rerun` only to intentionally bypass that protection for manifest-ready work.

For a preserved Git conflict, `maestro details <issue>` prints the exact worktree and commands. If the operation is **active**, keep it in place: resolve the listed files, run `git add -A -- <files>`, finish it with `GIT_EDITOR=true git rebase --continue` (or the displayed merge equivalent), then run the issue-only continuation, such as `maestro rework 57` or `maestro reconcile 57`. If Maestro reports the operation as **aborted**, first `cd` to the displayed worktree, run `git fetch origin <target>` and `git rebase origin/<target>`, resolve and continue that operation, then run the same issue-only Maestro command. Maestro verifies the completed operation, retained implementation, and current target ancestry before resuming the interrupted worker/validator or fresh-validation stage. A rework-refresh recovery updates the existing charged attempt and run; it does not create another generation. Use `--run` only to deliberately select historical evidence, never as the normal continuation.

No ready work is not proof that all scoped work is complete. Check status for dependency blocks, human gates, active worktrees, review decisions, integration readiness, and integrated work whose manifest bookkeeping is still pending.

## Integration conflict recovery

If integration reports a rebase conflict, recover the authoritative current issue state:

```bash
maestro details 57
# resolve and finish the displayed active or aborted Git operation
maestro reconcile 57
maestro status
```

`reconcile` is a narrow Git conflict-recovery path for an approved, unintegrated implementation. It resolves the current conflict by issue, rebases the retained worktree, delegates conflict-only repair when necessary, and runs a fresh validator. A conflict interrupted inside reconciliation resumes that same persisted reconciliation run. `maestro reconcile --run <id> --issue <issue>` remains available only for deliberate historical selection. Git conflict recovery is not GitHub/manifest reconciliation, and a resolved conflict is not automatically human-approved, completed, or integrated.

## Delegated bounded execution

Supervision remains the default. Opt in for an exact selected-issue scope or a previously drafted workset:

```bash
maestro start 57 63 --delegate
maestro start 57 63 --delegate --preview
maestro start --workset release --delegate --auto-rework
```

The authorization is persisted separately from validator, human-review, override, and integration evidence. Explicit selections persist a canonical revision of their live GitHub issue facts; validation binds to it, and status plus the serialized integration boundary re-resolve it. Editing or closing a selected issue after validation makes the delegation ineligible until explicit renewal and fresh validation. Passing current siblings may integrate while a REWORK sibling remains recorded and non-integrable. A `HUMAN_GATE`, invalid validator, policy/scope drift, stale implementation SHA, changed rebase, missing checks, superseded run, or mismatched repository/session fails closed.

Pause and renew explicitly with `maestro revoke <authorization-id>` and `maestro start 57 63 --delegate --renew <authorization-id>`. Revocation and the final delegated decision share the serialized integration boundary: after revocation reports success, pending work cannot merge, push, or close its issue. Renewal is a new authorization after current resolution, not reactivation of historical evidence. Ordinary `start`, `next`, `approve`, and `draft --agent --write` retain their supervised/planning meanings.

## Advanced explicit runner

The run-ID-oriented commands exist for low-level control, history, and recovery. Normal examples intentionally avoid run IDs.

```bash
maestro run                            # dry-run only
maestro run --execute                  # one worker/validator wave
maestro run --integrate --delegate     # explicit delegated one-wave integration
maestro run --continuous --delegate    # delegated compatibility loop
maestro report --copy
maestro integrate-run --run 20260910010101-aaaaaa
```

`run --integrate` and `run --continuous` fail closed without `--delegate`; before each wave they reconcile persisted lifecycle state and apply the same GitHub/manifest drift check, persisted authorization, and integration guard as the ordinary delegated path. Changed, closed, awaiting-review, awaiting-rework, and otherwise superseded work cannot be revived through the compatibility runner. A `no-ready-work` stop reason is not proof of broader epic or repository completion. Prefer `start`, `status`, `approve`, `commit`, and `next` for ordinary supervised operation.

`integrate-run` integrates a specifically selected reviewed run but, unlike `commit`, does not advance and commit `.maestro.json` completion. `review` is the low-level command for explicit historical and human-gate dispositions; use the everyday `approve`, `rework`, and `discard` commands when they cover the current state.

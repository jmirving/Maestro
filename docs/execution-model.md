# Execution Model

## Work states

Maestro normalizes target work into:

- `ready` — may be scheduled now;
- `blocked` — waiting on another work item or failed prerequisite;
- `human_gate` — explicit decision/authorization required;
- `inactive` — GitHub closed the issue; retained for history but never schedulable and not treated as verified completion;
- `running` — worker active;
- `validating` — fresh review active;
- `approved` — validator-approved and waiting on any configured human review;
- `integrating` — serialized merge/verification in progress;
- `complete` — integrated and verified;
- `failed` — execution or validation failed and needs intervention/retry policy.

## Drafting

`maestro draft` is a planning operation, not an execution state or execution authorization. GitHub owns issue existence, open/closed state, explicit issue-body dependencies, and repository-configured label mappings. Maestro owns persisted lifecycle state and curated fields that those mappings did not produce. Draft records per-item GitHub provenance, proposes `ready` entries for unknown open issues, changes stale actionable closed entries to history-preserving `inactive`, and reactivates entries only when their recorded GitHub state proves they were closed and later reopened. An open issue does not by itself reset an integrated `complete` item.

GitHub-owned dependencies and mapped values are reversible on later drafts; manual dependencies and requirements survive. When a legacy manual value also appears in GitHub, reconciliation records both owners so later GitHub removal preserves the manual value while removing values owned only by GitHub. Closure reason is retained so `inactive` never implies verified acceptance. A missing formerly reconciled issue or a material GitHub change overlapping running, review, rework, or integration evidence is an explicit conflict, not an overwrite. Full drafts reconcile the returned issue set; selected drafts preserve unrelated work and planning evidence.

Completion state and provenance are separate. When GitHub records a completed closure, the manifest already says `complete`, and no explicitly current Maestro lifecycle remains, draft can persist `completion.source: external`. That evidence satisfies dependencies without inventing an integration event or deleting historical worker, validator, review, or rework records. Not-planned, duplicate, cancelled, and unsupported closure reasons remain inactive and do not satisfy implementation dependencies. A current worker/review/rework/integration lifecycle produces a human conflict instead of silent adoption, and reopening an externally completed issue removes the adopted completion and makes the item runnable again.

A proposal is schema-validated and its dependency graph is checked before it can be written. Unknown dependency references and cycles fail closed with actionable diagnostics. Closed, malformed, duplicate, or otherwise unsafe issue records remain unresolved for human attention rather than being interpreted semantically.

Ordinary draft output is an operational projection rather than the audit record itself. It shows bounded proposed changes, only the first manifest-projected wave, current unsatisfied prerequisites grouped by dependent issue, advisory serialization, human gates and diagnostics, and the final persistence state. Completed prerequisites are not current blockers. `--verbose` retains all provenance, projected waves, agent evidence, and the proposed manifest; `--json` exposes the complete structured result without human commentary. These modes only format evidence already produced by that invocation.

Agent-assisted drafting is an explicit `--agent` planning strategy. It receives bounded repository and issue context after deterministic drafting, returns structured recommendations through the common planning-analysis interface, and never invokes workers or mutates GitHub. Deterministic and manually curated manifest values have precedence. Only high-confidence inferred hard dependencies are proposed; lower-confidence dependencies and low-confidence work or overlap recommendations are reported as unresolved. All inferred references and the merged graph are validated before `--write` is allowed.

The provider adapter enforces an aggregate exact-prompt context bound, timeout, bounded transient retries, and output-size bounds. It ignores Codex user configuration and disables external tools and hooks so planning cannot inherit write-capable integrations. Its wire schema is limited to the provider's Structured Outputs subset and represents optional work recommendations as required nullable fields. Nulls normalize to omission before the separate full local schema enforces nonempty strings and unique capability/wave membership; they never clear curated values. Definitive provider schema rejections are non-retryable and distinct from repository-manifest validation. A successful written proposal records recommendation evidence plus hashes of the exact context, output, and included tracked files under `planning.agentAnalysis`, or under `planning.agentAnalyses.<workset>` for scoped analysis. Invocation or validation failure happens before persistence and therefore leaves the manifest byte-for-byte unchanged.

## Worksets and authorization

A repository manifest remains the sole execution configuration and contains one canonical `work` graph. A named workset is only a selection definition: an explicit repository-qualified issue list or a repository-qualified GitHub epic whose documented sub-issues are traversed recursively. The epic parent is context, not a duplicate implementation item, unless `includeParent` is deliberate. Body mentions and checklists are unsupported as membership and are not guessed.

Scoped draft uses the ordinary reconcile → deterministic proposal → optional bounded analysis → validate → preview/write pipeline. Only member planning metadata may change; the parent, outside prerequisites, repository architecture, active work, and other worksets are read-only context. Configured advisory analyzers still recompute against repository-wide issue facts so cross-boundary conflicts are added and stale analyzer-owned conflicts are removed. Scoped agent evidence is independent, and shared-issue changes are surfaced. Cross-repository references, incomplete pagination, inaccessible children, cycles, duplicate paths, and empty results are write-blocking diagnostics.

The editable workset definition is not an execution session or authorization. A successful scoped write stores a revisioned membership/facts snapshot beside persisted run evidence, with manifest and snapshot compare-and-swap performed under one lock. `start` or `next --workset` resolves it again and fails closed on drift or when any authorized member is absent from the shared work graph. The resulting run records repository-qualified authorized members, scope revision, timestamp, and explicit-launch provenance. Scheduling filters ready work to that membership while continuing to use global completion, active lifecycle, advisory conflict, and capacity facts. Outside prerequisites remain blockers and cannot become executable merely because they support the selected scope. A new epic child or requirement change requires another scoped draft and a later explicit launch; it never broadens an active run.

## Capability requirements

A work item may require named capabilities such as:

- `node`
- `playwright`
- `postgres`
- `docker`
- `external_research`
- `live_provider_smoke`

Capabilities are repository-configured. Maestro should not assume that `postgres` always means Docker, but a target repository may define Docker as its preflight implementation.

## Human review

Completed worker runs are persisted so human review can happen after execution without respawning workers. Each issue in an approved run may receive one disposition:

- `approve` — integrate the existing approved worker commit;
- `approve-override` — explicitly integrate a validator-REWORK worker commit, retaining a snapshot of the overridden validator verdict, exit code, and report;
- `discard` — exclude a validator-REWORK implementation from integration and return a still-ready manifest item to fresh-run eligibility;
- `rework-original` — do not integrate; return the source issue to implementation;
- `approve-with-follow-up` — integrate the source issue and create a linked follow-up issue from the review note.

Override and discard are issue-explicit actions: bulk plain approval cannot select them. Rework remains the primary recommendation. Discard does not mutate GitHub or the manifest and does not delete the isolated branch/worktree; persisted evidence stays auditable while the discarded run stops deferring new execution for that issue. Repeated planning after discard therefore deterministically selects the item according to the normal manifest dependency and concurrency rules.

Normal approval is issue-oriented. Maestro overlays persisted parent and child runs, chooses the newest workflow evidence for each issue, and approves every validator-approved issue that has not already been reviewed. A newer rework, rejection, running state, review, or integration supersedes older approval evidence. Explicit issue selections may therefore record approval provenance in different runs; `--run` remains the escape hatch for deliberate historical review.

The corresponding `maestro rework <issue...>` command uses the same current-state overlay and only accepts issues whose newest evidence is awaiting rework. Selected issues are grouped by their resolved source runs before execution, preserving correction provenance across diverged lineages. With no issue selection, the command chooses all currently relevant validator-rejected items in the newest actionable source run; newer unrelated runs do not hide that set. Explicit `--run` remains available for historical or whole-run rework.

`start --auto-rework` and `next --auto-rework` use that correction transition inside the shared lifecycle scheduler. Each issue advances independently: `REWORK` creates one correction child and triggers fresh validation; `APPROVE` returns to ordinary human review; `HUMAN_GATE` stops without another worker. Worker, validator, invalid-output, no-progress, timeout, and infrastructure failures also stop only that issue. Corrections and fresh eligible implementations consume the same pool, so an independent authorized item can backfill a spare slot while a sibling correction continues. The caller supplies the authorized manifest scope, capacity, retry policy, and one session-wide correction deadline; backfill never reaches outside that scope. The initial CLI uses a 30-minute automatic-correction deadline. Every worker and validator receives only the time remaining in that shared budget, and an over-budget process is terminated.

The default automatic budget is three correction attempts per issue. Every child stores its source/root lineage, triggering validator snapshot, attempt number, implementation branch/worktree, phase, and outcome. A successful worker that leaves `HEAD` at its base is persisted as `no-progress` without launching a validator; an over-budget worker or validator is persisted as `timeout` with its interrupted stage. The attempt is charged when the child run is first persisted, before preflight or refresh. Thus a refresh failure is recorded as an incomplete attempt rather than a completed correction or an unbounded free retry. For a genuine content conflict in Maestro's rework refresh, the active rebase and structured provenance are persisted before one bounded conflict-only resolver runs in the retained implementation worktree. Success requires the original branch, a clean worktree, target ancestry, at least one retained implementation commit and file, and no changes outside the original implementation/conflicted file set. The same correction generation then proceeds to its normal worker and fresh validator, while the original conflict remains inspectable. Semantic ambiguity, resolver failure, or verification failure is `human-required` and preserves the rebase/evidence plus a source-qualified continuation; authentication, transport, invalid-ref, dirty-worktree, lock, and other non-content failures do not invoke the resolver. Attempt counts and terminal timeout/no-progress outcomes are reconstructed from persisted parent lineage on automatic resume, not reset by a process restart or entrypoint change. Exhaustion is recorded on the current run and requires human inspection. From that state, explicit issue-oriented rework, override, and discard commands remain valid human recovery actions. Manual rework shares and extends the attempt record beyond the automatic cap, but remains an explicit human action and grants no approval or integration permission.

Status is a read-only projection over that current-state overlay and the effective manifest plan. It presents validator outcome, human disposition, and integration eligibility as separate dimensions. Recorded integration and reconciled external completion are terminal across run generations, so older approved workers cannot reappear as commit candidates. A manifest-complete item with execution history but neither kind of completion evidence is instead an explicit consistency conflict; status does not invent evidence or recommend approval, rework, or commit for it. Commit readiness is evaluated against every item in each relevant persisted run, including source-run items superseded by a child correction, so a newer child cannot hide a disposition still required to integrate an approved sibling. That source obligation disappears when no current sibling remains eligible for integration, preventing settled history from becoming a phantom blocker. Repository-wide status stays issue-oriented; focused status adds the latest worker commit and explicit evidence fields without becoming a replacement for verbose `details` output.

User-facing workflow commands consume one shared recommendation projection built from that persisted/current state. It emits at most one primary command and compact valid alternatives. Rework is primary for mixed validator results, details and unaffected approvals remain available, validator-approved work advances to human approval, fully reviewed work advances to commit, and a completed integration advances with `next` when the effective plan exposes more work. Raw process exit codes do not choose the recommendation.

Workers must provide a `### Human review` section that identifies where a visual or behavioral change should appear, the relevant persona/state, and the highest-value regression check. Human review is intentionally lightweight; it is not a duplicate automated test plan.

`integrate-run` consumes the exact persisted worker branches and validator verdicts. It must not respawn implementation workers. Follow-up issues are created before integration with source issue, run ID, and implementation commit provenance.

## Baseline policy

A failing target-repository baseline blocks execution by default. A repository or explicit runtime flag may allow execution against a known failing baseline, but validators may only tolerate failures that are demonstrably unchanged from that captured baseline. New or changed failures remain blocking.

## Stop conditions

Continuous execution pauses when:

- a human gate is reached;
- mandatory capability preflight fails;
- the worker discovers a new long-lived product/domain decision;
- validation rejects the change;
- automatic validator correction reaches a human gate, fails, or exhausts its three-attempt budget;
- required human review chooses `rework-original`;
- integration cannot safely rebase/merge;
- a live or destructive mutation lacks explicit authorization;
- configured retry limits are exhausted.

## Effective scheduling state

The manifest expresses repository intent, while persisted runs express execution lifecycle. Before `start` or `next`, Maestro overlays all persisted original and child runs and active isolated worktrees onto the dependency plan. A manifest-ready issue is deferred while any current run records it as running, awaiting validation or human review, awaiting rework, approved but not integrated, or integrated but not yet recorded complete in the manifest. Other genuinely ready work may still fill available concurrency; active workers consume concurrency until they finish.

An intentional retry must use the explicit `--rerun` option. Editing or leaving a manifest item as `ready` does not silently discard its execution history.

Before `start` or `next` launches selected work, Maestro rereads every selected GitHub issue. Closed state and changed explicit dependency or configured label mapping facts block execution and direct the user back to draft reconciliation. Legacy manually authored entries without provenance also fail closed until `maestro draft --write` records the baseline needed to distinguish GitHub-owned facts from curated manifest metadata.

## Parallelism

Parallel scheduling requires dependency independence, acceptable advisory conflict risk, and capacity. Persisted advisory conflicts can reduce the selected wave but remain distinct from product dependencies; merge/integration remains serialized.

The initial `start`/`next` wave is lifecycle-aware as well: each original issue releases its persisted reservation independently, then triggers an atomic eligibility query and authorized backfill while unfinished siblings retain their slots. Backfilled implementations are persisted as separate runs and appear in command output. A backfill failure fails the command and remains attached to that separate run; it does not rewrite a successfully settled source run or discard its worker and validator evidence. Explicit reruns do not authorize this broader scheduling loop.

Capacity is coordinated at the Git common-directory boundary, so linked worktrees, alternate manifest paths, child runs, and overlapping invocations share one repository budget. Original, correction, rerun, and conflict-resolution reservations are persisted before execution under a repository lock and released per issue when that worker/validator transition settles. The lifecycle scheduler then reloads persisted state and the effective graph before selecting another item; it does not retain a launch-time ready queue. This makes issue ownership and slot claims atomic and visible, including to a later durable controller. Waiting review, human-gate, and integration states retain issue ownership but do not consume a running-worker slot.

Correction admission also compares the expected source run and actionable rework state under that same lock. Validator `APPROVE`/`HUMAN_GATE` results and human review dispositions commit through that repository coordination contract as well. If a lifecycle transition commits first, the stale reservation re-reads it and starts no worker. If the reservation commits first, the competing transition observes the active issue owner and fails closed until that owner records its terminal result and releases capacity. A prepared reservation that reaches a terminal pre-execution outcome is persisted as released and excluded from current workflow evidence.

The first active reservation owns the aggregate limit until its active session drains. Later overlapping invocations inherit that limit even if their manifest requests another value; limits are never added and an in-flight session is not silently resized. Once no worker reservation remains active, the next invocation establishes a new limit from its effective settings. Scope and capacity remain separate: explicit issue selection is the authorization boundary; otherwise rework inherits saved workset membership or the resolved manifest. Repository-wide active work is always counted and may constrain that narrower scope. Free capacity grants neither broader issue authority nor review/integration authority.

The effective per-invocation limit resolves once in this order: explicit `-j` / `--concurrency`, saved repository `defaultConcurrency`, then the built-in fallback of 2. The schema and CLI accept safe integers from 1 through 8. Plans, status projections, draft projections, execution records, rework, and the advanced runner expose the effective value and its source. A temporary projection remains runtime data even when `draft --write` persists other changes.

`maestro config get defaultConcurrency` reports the resolved manifest path, saved value, and fallback. `maestro config set defaultConcurrency N` atomically changes only that local manifest field; it does not execute work or invoke Git/GitHub. Sharing it uses the repository's normal commit/push workflow. Already-running processes retain the value they captured. Changing the repository default does not silently resize the active repository session.

Concurrency is always an upper bound. Hard dependencies, advisory conflicts, active-work exclusions, human gates, and missing capabilities can reduce actual selection, and integration remains serialized. The repository scheduler owns global active-capacity accounting and automatic cross-run backfill. The first active reservation captures the aggregate limit; later invocations inherit it until the session drains, even when they request a different temporary override.

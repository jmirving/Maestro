# Execution Model

## Work states

Maestro normalizes target work into:

- `ready` — may be scheduled now;
- `blocked` — waiting on another work item or failed prerequisite;
- `human_gate` — explicit decision/authorization required;
- `running` — worker active;
- `validating` — fresh review active;
- `approved` — validator-approved and waiting on any configured human review;
- `integrating` — serialized merge/verification in progress;
- `complete` — integrated and verified;
- `failed` — execution or validation failed and needs intervention/retry policy.

## Drafting

`maestro draft` is a planning operation, not an execution state. It proposes `ready` entries for previously unknown open GitHub issues and preserves existing work metadata, completed state, and manually authored dependencies. Explicit `Blocked by` and `Depends on` issue lines may add hard `blockedBy` relationships; advisory analyzers write separate conflict records with provenance. The draft simulates expected waves using hard-dependency readiness, advisory conflict avoidance, and `defaultConcurrency`, but does not launch workers.

A proposal is schema-validated and its dependency graph is checked before it can be written. Unknown dependency references and cycles fail closed with actionable diagnostics. Closed, malformed, duplicate, or otherwise unsafe issue records remain unresolved for human attention rather than being interpreted semantically.

Agent-assisted drafting is an explicit `--agent` planning strategy. It receives bounded repository and issue context after deterministic drafting, returns structured recommendations through the common planning-analysis interface, and never invokes workers or mutates GitHub. Deterministic and manually curated manifest values have precedence. Only high-confidence inferred hard dependencies are proposed; lower-confidence dependencies and low-confidence work or overlap recommendations are reported as unresolved. All inferred references and the merged graph are validated before `--write` is allowed.

The provider adapter enforces an aggregate exact-prompt context bound, timeout, retry, and output-size bounds. It ignores Codex user configuration and disables external tools and hooks so planning cannot inherit write-capable integrations. A successful written proposal records recommendation evidence plus hashes of the exact context, output, and included tracked files under `planning.agentAnalysis`. Invocation or validation failure happens before persistence and therefore leaves the manifest byte-for-byte unchanged.

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

`start --auto-rework` and `next --auto-rework` use that correction transition as a bounded service rather than a separate scheduler. Each issue advances independently: `REWORK` creates one correction child and triggers fresh validation; `APPROVE` returns to ordinary human review; `HUMAN_GATE` stops without another worker. Worker, validator, invalid-output, and infrastructure failures also stop only that issue, allowing an independent authorized sibling to finish. The caller supplies the issue workset and capacity; the service never adds unrelated pending work to fill a slot.

The default automatic budget is three correction attempts per issue. Every child stores its source/root lineage, triggering validator snapshot, attempt number, implementation branch/worktree, phase, and outcome. The attempt is charged when the child run is first persisted, before preflight or refresh. Thus a refresh failure is recorded as an incomplete attempt rather than a completed correction or an unbounded free retry. A content conflict records a source-qualified `maestro rework <issue> --run <source-run-id>` continuation because the failed child supersedes ordinary issue-oriented eligibility; after the branch is resolved safely, that explicit command reads the rejected implementation from the recorded source and links the resumed correction after the conflict child. This preserves charged lineage, makes the resumed outcome current, and grants no approval. Attempt counts are reconstructed from persisted parent lineage on automatic resume, not reset by a process restart or entrypoint change. Exhaustion is recorded on the current run and requires human inspection. From that state, explicit issue-oriented rework, override, and discard commands remain valid human recovery actions. Manual rework shares and extends the attempt record beyond the automatic cap, but remains an explicit human action and grants no approval or integration permission.

Status is a read-only projection over that current-state overlay and the effective manifest plan. It presents validator outcome, human disposition, and integration eligibility as separate dimensions. Commit readiness is evaluated against every item in each relevant persisted run, including source-run items superseded by a child correction, so a newer child cannot hide a disposition still required to integrate an approved sibling. Repository-wide status stays issue-oriented; focused status adds the latest worker commit and explicit evidence fields without becoming a replacement for verbose `details` output.

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

## Parallelism

Parallel scheduling requires dependency independence, acceptable advisory conflict risk, and capacity. Persisted advisory conflicts can reduce the selected wave but remain distinct from product dependencies; merge/integration remains serialized.

Initial default concurrency: 2. Maximum should remain configurable.

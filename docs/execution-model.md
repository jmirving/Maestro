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
- `rework-original` — do not integrate; return the source issue to implementation;
- `approve-with-follow-up` — integrate the source issue and create a linked follow-up issue from the review note.

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
- required human review chooses `rework-original`;
- integration cannot safely rebase/merge;
- a live or destructive mutation lacks explicit authorization;
- configured retry limits are exhausted.

## Parallelism

Parallel scheduling requires both dependency independence and capacity. File-overlap prediction may later reduce concurrency but is advisory; merge/integration remains serialized.

Initial default concurrency: 2. Maximum should remain configurable.

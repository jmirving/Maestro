# Architecture

## Principle

**Maestro knows execution mechanics; the target repository knows product truth.**

Maestro should be reusable across Nexus, Clairvoyance, RiftSense, and unrelated repositories without importing their domain models.

## Components

### Controller

Reads the target manifest and issue state, computes ready work, performs capability preflight, creates isolated worker contexts, and owns stop conditions.

### Worker

Executes exactly one unit of work in exactly one isolated branch/worktree. It may inspect, edit, test, commit, and optionally push its worker branch. It may not merge the target default branch or close the issue.

### Validator

Runs in a fresh agent context and evaluates the worker result against the issue, repository instructions, manifest gates, diff, and test evidence.

### Integrator

Serializes approved changes, rebases/refreshes as necessary, verifies required checks, merges, runs post-merge validation, and only then permits issue closure.

### Providers/adapters

GitHub, Git, Codex CLI, Docker/PostgreSQL, Playwright, and future agent runtimes are adapters around the deterministic orchestration core.

Manifest drafting follows the same boundary. The GitHub adapter discovers the checkout's repository and reads issue facts; the deterministic draft core merges those facts into an existing manifest without invoking workers or making provider mutations. A planning-analysis interface accepts injected advisory analyzers, while the bundled shared-label analyzer only activates for labels explicitly named in repository configuration. Hard dependency parsing is limited to explicit issue syntax and existing manifest truth. Advisory relationships retain analyzer, confidence, reason, and source provenance and never become `blockedBy` entries.

### CLI help and command registration

Implemented command names, aliases, accepted flags, examples, workflow grouping, and operational guidance share a structured command registry. The CLI validates invocations against that registry before repository discovery or runtime dispatch, and the help renderer consumes the same entries. Walkthrough topics are registered separately so expanded task guidance can grow without turning the top-level terminal help into a monolithic document.

Help resolution is an adapter-free boundary: top-level help, command help, and recovery-command help must not discover a repository, load a manifest, invoke an agent, run capability checks, or mutate local/GitHub state. Feature work that adds commands or lifecycle modes owns the matching registry entry, examples, and expanded walkthrough updates.

### Persisted-run resolution

Issue-oriented commands resolve persisted execution evidence through the shared run resolver. It can select the newest run globally, the newest run containing a requested set of issues, or the newest semantic match by lifecycle state, validator verdict, human-review disposition, run status, mode, or integration state. Callers that operate across diverged issue histories can resolve each issue independently; callers that require one common run fail clearly when the issues resolve to different runs. An explicit run ID always constrains lookup to that historical run.

The details projection is a read-only consumer of that resolver. It formats only requested issues, follows recorded `parentRunId` links for rework/reconciliation provenance, and exposes the persisted worker, validator, review, and integration evidence without invoking execution adapters. Raw combined artifacts remain the responsibility of `maestro output`.

The recommendation formatter is another consumer of the shared current-state projection. It centralizes command eligibility and priority instead of letting individual CLI handlers infer actions from their own exit status. `status` renders the footer beneath its concise decision view; execution commands append the same issue summary and footer; and `output` includes the footer in both terminal and clipboard copies of the artifact.

Review dispositions are interpreted at the shared lifecycle boundary. An audited `approve-override` makes validator-REWORK evidence integrable and is passed explicitly to the integrator, which revalidates its validator-verdict provenance before merging. Validator-REWORK evidence without that authorization remains excluded. A `discard` settles that run item but removes it from effective scheduling deferrals. The manifest remains product truth for whether discarded work is ready, blocked, human-gated, or complete. Discarded branches and worktrees are retained as execution evidence rather than cleaned up as a side effect of review.

Validator correction is a reusable lifecycle service over the same manual rework child-run primitive. It accepts an authorized issue set, capacity, retry budget, and caller-wide deadline; resolves each issue's current evidence before acting; passes remaining time to worker and validator process adapters; and persists attempt charge, trigger, source/root lineage, phase, and terminal outcome. Timeout and successful-without-a-commit (`no-progress`) are distinct terminal outcomes that survive resume. Per-issue loops are independent so one gate or failure does not discard a passing sibling. Descendant lineage takes precedence over lexical run-ID ordering when multiple generations are created within one timestamp second.

The optional agent planner uses that planning-analysis interface but keeps model execution in a provider adapter. Maestro assembles and hashes a bounded snapshot of tracked repository context, enforcing the byte cap against the exact prompt including its schema and all serialized inputs. It invokes Codex read-only from a temporary directory with user configuration, external tools, and hooks disabled, then schema-validates its JSON response. The pure draft merger applies explicit precedence and confidence policy, validates references and cycles, and produces the same inspect-before-write proposal flow as deterministic drafting. This keeps provider availability, retries, and timeouts outside scheduling and makes semantic merging testable without Codex or GitHub.

## Isolation

Every concurrent worker must use a separate Git branch and worktree from a recorded base SHA. Shared mutable resources such as a local test database must be explicitly coordinated by capability providers.

## Initial trust boundary

Milestone 1 stops before automatic default-branch integration. The first product proves configuration parsing, dependency planning, capability classification, and dry-run output.

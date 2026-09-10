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

### Persisted-run resolution

Issue-oriented commands resolve persisted execution evidence through the shared run resolver. It can select the newest run globally, the newest run containing a requested set of issues, or the newest semantic match by lifecycle state, validator verdict, human-review disposition, run status, mode, or integration state. Callers that operate across diverged issue histories can resolve each issue independently; callers that require one common run fail clearly when the issues resolve to different runs. An explicit run ID always constrains lookup to that historical run.

The optional agent planner uses that planning-analysis interface but keeps model execution in a provider adapter. Maestro assembles and hashes a bounded snapshot of tracked repository context, invokes Codex read-only from a temporary directory, and schema-validates its JSON response. The pure draft merger applies explicit precedence and confidence policy, validates references and cycles, and produces the same inspect-before-write proposal flow as deterministic drafting. This keeps provider availability, retries, and timeouts outside scheduling and makes semantic merging testable without Codex or GitHub.

## Isolation

Every concurrent worker must use a separate Git branch and worktree from a recorded base SHA. Shared mutable resources such as a local test database must be explicitly coordinated by capability providers.

## Initial trust boundary

Milestone 1 stops before automatic default-branch integration. The first product proves configuration parsing, dependency planning, capability classification, and dry-run output.

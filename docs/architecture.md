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

## Isolation

Every concurrent worker must use a separate Git branch and worktree from a recorded base SHA. Shared mutable resources such as a local test database must be explicitly coordinated by capability providers.

## Initial trust boundary

Milestone 1 stops before automatic default-branch integration. The first product proves configuration parsing, dependency planning, capability classification, and dry-run output.

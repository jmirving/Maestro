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
7. integrate approved changes one at a time when explicitly enabled;
8. run configured merge-gate validation;
9. optionally close completed issues after successful push;
10. repeat until the graph is blocked, complete, or requires a human decision.

## Safety defaults

Dry-run is the default. Worker execution requires `--execute`. Default-branch integration additionally requires both `--integrate`/`--continuous` and `integration.enabled: true` in the target manifest. Workers cannot close issues or merge the default branch themselves, validation is performed in a fresh context, and integration is serialized.

## CLI

```bash
npm test

# Inspect ready work only
node bin/maestro.js plan examples/nexus-scheduling.json

# Show the selected wave and capability preflights
node bin/maestro.js run examples/nexus-scheduling.json --repo-path ../Nexus

# Execute isolated workers + fresh validators, but do not integrate
node bin/maestro.js run examples/nexus-scheduling.json --repo-path ../Nexus --execute

# Execute, validate, and integrate one wave (manifest must enable integration)
node bin/maestro.js run examples/nexus-scheduling.json --repo-path ../Nexus --integrate

# Repeat waves until blocked/complete/human-gated
node bin/maestro.js run examples/nexus-scheduling.json --repo-path ../Nexus --continuous
```

See `docs/architecture.md` and `docs/execution-model.md` for the execution contract.

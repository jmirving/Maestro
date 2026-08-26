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

## Everyday target-repository workflow

When run from a target repository containing `.maestro.json`, Maestro now discovers both the Git root and manifest automatically:

```bash
cd ~/Nexus

maestro plan
maestro start
maestro status
maestro output
# review the pretty-printed output; the same output is also on the clipboard
maestro approve
maestro commit
maestro next
```

`maestro approve` without issue numbers approves every validator-approved, unreviewed item in the latest run. Supply issue numbers to approve only a subset:

```bash
maestro approve 57 63
```

`maestro commit` integrates the latest reviewed run, updates the matching work items to `complete` in `.maestro.json`, commits that manifest progress, and pushes it so the next invocation advances to newly unblocked work.

Short aliases are available for the high-frequency loop:

```text
s   start
st  status
o   output
a   approve
c   commit
n   next
```

`maestro output` always pretty-prints the latest combined worker/validator bundle to the terminal and copies the identical text to the clipboard.

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

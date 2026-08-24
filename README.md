# Maestro

Maestro is a repository agent orchestrator for safe, continuous, dependency-aware software execution.

It coordinates disposable workers, validators, and serialized integration around product truth owned by the target repository. Maestro owns execution mechanics; target repositories own their issues, documentation, tests, capabilities, and human gates.

## Design thesis

Maestro should make autonomous execution safer than repeatedly launching a powerful issue agent by hand.

The first operating model is local-first:

1. inspect a target repository and its execution manifest;
2. compute work that is actually ready;
3. preflight required capabilities;
4. create isolated branches/worktrees;
5. run bounded workers in parallel;
6. validate each result in a fresh agent context;
7. integrate approved changes one at a time;
8. run post-merge validation;
9. close completed work only after integration succeeds;
10. repeat until the graph is blocked, complete, or requires a human decision.

## Safety boundary

The initial product does **not** autonomously merge to a target repository's default branch. Dry-run planning and isolated worker execution are intentionally delivered before automatic integration.

See `docs/architecture.md` and `docs/execution-model.md` for the initial contract.

# Maestro Agent Instructions

## Product boundary

Maestro owns execution mechanics. Target repositories own product truth.

Do not encode target-repository domain rules in Maestro. Repo-specific issues, dependencies, test commands, capability requirements, and human gates belong in the target repository manifest/docs.

## Safety defaults

- Prefer dry-run over mutation.
- Workers operate in isolated branches/worktrees.
- Workers must not push or merge a target default branch or close target issues.
- Validation uses a fresh agent context.
- Integration is serialized.
- Human gates are fail-closed.
- Missing mandatory capabilities block work; they are not silently waived.
- Live/non-idempotent external mutations require explicit repository authorization.

## Development

Keep the orchestration core deterministic and testable without GitHub, Docker, Codex, or other live services. External systems belong behind adapters.

The first milestone is planning/dry-run. Do not add autonomous default-branch integration until isolated execution and validation are proven.

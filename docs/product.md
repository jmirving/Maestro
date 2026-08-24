# Product Direction

Maestro exists to turn a queue of repository work into a safe, inspectable execution loop.

## Primary user

A technical owner who is comfortable delegating implementation to coding agents but does not want to manually babysit every issue, nor allow independent agents to race against shared state.

## Product goals

- Keep useful work moving asynchronously.
- Parallelize only when dependencies and resources permit it.
- Preserve repository-owned product and architecture rules.
- Make required validation a gate rather than a suggestion.
- Escalate ambiguous or irreversible decisions to a human.
- Produce an auditable record of what ran, why it was selected, how it was validated, and what integrated.

## Non-goals for the first release

- A general project-management system.
- Replacing GitHub Issues.
- Inventing product requirements on behalf of target repositories.
- Automatic live-provider mutation without explicit authorization.
- Unreviewed autonomous merges to production branches.

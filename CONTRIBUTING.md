# contributing to poke-core

thanks for helping improve poke-core. this repository is intentionally structured around a deterministic runtime, so contributions should preserve explicit state, typed boundaries, and replayability.

## principles
- prefer small, reviewable changes
- keep control flow deterministic
- avoid hidden side effects in skills
- log every externally visible action
- update docs when the runtime contract changes

## recommended workflow
1. open a concise issue or write a short design note.
2. implement the smallest possible change that preserves the existing state model.
3. add or update tests alongside code changes.
4. verify that sqlite history, snapshots, and transitions still replay cleanly.
5. document any new skill or state transition in architecture.md and roadmap.md if relevant.

## code quality expectations
- use typed objects for plans, steps, execution envelopes, and validation results
- keep skill adapters isolated from orchestrator logic
- prefer explicit errors over silent fallback behavior
- ensure new transitions are added to the state machine and documented
- update exports when schemas or event shapes change

## testing expectations
minimum coverage areas:
- planner output shape
- state-machine transitions
- router resolution logic
- skill execution contracts
- persistence writes and snapshot restoration

if a change affects browser or integration execution, add a smoke test that covers the full path from objective to final state.

## docs expectations
update docs when introducing:
- a new skill
- a new transition
- a new persistence table
- a new validation rule
- a new export format

## commit hygiene
commit messages should describe what changed, not just that something changed.
examples:
- feat: add a browser extraction validator
- fix: block invalid routing transitions
- docs: describe snapshot replay semantics
- test: cover rollback after skill failure

## review checklist
before merging, confirm:
- the orchestrator can still complete a representative task
- history records match the transition path
- snapshots are captured at the intended boundaries
- no new behavior bypasses validation checks
- the repo still reads as a runtime, not a demo

poke-core

single-agent runtime for poke with deterministic orchestration, durable state, skill routing, and verified tool execution.

core ideas
- one orchestrator, many skills
- deterministic state machine with explicit transitions
- durable sqlite state, execution history, and snapshots
- skill router for browser and integration boundaries
- jury checks before actions are committed

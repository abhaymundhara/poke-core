poke-core

single-agent runtime for poke with deterministic orchestration, durable state, skill routing, and verified execution.

what's live
- deterministic task planner and state machine
- durable sqlite store for tasks, plans, attempts, snapshots, and events
- browser skill boundary with file:// and http(s) support
- integration router with provider-specific adapters
- validation checks for plan and execution results

usage
- bun src/cli.ts init --db ./poke-core.sqlite
- bun src/cli.ts run --db ./poke-core.sqlite --task task-1 --objective "browse file:///tmp/page.html and extract the page text"

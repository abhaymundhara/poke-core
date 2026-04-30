poke-core

single-agent runtime for poke with deterministic orchestration, durable state, skill routing, and verified execution.

what's live
- deterministic task planner and state machine
- durable sqlite store for tasks, plans, executions, snapshots, and history
- browser skill boundary with file:// and http(s) support
- router for skill selection
- jury checks for plan and execution verification

usage
- bun src/cli.ts init --db ./poke-core.sqlite
- bun src/cli.ts run --db ./poke-core.sqlite --task task-1 --objective "browse file:///tmp/page.html and extract the page text"

# poke-core roadmap

## product thesis
poke-core is the deterministic runtime beneath a personal assistant: one orchestrator, many skills, explicit state, and verifiable tool execution. the roadmap is organized around hardening the kernel first, then expanding skill coverage, then building the systems needed for trust: validation, rollback, telemetry, and reproducibility.

## phase 0: kernel hardening
- strengthen the task state machine with explicit transition guards and structured rollback rules
- standardize plan objects, execution envelopes, and validation payloads
- persist snapshots before and after every side-effecting step
- add idempotency markers for repeated tool calls and retried tasks
- define a canonical event schema for planning, routing, execution, validation, recovery, and rollback

## phase 1: skill system expansion
- browser navigation, extraction, form interaction, and page-state reconciliation
- integration skills for github, notion, linear, todoist, vercel, and slack
- local filesystem skills for safe reads, writes, diffs, and artifact exports
- terminal execution skill with guarded command templates and output capture
- media/document skill for text extraction and structured parsing

## phase 2: validation and recovery
- deterministic output validation for each skill type
- retry policies with step-local limits and classification of retryable failures
- compensation hooks for side-effecting integrations
- rollback to the last durable snapshot without erasing the failed trace

## phase 3: durable context and memory
- introduce crdt-backed session state for assistant context, user preferences, and task-local memory
- support mergeable state from concurrent runs or multi-device sync
- attach semantic context to tasks while preserving the original execution record
- separate volatile state from durable audit state

## phase 4: integration depth
- github for repo and issue workflows
- notion for structured knowledge and project memory
- linear for planning and issue tracking
- todoist for personal task execution
- vercel for deployment workflows
- slack for team-facing notifications and approvals

## phase 5: observability and replay
- per-task execution trace views
- step-by-step history with state transitions and outputs
- latency, tool count, retry count, and failure classification metrics
- exportable audit bundles for debugging and compliance
- deterministic replay from sqlite journal and snapshots

## phase 6: production engineering
- full test coverage for planner, state machine, router, and persistence
- integration tests for browser and integration skill flows
- snapshot tests for plan generation and serialized state
- performance benchmarks for task throughput and persistence latency
- release automation, linting, and formatting

## near-term milestones
- ship browser and integration flows with recovery and replay
- add an actual github action adapter behind the integration registry
- add a second skill category such as filesystem or terminal
- implement replay tooling for task history
- benchmark task recovery and snapshot restore paths

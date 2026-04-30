# poke-core roadmap

## product thesis
poke-core is the deterministic runtime beneath a personal assistant: one orchestrator, many skills, explicit state, and verifiable tool execution. the roadmap is organized around hardening the kernel first, then expanding skill coverage, then building the systems needed for trust: evaluation, rollback, telemetry, and reproducibility.

## design principles
- deterministic over probabilistic wherever the runtime is making control decisions
- typed boundaries between planning, routing, execution, verification, and persistence
- every externally visible side effect must be represented in sqlite history
- skills are replaceable modules, not hidden prompt chains
- failures are state transitions, not exceptions that disappear into logs
- observability and replay must be treated as first-class product features

## phase 0: kernel hardening
objective: make the orchestrator reliable enough to serve as the default runtime for all assistant actions.

deliverables
- strengthen the task state machine with explicit transition guards and structured rollback rules
- standardize plan objects, execution envelopes, and verification payloads
- persist snapshots before and after every side-effecting step
- add idempotency markers for repeated tool calls and retried tasks
- define a canonical event schema for task planning, routing, execution, verification, and rollback

acceptance criteria
- a task can be replayed from persisted history without hidden state
- invalid transitions fail fast and are recorded in history
- rollback restores the last durable snapshot and preserves the failure cause

## phase 1: skill system expansion
objective: turn the first browser skill into a real capability surface.

skills to add
- browser navigation, extraction, form interaction, and page-state reconciliation
- integration skills for github, notion, linear, todoist, vercel, and slack
- local filesystem skills for safe reads, writes, diffs, and artifact exports
- terminal execution skill with guarded command templates and output capture
- media/document skill for text extraction and structured parsing

skill contract requirements
- every skill exposes canHandle() and execute()
- skill inputs are typed, serializable, and audited
- skill outputs include verification metadata and safe defaults
- external actions must return machine-readable proof of execution whenever possible

## phase 2: verification and jury layer
objective: make tool execution reviewable before it becomes system state.

jury responsibilities
- validate that the selected skill matches the requested step kind
- score execution outputs against expected structure and policy rules
- reject ambiguous results that do not satisfy minimum confidence thresholds
- annotate failures with reasons suitable for both debugging and product telemetry

planned capabilities
- deterministic rubric engine for common tasks like extraction, update, scheduling, and file edits
- model-assisted judging mode that produces scores but never bypasses rule-based guards
- multi-pass verification for high-risk actions such as sending email, changing calendar state, or mutating repositories
- weighted confidence aggregation across step-level and task-level checks

## phase 3: durable context and memory
objective: make the runtime stateful without making it opaque.

workstreams
- introduce crdt-backed session state for assistant context, user preferences, and task-local memory
- support mergeable state from concurrent runs or multi-device sync
- attach semantic context to tasks while preserving the original execution record
- build retention policies so volatile state and durable audit state are separate concerns

acceptance criteria
- state can be merged without destroying history
- every derived context object can be traced back to source events
- task execution remains deterministic even when context is hydrated from multiple sources

## phase 4: integration depth
objective: expose the assistant’s existing surfaces as robust skills.

priority integrations
- github for repo and issue workflows
- notion for structured knowledge and project memory
- linear for planning and issue tracking
- todoist for personal task execution
- vercel for deployment workflows
- slack for team-facing notifications and approvals

integration requirements
- each integration has a typed action layer, not just one generic function
- actions are replayable and track request/response metadata
- sensitive actions require an explicit verification policy
- integrations must degrade gracefully when auth, rate limits, or partial failures occur

## phase 5: observability, replay, and auditability
objective: make the runtime explainable after the fact.

observability features
- per-task execution trace views
- step-by-step history with state transitions and outputs
- latency, tool count, retry count, and failure classification metrics
- exportable audit bundles for debugging and compliance

replay features
- reconstruct task state from sqlite history
- deterministic re-execution with captured inputs
- diff original versus replayed outputs to detect drift

## phase 6: production engineering
objective: make poke-core shippable as a durable developer product.

engineering standards
- full test coverage for planner, state machine, router, and persistence
- integration tests for the browser skill and representative tool flows
- snapshot tests for plan generation and serialized state
- performance benchmarks for task throughput and persistence latency
- linting, formatting, and release automation

security standards
- tool allowlists with explicit permission surfaces
- redaction for secrets in logs and exports
- policy gates for destructive actions
- reproducible build artifacts and dependency pinning

## phase 7: platformization
objective: turn the runtime into a reusable assistant kernel.

platform work
- api surface for embedding the runtime in other agents
- cli for local and server-side orchestration
- plugin model for skills and verification policies
- shared schemas for state, events, and exports
- compatibility layer for future model providers and orchestration strategies

## near-term milestones
- complete browser navigation and extraction flows with robust error recovery
- add at least one integration skill with full verification metadata
- add crdt-backed durable state for assistant memory
- implement exportable audit bundles and task replay
- build a benchmark suite for deterministic regressions

## definition of done
poke-core is ready when it can:
- plan a task deterministically
- route each step to the correct skill
- verify the output before advancing
- roll back on failure without losing history
- replay the full task from sqlite
- expose the entire flow through a stable cli and api surface

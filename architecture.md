# poke-core architecture

## overview
poke-core is a single-agent runtime that converts objectives into deterministic tool execution through a typed orchestrator and specialized skill modules. the orchestrator owns control flow, skills own execution, and a validation layer checks outputs before state advances.

## runtime layers

### orchestrator
- accepts an objective and optional context
- materializes or resumes a typed task plan
- persists task status, step cursor, revision, and outputs in sqlite
- coordinates retries, recovery, and rollback
- never calls external tools directly; it delegates via the router

### planner
- converts objectives into an ordered plan with stable step ids and positions
- tags each step with a skill, kind, retry policy, and optional compensation shape
- separates browser steps from integration steps so control flow stays explicit

### skill router
- resolves each step to a skill module by capability
- supports registration of new skills without modifying the orchestrator
- prefers exact descriptor matches, then falls back to capability-based resolution

### skill boundary
- executes one step at a time
- returns structured output and retryability metadata
- may provide a compensation hook for rollback-sensitive flows

### validation layer
- validates plan shape before execution begins
- validates per-step skill results before the task advances
- remains a product boundary, not a hidden control loop

### persistence layer
- stores tasks, plans, attempts, snapshots, events, and graph edges in sqlite
- uses WAL and full synchronous mode for durable execution patterns
- makes replay and postmortem analysis possible from the raw journal

## state machine
- draft -> planning -> routing -> executing -> recovering -> routing
- routing -> completed for the final step
- routing/executing/recovering -> failed/rolled_back on unrecoverable errors
- invalid transitions are blocked explicitly

## execution pattern
1. create or resume task record
2. build and validate a plan
3. snapshot state before a step runs
4. execute the step through the router
5. validate the result
6. persist success or failure as an attempt
7. recover, compensate, or roll back on failure
8. advance the cursor only after a validated step

## integration router design
integration work is isolated behind a generic integration skill that resolves provider-specific adapters. each provider adapter owns its own action set, making it easy to add github, notion, linear, todoist, vercel, slack, or future providers without changing orchestration logic.

## recovery model
- retries are step-local and deterministic
- compensations are invoked only when the skill exposes them
- rollback restores the last durable snapshot and keeps the failed attempt in history
- recovery state is persisted so the task can resume or be analyzed later

## why this is scalable
- state transitions are explicit
- skills are modular and self-describing
- integration providers are registry-backed
- retries and rollback are part of the core runtime contract
- everything important is durable and inspectable in sqlite

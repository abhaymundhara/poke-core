# poke-core architecture

## overview
poke-core is a single-agent runtime that turns a user objective into deterministic tool execution through a typed orchestrator and specialized skill modules. the orchestrator owns control flow, skills own execution, and a verification layer validates outputs before state advances.

this architecture avoids free-form agent loops. all control decisions are explicit, serialized, and replayable.

## runtime layers

### 1. orchestrator
responsibilities:
- accept a task objective and optional context
- convert the objective into a typed task plan
- maintain the active step index and durable task status
- invoke the router for step-to-skill selection
- coordinate persistence, validation, and rollback

properties:
- deterministic control flow
- no hidden mutable state outside sqlite
- every state transition is recorded in history

### 2. planner
responsibilities:
- decompose objectives into a finite ordered list of plan steps
- assign a step kind, title, skill, and structured args
- insert dependency metadata where needed

planner guarantees:
- the same input objective produces the same plan shape for the same planner version
- plans are serializable and inspectable
- planning failures are surfaced before execution begins

### 3. skill router
responsibilities:
- resolve a plan step to an implementation that can handle it
- enforce explicit capability boundaries
- keep browser, integration, filesystem, and terminal actions separate

routing rules:
- a step must declare a kind and skill
- only the matching adapter may execute the step
- unknown kinds fail fast rather than falling through to generic handling

### 4. skill boundary
responsibilities:
- perform the concrete side effect or data extraction requested by the step
- return a structured output envelope
- expose verification metadata for the validation layer

skill contract:
- canHandle(step) returns a boolean
- execute(ctx) returns output, verified, and optional note
- the skill never mutates task state directly
- the skill never decides whether the whole task is complete

### 5. verification layer
responsibilities:
- validate plan structure before execution
- verify each skill result before the orchestrator advances
- classify failures into actionable reasons

verification modes:
- rule-based checks for deterministic validation
- rubric-driven checks for task-specific outcomes
- model-assisted analysis as a secondary signal, never as the sole source of truth

verification outputs:
- ok / not ok
- confidence score
- human-readable reasons

### 6. persistence layer
responsibilities:
- store tasks, plans, executions, history, and snapshots in sqlite
- provide replayable audit trails
- keep snapshots that can restore state after failure

persistent entities:
- tasks: current status, active step, result, and error
- task_plans: serialized plan definitions
- executions: per-step input, output, and verification data
- snapshots: durable checkpoints of runtime state
- history: every transition and rollback event

## state machine

### task states
- draft
- planning
- routing
- executing
- verifying
- completed
- failed
- rolled_back

### transition model
- draft -> planning
- planning -> routing
- routing -> executing
- executing -> verifying
- verifying -> routing for next step
- verifying -> completed at final step
- any active failure path can move to rolled_back after snapshot restoration

### transition guarantees
- invalid transitions are blocked
- every allowed transition is logged
- state changes are monotonic within a single execution branch
- rollback is explicit and persistent

## execution flow

1. receive objective
2. create or load a task record
3. generate a task plan
4. validate the plan
5. route the first step to the matching skill
6. capture skill output and validation signal
7. persist execution and snapshot state
8. advance or roll back based on validation
9. finalize the task when all steps complete

## failure handling

### failure classes
- planning failure: invalid or unsupported objective decomposition
- routing failure: no skill can handle a step
- execution failure: the skill errors or returns unusable data
- validation failure: the result does not satisfy the runtime contract
- state failure: an illegal transition or persistence error occurs

### rollback model
- create a snapshot before the step executes
- on failure, restore the last snapshot and mark the task rolled_back
- preserve the original error and execution trail
- do not delete the failed attempt from history

## current skill boundaries

### browser skill
- navigation to http(s) and file:// targets
- page text extraction
- future support for form interaction and page-state reconciliation

### integration skill
- placeholder for typed API actions across github, notion, linear, todoist, vercel, and slack
- expected to emit deterministic request/response metadata

## future extensions
- filesystem skill with safe edits and diff previews
- terminal skill with command templates and policy gates
- media/document skill with pdf, image, and text extraction
- verifier plugins for domain-specific policies
- replay engine for deterministic re-execution against captured traces

## why this design works
poke-core stays shippable because the system separates responsibility cleanly:
- orchestration is not execution
- execution is not validation
- validation is not persistence
- persistence is not decision making

that separation makes the runtime debuggable, testable, and safe enough to expand into deeper assistant capabilities without turning into prompt soup.

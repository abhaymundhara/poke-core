# poke-core

`poke-core` is the deterministic runtime kernel for Poke: a single-agent orchestration system with durable state, typed skill boundaries, replayable execution history, and verification-first task progression.

The project is designed as infrastructure for assistant workflows where tool use must be explicit, inspectable, and recoverable. Objectives are converted into typed plans, routed through skill modules, validated before state advances, and persisted to SQLite for audit and replay.

## Highlights

- **Deterministic orchestration**: objectives become typed task plans with stable step IDs, retry policies, and explicit state transitions.
- **Durable execution state**: tasks, plans, attempts, snapshots, events, graph edges, memory records, and retrieval traces are stored in SQLite.
- **Skill-based runtime boundary**: browser, integration, autopilot, grounding, user modeling, signal observation, computer-use, harness, and event skills are routed through a common contract.
- **Validation before advancement**: plan and step outputs are checked before the runtime commits progress.
- **RAG and memory primitives**: local retrieval, chunking, hybrid search, evidence tracing, and memory modules are exported for context-aware execution.
- **Inspection-first operations**: task records, events, attempts, snapshots, skills, and benchmark suites are available from the CLI.

## Architecture

At a high level, `poke-core` separates planning, routing, execution, validation, and persistence:

1. The CLI or API receives an objective.
2. The planner materializes a typed task plan.
3. The orchestrator persists state and selects the next runnable step.
4. The skill router resolves the step to a registered skill.
5. The skill executes and returns a structured result.
6. The validator checks the result before the task advances.
7. SQLite records attempts, snapshots, events, and recovery data.

See [architecture.md](./architecture.md) for the deeper system contract.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- macOS, Linux, or another environment supported by Bun and SQLite
- Generated local adapters for integration-backed surfaces, such as MCP GitHub and realtime web search modules, when running the full CLI/autopilot path

No package install step is currently required for the checked-in smoke flows.

## Quick Start

Initialize a local SQLite runtime database:

```bash
bun src/cli.ts init --db ./poke-core.sqlite
```

Generate a plan without executing it:

```bash
bun src/cli.ts plan \
  --db ./poke-core.sqlite \
  --task task-1 \
  --objective "browse file:///tmp/page.html and extract the page text"
```

Run an objective through the orchestrator:

```bash
bun src/cli.ts run \
  --db ./poke-core.sqlite \
  --task task-1 \
  --objective "browse file:///tmp/page.html and extract the page text"
```

Inspect execution state:

```bash
bun src/cli.ts tasks --db ./poke-core.sqlite --task task-1
bun src/cli.ts events --db ./poke-core.sqlite --task task-1
bun src/cli.ts attempts --db ./poke-core.sqlite --task task-1
bun src/cli.ts snapshots --db ./poke-core.sqlite --task task-1
```

## CLI Reference

```text
bun src/cli.ts init      --db <path>
bun src/cli.ts plan      --db <path> --task <id> --objective <text> [--context <json>]
bun src/cli.ts run       --db <path> --task <id> --objective <text> [--context <json>]
bun src/cli.ts tasks     --db <path> --task <id>
bun src/cli.ts events    --db <path> --task <id>
bun src/cli.ts snapshots --db <path> --task <id>
bun src/cli.ts attempts  --db <path> --task <id>
bun src/cli.ts skills    --db <path>
bun src/cli.ts bench     --db <path> [rag|autopilot|search|raidingai|all]
```

## Verification

Run the current smoke and regression checks:

```bash
bun scripts/verify-runtime.ts
bun scripts/bench-rag.ts
bun scripts/verify-rag-hardening.ts
bun src/rag/benchmark.ts
```

Run a focused syntax/type check over the active verification surface:

```bash
bun --check \
  src/rag/*.ts \
  src/graph/poke-graph.ts \
  src/search/nlu.ts \
  src/connections/store.ts \
  scripts/verify-rag-hardening.ts \
  scripts/bench-rag.ts \
  scripts/verify-runtime.ts
```

## Repository Layout

```text
src/cli.ts                 CLI entrypoint
src/orchestrator.ts        Task execution loop and state progression
src/planner.ts             Objective-to-plan conversion
src/state-machine.ts       Runtime state transition rules
src/store.ts               Durable SQLite persistence for task execution
src/skills/                Skill contracts and runtime skill modules
src/runtime/               Runtime service adapters and utilities
src/rag/                   Local RAG corpus, indexing, scoring, and benchmarks
src/memory/                Working and episodic memory primitives
src/graph/                 Retrieval-aware execution graph
src/search/                Search planning, NLU, trust, and evaluation
scripts/                   Smoke tests, benchmarks, and verification scripts
examples/                  Runnable usage examples
```

## Operating Principles

- Keep state transitions explicit and inspectable.
- Preserve failed attempts instead of hiding or overwriting them.
- Prefer small typed boundaries over hidden control loops.
- Treat SQLite as the durable audit trail for runtime behavior.
- Add verification coverage when changing planner, router, persistence, or skill contracts.

## Current Status

`poke-core` is an active runtime kernel, not a packaged production SDK. The core orchestration, persistence, skill routing, RAG benchmarks, and smoke verification flows are live. External integrations and large-scale production hardening should be evaluated against the roadmap before relying on them in critical workflows.

## Documentation

- [Architecture](./architecture.md)
- [Roadmap](./roadmap.md)
- [Contributing](./CONTRIBUTING.md)
- [Examples](./examples/README.md)

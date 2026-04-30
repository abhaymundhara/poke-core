# examples

this folder shows how to exercise poke-core as a runtime rather than a library of loose utilities.

a representative flow:
1. initialize a sqlite store
2. run an objective through the orchestrator
3. inspect the task record, history, and snapshots
4. replay the same flow against the persisted state

## example objective
```bash
bun src/cli.ts run \
  --db ./poke-core.sqlite \
  --task task-1 \
  --objective "browse file:///tmp/poke-core-test.html and extract the page text"
```

## what to expect
- the planner emits a finite step list
- the router sends browser steps to the browser skill
- the jury verifies the output before the task advances
- sqlite records every transition and snapshot
- the final task state is marked completed on success

## suggested local test page
```html
<html>
  <head><title>poke core test</title></head>
  <body>
    <h1>Hello Poke Core</h1>
    <p>deterministic browser skill boundary.</p>
  </body>
</html>
```

## inspection commands
```bash
bun src/cli.ts tasks --db ./poke-core.sqlite --task task-1
bun src/cli.ts history --db ./poke-core.sqlite --task task-1
bun src/cli.ts snapshots --db ./poke-core.sqlite --task task-1
```

## why this matters
examples should prove the runtime contract:
- the system is deterministic enough to reason about
- state changes are visible after the run
- failures are preserved, not hidden
- the same structure can be extended to integration and filesystem skills later

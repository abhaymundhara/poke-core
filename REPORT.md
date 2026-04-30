poke-core report

status
- public repo initialized at https://github.com/abhaymundhara/poke-core
- deterministic orchestrator loop is live
- browser skill boundary is working end to end
- rollback and history persistence are implemented

architecture
- typed task plan and step model
- sqlite-backed task, plan, execution, snapshot, and history tables
- router-based skill dispatch with a browser adapter and integration adapter
- internal jury checks for plan validity and execution verification
- explicit state machine with planning, routing, executing, verifying, completed, failed, and rolled_back states

smoke test
- ran a local browser task against a file:// page
- task completed successfully
- extracted page text persisted in sqlite

# Planner Intelligence Skill

The planner is a closed-loop execute-observe-replan controller for search and synthesis.

## Core architecture
- Intent acquisition: semantic NLU produces a structured SearchIntent.
- Heuristic fallback: when the provider is unavailable or strictSemanticNlu is disabled, the runtime uses the deterministic heuristic extractor and marks intent.nlu.fallbackUsed.
- Query generation: candidate queries are derived from semanticQuery, entities, topics, evidence terms, and strategy-specific bias.
- Execute/observe/replan loop: the planner executes a hop, observes evidence trust and grounding quality, then replans until the trajectory stabilizes or the hop budget is exhausted.
- Fail-closed trust gate: low evidence trust forces another hop or escalation. Low-confidence evidence is never treated as final.
- Grounded evidence fusion: propositions are accepted only when they can be anchored to source spans and verified across independent sources. Single-source lexical similarity is insufficient for entailment.

## Trust policy
- Use trust thresholds from policy state and runtime decisioning.
- Require corroboration for contested or low-trust evidence.
- Escalate when evidence remains below threshold after replanning.

## Grounding policy
- Prefer exact or near-exact source-span matches from titles, snippets, and source claims.
- Track independent corroboration across distinct sources and domains.
- Penalize negation, polarity clashes, and unsupported entailment.

## Planner outputs
A plan should carry:
- structured intent,
- strategy profile,
- query set,
- source ranking,
- hop plan,
- trust notes,
- predicted signals,
- grounded evidence graph.

The implementation is designed to be deterministic, auditable, and fail-closed under uncertainty.
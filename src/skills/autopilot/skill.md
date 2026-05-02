# Autopilot super-intelligent architecture

The autopilot runtime is an event-driven, semantically indexed control loop that converts live signals, forecasted needs, and durable wake policy state into bounded wake decisions.

Core properties:
- Semantic first: discovery begins with learned intent extraction, not brittle string matching.
- Graceful degradation: if the NLU endpoint is unavailable, the runtime falls back to local heuristic extraction without aborting the poll cycle.
- Verified ingestion: live GitHub and web polling only surfaces evidence that can be verified from the remote source or local crawl; when evidence is absent, the runtime emits uncertainty warnings rather than fabricating placeholder events.
- Cross-signal arbitration: incoming signals are scored against objective context, forecasted demand, freshness, and repetition history before waking the loop.
- Wake-policy memory: repeated wakes are recorded with decay, suppression windows, and relevance scores so the loop avoids spam and preserves attention for high-value events.
- Adaptive discovery: background triggers, check-ins, and repository watches are derived from a semantic discovery profile that uses learned overlap scoring across objective text, forecasts, observations, and historical wake memory.

Implementation model:
- live-signals.ts performs live web and GitHub polling, constructs signals and observations from verified evidence, and attaches warnings when no verified evidence is available.
- engine.ts maintains durable wake-policy memory, computes wake arbitration scores, and turns semantic discovery output into background triggers and scheduled check-ins.
- events.ts provides normalized event primitives, semantic overlap scoring, and subscription matching based on discovery similarity rather than rigid regex rules.

The runtime treats uncertainty as a first-class signal. Missing provider access, empty result sets, or unverifiable remote state are reported explicitly and allowed to influence wake planning without becoming synthetic data.

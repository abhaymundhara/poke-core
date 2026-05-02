import type { SearchIntent, SearchPolicyState, SearchSignalForecast } from './types.ts';
import { clamp, stableHash, uniq, words } from './utils.ts';

function horizonFor(intent: SearchIntent): 'immediate' | 'near-term' | 'later' {
  if (intent.freshness === 'live' || intent.focus === 'diagnostic') return 'immediate';
  if (intent.hopBudget > 3 || intent.focus === 'multi-hop') return 'near-term';
  return 'later';
}

function latentNeedLabel(intent: SearchIntent, topic: string, index: number): string {
  return [intent.focus, topic, String(index)].filter(Boolean).join(':').replace(/s+/g, '-').toLowerCase();
}

function forecastTopicCandidates(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): string[] {
  const seedText = [intent.semanticQuery, intent.objective, ...intent.topics, ...intent.querySeeds, ...(behaviorSeed ? Object.keys(behaviorSeed) : [])].join(' ');
  const lexical = words(seedText).filter((word) => word.length > 3 && !/^(this|that|with|from|into|need|want|help|when|what|where|why|how|find|search|please)$/i.test(word));
  const archetypeLabels = (policy.latentIntentModel?.archetypes ?? []).map((archetype) => archetype.label);
  return uniq([...intent.topics, ...intent.querySeeds.slice(0, 3), ...archetypeLabels, ...lexical]).slice(0, 6);
}

function forecastEntry(intent: SearchIntent, policy: SearchPolicyState, topic: string, index: number, behaviorSeed?: Record<string, unknown>): SearchSignalForecast {
  const source = intent.sourceHints[index % Math.max(1, intent.sourceHints.length)] ?? 'web';
  const sourceWeight = policy.sourceReliability[String(source)]?.score ?? intent.sourcePriors.find((prior) => prior.source === source)?.weight ?? 0.56;
  const topicWeight = clamp(0.44 + Math.min(0.18, topic.length / 80) + Math.min(0.16, intent.querySeeds.length * 0.03));
  const confidence = clamp(0.38 + sourceWeight * 0.28 + topicWeight * 0.22 + (intent.focus === 'trust' ? 0.08 : 0) + (intent.focus === 'multi-hop' ? 0.05 : 0));
  const label = latentNeedLabel(intent, topic, index);
  const distribution = [
    { label: label + ':follow-up', probability: clamp(confidence * 0.42), trajectory: [intent.semanticQuery, topic, 'follow-up'], source },
    { label: label + ':expand', probability: clamp(0.3 + confidence * 0.3), trajectory: [intent.semanticQuery, topic, 'expand'], source },
  ];
  const seedKeys = behaviorSeed ? Object.keys(behaviorSeed).slice(0, 4) : [];
  return {
    source,
    topic,
    confidence,
    reason: 'latent-trajectory:' + stableHash([intent.sessionKey, topic, String(index), ...(seedKeys.length ? seedKeys : ['none'])].join('|')).slice(0, 12),
    suggestedQueries: uniq([
      intent.semanticQuery,
      topic,
      topic + ' evidence',
      topic + ' verify',
      topic + ' details',
    ]).slice(0, 4),
    priority: clamp(0.52 + confidence * 0.36 + index * 0.04),
    distribution,
    latentNeed: {
      label,
      features: {
        topicLength: topic.length,
        hopBudget: intent.hopBudget,
        freshness: intent.freshness === 'live' ? 1 : intent.freshness === 'recent' ? 0.66 : 0.32,
        focus: intent.focus === 'multi-hop' ? 1 : intent.focus === 'trust' ? 0.8 : 0.58,
      },
      horizon: horizonFor(intent),
      intervention: 'expand queries toward ' + topic,
      posterior: confidence,
    },
  };
}

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const topics = forecastTopicCandidates(intent, policy, behaviorSeed);
  const forecasts = topics.slice(0, 4).map((topic, index) => forecastEntry(intent, policy, topic, index, behaviorSeed));
  if (forecasts.length > 0) return forecasts.sort((left, right) => right.priority - left.priority);
  return [forecastEntry(intent, policy, intent.semanticQuery || intent.objective, 0, behaviorSeed)];
}

export function persistForecastTrajectory(state: SearchPolicyState, update: { intent: SearchIntent; forecasts: SearchSignalForecast[]; signature: string; pass: number; stabilized: boolean }): SearchPolicyState {
  const now = Date.now();
  const next: SearchPolicyState = {
    ...state,
    forecasts: [...(state.forecasts ?? []), ...update.forecasts].slice(-32),
    latentIntentModel: {
      version: state.latentIntentModel?.version ?? 2,
      archetypes: state.latentIntentModel?.archetypes ?? [],
      transitions: state.latentIntentModel?.transitions ?? {},
      lastUpdatedAt: now,
      statePrototypes: state.latentIntentModel?.statePrototypes,
      trajectoryMemory: {
        ...(state.latentIntentModel?.trajectoryMemory ?? {}),
        [update.intent.sessionKey]: stableHash([update.signature, String(update.pass), update.stabilized ? 'stable' : 'unstable'].join('|')),
      },
    },
    reasoningArchitecture: state.reasoningArchitecture
      ? {
          ...state.reasoningArchitecture,
          revisionLog: [
            ...(state.reasoningArchitecture.revisionLog ?? []),
            { at: now, source: 'search-trajectory', focus: 'strategy', change: 'trajectory ' + update.signature + ' pass ' + String(update.pass) },
          ].slice(-20),
        }
      : state.reasoningArchitecture,
  };
  return next;
}

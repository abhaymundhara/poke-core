import { resolve } from 'node:path';
import type { SearchIntent, SearchPolicyState, SearchSignalForecast, SearchSource } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';

export type BehaviorTrajectoryEvent = {
  sessionId?: string;
  at?: number;
  source?: string;
  action?: string;
  outcome?: 'success' | 'failure' | 'ignored' | 'pending';
  topic?: string;
  category?: string;
  subject?: string;
  confidence?: number;
  durationMs?: number;
  value?: number;
};

const BEHAVIOR_PATHS = [resolve(process.cwd(), '.poke-core', 'behavioral-state.json'), resolve(process.cwd(), '.poke-core', 'behavioral-audit.json'), resolve(process.cwd(), '.poke-core', 'manual-behavioral-audit.json')];

function persistedObservations(): BehaviorTrajectoryEvent[] {
  for (const path of BEHAVIOR_PATHS) {
    const text = extractJson(path);
    if (text.length > 0) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const raw = parsed.observations ?? parsed.trajectory ?? parsed.events;
      if (Array.isArray(raw)) return raw.filter((value): value is BehaviorTrajectoryEvent => Boolean(value) && typeof value === 'object');
    }
  }
  return [];
}

function extractJson(path: string): string {
  try {
    const file = Bun.file(path);
    return file.exists() ? file.textSync() : '';
  } catch {
    return '';
  }
}

function observationsFrom(seed?: Record<string, unknown>): BehaviorTrajectoryEvent[] {
  const raw = seed?.observations ?? seed?.trajectory ?? seed?.events ?? [];
  const explicit = Array.isArray(raw) ? raw.filter((value): value is BehaviorTrajectoryEvent => Boolean(value) && typeof value === 'object') : [];
  return explicit.length > 0 ? explicit : persistedObservations();
}

function sourceFor(topic: string, source?: string): SearchSource | string {
  if (source) return source;
  if (/calendar|schedule|meeting|availability/i.test(topic)) return 'calendar';
  if (/email|thread|reply|relationship/i.test(topic)) return 'email';
  if (/github|repo|issue|commit|pr|pull request/i.test(topic)) return 'github';
  if (/file|path|filesystem|directory/i.test(topic)) return 'filesystem';
  if (/integration|notion|linear|slack|api|webhook/i.test(topic)) return 'integration';
  return 'memory';
}

function forecastPrompt<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema }, './src/search/nlu.ts');
}

function parseForecasts(value: unknown, provider: string): SearchSignalForecast[] {
  if (!Array.isArray(value)) throw new Error('invalid-forecast:' + provider);
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('invalid-forecast:' + provider);
    return entry as SearchSignalForecast;
  });
}

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const observations = observationsFrom(behaviorSeed);
  const raw = forecastPrompt<{ signals: SearchSignalForecast[] }>(
    'forecast the next likely behavioral and search signals',
    { intent, policy, observations, sourceHints: intent.sourceHints, suggestedSource: sourceFor(intent.semanticQuery) },
    {
      type: 'object',
      required: ['signals'],
      properties: {
        signals: { type: 'array' },
      },
    },
  );
  return parseForecasts(raw.signals, 'llm-semantic-inference');
}

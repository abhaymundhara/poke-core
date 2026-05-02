import type { SearchIntent, SearchPolicyState, SearchSignalForecast } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';

function runForecastModel<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema });
}

const FORECAST_SCHEMA = {
  type: 'object',
  required: ['predictions'],
  properties: {
    predictions: { type: 'array' },
  },
};

function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error('missing-' + label);
  return value as T[];
}

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const draft = runForecastModel<{ predictions: SearchSignalForecast[] }>('forecast next signals from the model only', { intent, policy, behaviorSeed }, FORECAST_SCHEMA);
  return requireArray<SearchSignalForecast>(draft.predictions, 'predictions');
}

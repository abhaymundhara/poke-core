import type { SearchIntent, SearchPolicyState, SearchSignalForecast } from './types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge.ts';

function runForecastModel<T>(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): T {
  return extractWithDefaultProviderSync<T>({ objective, context, schema });
}

const FORECAST_SCHEMA = {
  type: 'object',
  properties: {
    predictions: { type: 'array' },
  },
};

export function forecastNextSignals(intent: SearchIntent, policy: SearchPolicyState, behaviorSeed?: Record<string, unknown>): SearchSignalForecast[] {
  const draft = runForecastModel<{ predictions?: SearchSignalForecast[] }>('forecast next signals from the model only', { intent, policy, behaviorSeed }, FORECAST_SCHEMA);
  return draft.predictions as SearchSignalForecast[];
}

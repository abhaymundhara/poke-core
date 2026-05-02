export type AutopilotSignalSource = 'email' | 'calendar' | 'browser' | 'filesystem' | 'integration' | 'memory' | 'system';
export type AutopilotEventKind = 'signal' | 'observation' | 'subscription' | 'wake' | 'resume' | 'pause' | 'tick';

export type AutopilotEventRecord = {
  id: string;
  kind: AutopilotEventKind;
  source: AutopilotSignalSource;
  key: string;
  payload: Record<string, unknown>;
  at: number;
  tags: string[];
};

export type AutopilotSignal = AutopilotEventRecord & {
  kind: 'signal';
  priority: number;
  debounceMs: number;
  throttleMs: number;
  wakeMode: 'debounce' | 'throttle' | 'immediate';
};

export type AutopilotObservation = AutopilotEventRecord & {
  kind: 'observation';
  focus: string;
  value: string;
  confidence: number;
  freshnessMs: number;
};

export type AutopilotSubscription = {
  id: string;
  source: AutopilotSignalSource;
  topic: string;
  match: string[];
  enabled: boolean;
  debounceMs: number;
  throttleMs: number;
  lastMatchedAt: number | null;
};

export type AutopilotWake = {
  id: string;
  key: string;
  source: AutopilotSignalSource;
  reason: string;
  mode: 'debounce' | 'throttle' | 'immediate';
  wakeAt: number;
  payload: Record<string, unknown>;
  debounceMs: number;
  throttleMs: number;
};

export function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function eventKey(kind: AutopilotEventKind, source: AutopilotSignalSource, topic: string, key: string): string {
  return [kind, source, topic, key].map(normalizeToken).filter(Boolean).join(':');
}

export function signalKey(signal: Pick<AutopilotSignal, 'source' | 'key' | 'tags'>): string {
  const tagPart = signal.tags.length > 0 ? signal.tags.map(normalizeToken).slice(0, 3).join('.') : 'untagged';
  return `${normalizeToken(signal.source)}:${normalizeToken(signal.key)}:${tagPart}`;
}

export function tokenizeDiscoveryText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9@._:-]+/g)
    .map((term) => term.trim())
    .filter(Boolean);
}

export function scoreDiscoveryOverlap(left: string, right: string): number {
  const leftTerms = new Set(tokenizeDiscoveryText(left));
  const rightTerms = new Set(tokenizeDiscoveryText(right));
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  let matches = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) matches += 1;
  return matches / Math.max(leftTerms.size, rightTerms.size);
}

export function isHighFrequencySignal(signal: Pick<AutopilotSignal, 'key' | 'tags' | 'priority'>): boolean {
  const signalText = [signal.key, ...signal.tags].join(' ');
  const tokenCount = tokenizeDiscoveryText(signalText).length;
  const density = tokenCount === 0 ? 0 : 1 / tokenCount;
  return signal.priority <= 0.45 || density >= 0.45 || scoreDiscoveryOverlap(signalText, signal.tags.join(' ')) >= 0.72;
}

export function matchesSubscription(subscription: AutopilotSubscription, topic: string, payload: Record<string, unknown>): boolean {
  if (!subscription.enabled) return false;
  const topicText = [subscription.topic, topic, JSON.stringify(payload)].join(' ');
  if (subscription.match.length === 0) return scoreDiscoveryOverlap(subscription.topic, topicText) >= 0.22;
  return subscription.match.some((entry) => scoreDiscoveryOverlap(entry, topicText) >= 0.2 || scoreDiscoveryOverlap(entry, subscription.topic) >= 0.25);
}

export function mergeWake(existing: AutopilotWake, incoming: AutopilotWake): AutopilotWake {
  if (existing.key !== incoming.key) return existing.wakeAt <= incoming.wakeAt ? existing : incoming;
  if (incoming.mode === 'immediate') return { ...incoming, wakeAt: Math.min(existing.wakeAt, incoming.wakeAt) };
  if (incoming.mode === 'debounce') {
    return {
      ...existing,
      wakeAt: Math.max(existing.wakeAt, incoming.wakeAt),
      reason: incoming.reason || existing.reason,
      payload: { ...existing.payload, ...incoming.payload },
      debounceMs: Math.max(existing.debounceMs, incoming.debounceMs),
      throttleMs: Math.max(existing.throttleMs, incoming.throttleMs),
    };
  }

  return {
    ...existing,
    wakeAt: Math.min(existing.wakeAt, incoming.wakeAt),
    reason: incoming.reason || existing.reason,
    payload: { ...existing.payload, ...incoming.payload },
    debounceMs: Math.min(existing.debounceMs, incoming.debounceMs),
    throttleMs: Math.min(existing.throttleMs, incoming.throttleMs),
  };
}

export function createSignal(params: {
  source: AutopilotSignalSource;
  key: string;
  reason: string;
  payload?: Record<string, unknown>;
  priority?: number;
  debounceMs?: number;
  throttleMs?: number;
  wakeMode?: AutopilotSignal['wakeMode'];
  tags?: string[];
}): AutopilotSignal {
  const at = Date.now();
  return {
    id: `${normalizeToken(params.source)}-${normalizeToken(params.key)}-${at}`,
    kind: 'signal',
    source: params.source,
    key: params.key,
    payload: { ...(params.payload ?? {}), reason: params.reason },
    at,
    tags: params.tags ?? [],
    priority: params.priority ?? 0.7,
    debounceMs: params.debounceMs ?? 250,
    throttleMs: params.throttleMs ?? 1_500,
    wakeMode: params.wakeMode ?? (isHighFrequencySignal({ key: params.key, tags: params.tags ?? [], priority: params.priority ?? 0.7 }) ? 'debounce' : 'immediate'),
  };
}

export function createObservation(params: {
  source: AutopilotSignalSource;
  focus: string;
  value: string;
  confidence?: number;
  freshnessMs?: number;
  tags?: string[];
}): AutopilotObservation {
  const at = Date.now();
  return {
    id: `${normalizeToken(params.source)}-${normalizeToken(params.focus)}-${at}`,
    kind: 'observation',
    source: params.source,
    key: params.focus,
    payload: { focus: params.focus, value: params.value },
    at,
    tags: params.tags ?? [],
    focus: params.focus,
    value: params.value,
    confidence: params.confidence ?? 0.74,
    freshnessMs: params.freshnessMs ?? 60_000,
  };
}

export function createSubscription(params: {
  source: AutopilotSignalSource;
  topic: string;
  match?: string[];
  enabled?: boolean;
  debounceMs?: number;
  throttleMs?: number;
}): AutopilotSubscription {
  const at = Date.now();
  return {
    id: `${normalizeToken(params.source)}-${normalizeToken(params.topic)}-${at}`,
    source: params.source,
    topic: params.topic,
    match: (params.match ?? []).map(normalizeToken).filter(Boolean),
    enabled: params.enabled ?? true,
    debounceMs: params.debounceMs ?? 250,
    throttleMs: params.throttleMs ?? 1_500,
    lastMatchedAt: null,
  };
}

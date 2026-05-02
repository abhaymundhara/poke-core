import { randomUUID } from 'node:crypto';
import { createObservation, createSignal, createSubscription, scoreDiscoveryOverlap, signalKey, tokenizeDiscoveryText, type AutopilotObservation, type AutopilotSignal, type AutopilotSignalSource, type AutopilotSubscription, type AutopilotWake } from './events';
import { AutopilotSchedulerWorker, type SchedulerSnapshot } from './scheduler';
import { AutopilotLiveDaemon, type GithubWatch, type LiveDaemonSnapshot, type LiveWebSignalBundle, type PlatformSignalBundle } from './live-signals';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER } from '../search/index.ts';
import type { SearchPlan } from '../search/index.ts';

export type AutopilotTrigger = {
  id: string;
  name: string;
  reason: string;
  cadenceMinutes: number;
  nextRunAt: string;
  action: string;
  source?: AutopilotSignalSource;
  key?: string;
  wakeMode?: AutopilotSignal['wakeMode'];
};

export type AutopilotCheckIn = {
  id: string;
  label: string;
  when: string;
  channel: 'in-app' | 'email' | 'calendar' | 'browser';
  focus: string;
  source?: AutopilotSignalSource;
};

export type AutopilotLiveState = {
  mode: 'event-driven';
  status: 'idle' | 'running' | 'paused';
  loopCount: number;
  lastTickAt: string | null;
  lastResumeAt: string | null;
  lastWakeReason: string | null;
  pendingSignals: number;
  pendingSubscriptions: number;
  observationCount: number;
  nextWakeAt: string | null;
  debounceWindowMs: number;
  throttleWindowMs: number;
  liveWebResults: number;
  liveWebFreshness: number;
  forecastedSignals: number;
  externalEvents: number;
  searchStrategy: string | null;
  daemonRunning: boolean;
  lastExternalPollAt: string | null;
};

export type AutopilotCycle = {
  objective: string;
  mode: 'event-driven';
  harnessSnapshot: {
    relationshipWeight: number;
    openThreads: number;
    calendarConflicts: number;
    staleTransactional: number;
    signalIntensity: number;
  };
  backgroundTriggers: AutopilotTrigger[];
  scheduledCheckIns: AutopilotCheckIn[];
  priorities: string[];
  nextLoopHint: string;
  liveState: AutopilotLiveState;
  liveWeb: LiveWebSignalBundle | null;
  platformSignals: PlatformSignalBundle | null;
  daemon: LiveDaemonSnapshot;
  subscriptions: AutopilotSubscription[];
  observations: AutopilotObservation[];
  scheduler: SchedulerSnapshot;
  signalSummary: Record<string, number>;
  auditTrail: string[];
  loopReason: string;
};

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

type WakePolicyRecord = {
  key: string;
  family: string;
  source: AutopilotSignalSource;
  score: number;
  hitCount: number;
  lastSeenAt: number;
  lastFiredAt: number | null;
  suppressedUntil: number;
  decay: number;
  lastReason: string;
  lastTags: string[];
};

type DiscoveryNeed = {
  label: string;
  source: AutopilotSignalSource;
  key: string;
  reason: string;
  score: number;
  cadenceMinutes: number;
  action: string;
  channel: AutopilotCheckIn['channel'];
  wakeMode: AutopilotSignal['wakeMode'];
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function semanticDiscoveryScore(left: string, right: string): number {
  return scoreDiscoveryOverlap(left, right);
}

function joinDiscoveryText(...parts: Array<string | undefined | null>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join(' ');
}
function summarizeHarnessState(harnessState: Record<string, unknown>) {
  const relationships = asArray(harnessState.relationships).length;
  const threads = asArray(harnessState.threads).length;
  const calendar = asArray(harnessState.calendar).length;
  const signals = asArray(harnessState.signals).length;
  const staleTransactional = asNumber(harnessState.staleTransactional, asNumber(harnessState.stale, 0));
  const relationshipWeight = Math.min(1, asNumber(harnessState.relationshipWeight, 0.35) + relationships * 0.08);
  const openThreads = Math.max(threads, asNumber(harnessState.openThreads, 0));
  const calendarConflicts = Math.max(asNumber(harnessState.calendarConflicts, 0), calendar);
  const signalIntensity = Math.min(1, signals * 0.12 + asNumber(harnessState.signalIntensity, 0.2));
  return { relationshipWeight, openThreads, calendarConflicts, staleTransactional, signalIntensity };
}

function buildTrigger(name: string, reason: string, cadenceMinutes: number, action: string, source?: AutopilotSignalSource, key?: string, wakeMode?: AutopilotSignal['wakeMode']): AutopilotTrigger {
  const safeCadence = Number.isFinite(cadenceMinutes) && cadenceMinutes > 0 ? cadenceMinutes : 60;
  return {
    id: `${name}-${safeCadence}`,
    name,
    reason,
    cadenceMinutes: safeCadence,
    nextRunAt: new Date(Date.now() + safeCadence * 60_000).toISOString(),
    action,
    source,
    key,
    wakeMode,
  };
}

function buildCheckIn(label: string, minutes: number, channel: AutopilotCheckIn['channel'], focus: string, source?: AutopilotSignalSource): AutopilotCheckIn {
  return {
    id: `${label}-${minutes}`,
    label,
    when: new Date(Date.now() + minutes * 60_000).toISOString(),
    channel,
    focus,
    source,
  };
}

function semanticSignalSeed(objective: string, harnessState: Record<string, unknown>, context: Record<string, unknown>, seed: Record<string, unknown> = {}): AutopilotSignal {
  const explicitTags = Array.isArray(seed.tags) ? seed.tags.map(normalizeText).filter(Boolean) : [];
  return createSignal({
    source: (normalizeText(seed.source) as AutopilotSignalSource) || 'system',
    key: normalizeText(seed.key) || 'semantic-seed',
    reason: normalizeText(seed.reason) || normalizeText(context.reason) || objective,
    payload: {
      objective,
      harnessState,
      context,
      semanticSeed: true,
      explicitSeed: seed,
    },
    priority: asNumber(seed.priority, 0.72),
    debounceMs: asNumber(seed.debounceMs, 220),
    throttleMs: asNumber(seed.throttleMs, 1_200),
    wakeMode: (normalizeText(seed.wakeMode) as AutopilotSignal['wakeMode']) || 'debounce',
    tags: explicitTags.length > 0 ? explicitTags : ['semantic-seed'],
  });
}
export class AutopilotEngine {
  private readonly scheduler: AutopilotSchedulerWorker;
  private readonly liveDaemon: AutopilotLiveDaemon;
  private readonly liveNluProvider = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  private readonly subscriptions: AutopilotSubscription[] = [];
  private readonly observations: AutopilotObservation[] = [];
  private readonly signals: AutopilotSignal[] = [];
  private readonly auditTrail: string[] = [];
  private readonly wakePolicyMemory = new Map<string, WakePolicyRecord>();
  private status: 'idle' | 'running' | 'paused' = 'idle';
  private loopCount = 0;
  private lastTickAt: number | null = null;
  private lastResumeAt: number | null = null;
  private lastWakeReason: string | null = null;
  private lastLiveWeb: LiveWebSignalBundle | null = null;
  private lastPlatformSignals: PlatformSignalBundle | null = null;
  private lastSearchPlan: SearchPlan | null = null;
  private liveDaemonStarted = false;

  constructor(
    private readonly objective: string,
    private readonly harnessState: Record<string, unknown> = {},
    private readonly context: Record<string, unknown> = {},
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.scheduler = new AutopilotSchedulerWorker(this.clock);
    this.liveDaemon = new AutopilotLiveDaemon({
      clock: this.clock,
      query: this.resolveLiveQuery(),
      githubWatches: this.resolveGithubWatches(),
      onSignal: (signal) => this.ingestSignal(signal),
      onObservation: (observation) => {
        this.observations.push(observation);
        this.auditTrail.push(`live-observation:${observation.source}:${observation.key}`);
      },
      onEvent: (event) => {
        this.auditTrail.push(`live-event:${event.owner}/${event.repo}:${event.kind}:${event.number}`);
      },
      onWake: (reason, payload) => {
        this.lastWakeReason = reason;
        this.lastResumeAt = this.clock();
        this.status = 'running';
        this.auditTrail.push(`live-wake:${reason}`);
        this.auditTrail.push(`live-wake-payload:${JSON.stringify(payload)}`);
      },
      nluProvider: this.liveNluProvider,
    }, asNumber(this.context.daemonIntervalMs, 15_000));
    this.auditTrail.push(`live-nlu-provider:${this.liveNluProvider.name}`);
    this.seedWakePolicyMemory();
    this.seed();
    if (this.context.liveDaemon !== false) this.startDaemon(asNumber(this.context.daemonIntervalMs, 15_000));
  }

  private seed(): void {
    this.seedContextSubscriptions();
    this.seedContextObservations();
    this.seedContextSignals();
    this.auditTrail.push('seed:subscriptions');
    this.auditTrail.push('seed:observations');
    this.auditTrail.push('seed:signals');
    this.scheduler.wakeNow({
      id: randomUUID(),
      key: 'autopilot-bootstrap',
      source: 'system',
      reason: 'bootstrap autonomy loop',
      mode: 'immediate',
      wakeAt: this.clock(),
      payload: { objective: this.objective },
      debounceMs: 0,
      throttleMs: 0,
      onWake: (wake) => this.onWake(wake),
    });
  }

  private resolveLiveQuery(): string {
    const liveQuery = typeof this.context.liveQuery === 'string' && this.context.liveQuery.trim().length > 0 ? this.context.liveQuery.trim() : '';
    if (liveQuery) return liveQuery;
    if (typeof this.context.query === 'string' && this.context.query.trim().length > 0) return this.context.query.trim();
    return this.objective;
  }

  private resolveGithubWatches(): GithubWatch[] {
    const configured = Array.isArray(this.context.githubWatches) ? this.context.githubWatches : Array.isArray(this.context.liveWatches) ? this.context.liveWatches : [];
    const explicit = configured
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        owner: normalizeText(item.owner),
        repo: normalizeText(item.repo),
        labels: asArray(item.labels).map(normalizeText).filter(Boolean),
        since: typeof item.since === 'string' ? item.since : undefined,
        state: normalizeText(item.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : normalizeText(item.state).toUpperCase() === 'ALL' ? 'ALL' : 'OPEN',
        perPage: asNumber(item.perPage, 5),
      }))
      .filter((watch) => watch.owner.length > 0 && watch.repo.length > 0) as GithubWatch[];
    if (explicit.length > 0) return explicit;
    const profile = this.buildDiscoveryProfile(summarizeHarnessState(this.harnessState));
    const owner = normalizeText(this.context.githubOwner ?? this.context.repoOwner ?? this.context.owner);
    const repo = normalizeText(this.context.githubRepo ?? this.context.repo ?? this.context.repository);
    if (!owner || !repo) return [];
    return [{
      owner,
      repo,
      labels: profile.githubLabels,
      state: 'OPEN',
      perPage: Math.max(3, Math.min(10, 3 + Math.round(profile.needs[0]?.score ?? 0))),
    }];
  }
  startDaemon(intervalMs = asNumber(this.context.daemonIntervalMs, 15_000)): void {
    this.liveDaemon.start(intervalMs);
    this.liveDaemonStarted = true;
    this.auditTrail.push(`daemon:start:${intervalMs}`);
  }

  stopDaemon(): void {
    this.liveDaemon.stop();
    this.liveDaemonStarted = false;
    this.auditTrail.push('daemon:stop');
  }

  async pollLiveSources(): Promise<{ web: LiveWebSignalBundle; platform: PlatformSignalBundle }> {
    const result = await this.liveDaemon.pollOnce();
    this.lastSearchPlan = result.searchPlan;
    this.lastLiveWeb = result.web;
    this.lastPlatformSignals = result.platform;
    this.auditTrail.push(`live-poll:web:${result.web.results.length}`);
    this.auditTrail.push(`live-poll:platform:${result.platform.events.length}`);
    this.auditTrail.push(`live-search-strategy:${result.searchPlan.strategy.name}`);
    if (result.web.warnings?.length) this.auditTrail.push(`live-web-uncertainty:${result.web.warnings.join('|')}`);
    if (result.platform.warnings?.length) this.auditTrail.push(`live-platform-uncertainty:${result.platform.warnings.join('|')}`);
    return { web: result.web, platform: result.platform };
  }

  private seedContextSubscriptions(): void {
    if (!Array.isArray(this.context.subscriptions)) return;
    for (const item of this.context.subscriptions) {
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        this.subscribe(createSubscription({
          source: (normalizeText(record.source) as AutopilotSignalSource) || 'system',
          topic: normalizeText(record.topic) || 'context-subscription',
          match: asArray(record.match).map(normalizeText).filter(Boolean),
          enabled: record.enabled === undefined ? true : Boolean(record.enabled),
          debounceMs: asNumber(record.debounceMs, 250),
          throttleMs: asNumber(record.throttleMs, 1_500),
        }));
      }
    }
  }

  private seedContextObservations(): void {
    if (!Array.isArray(this.context.observations)) return;
    for (const item of this.context.observations) {
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        this.observe(
          (normalizeText(record.source) as AutopilotSignalSource) || 'system',
          normalizeText(record.focus) || 'context-observation',
          normalizeText(record.value),
          asNumber(record.confidence, 0.7),
          asNumber(record.freshnessMs, 60_000),
          asArray(record.tags).map(normalizeText).filter(Boolean),
        );
      }
    }
  }

  private seedContextSignals(): void {
    if (!Array.isArray(this.context.signals)) return;
    for (const item of this.context.signals) {
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        const signal = {
          ...semanticSignalSeed(this.objective, this.harnessState, this.context, record),
          id: `${normalizeText(record.id) || randomUUID()}-${this.clock()}`,
          source: (normalizeText(record.source) as AutopilotSignalSource) || 'system',
          key: normalizeText(record.key) || 'context-signal',
          reason: normalizeText(record.reason) || this.objective,
          payload: asRecord(record.payload),
          priority: asNumber(record.priority, 0.7),
          debounceMs: asNumber(record.debounceMs, 250),
          throttleMs: asNumber(record.throttleMs, 1_200),
          wakeMode: (normalizeText(record.wakeMode) as AutopilotSignal['wakeMode']) || 'debounce',
          at: asNumber(record.at, this.clock()),
          tags: asArray(record.tags).map(normalizeText).filter(Boolean),
          kind: 'signal',
        };
        this.signals.push(signal);
        this.auditTrail.push('signal:' + signal.source + ':' + signal.key);
      }
    }
  }

  private seedWakePolicyMemory(): void {
    const seed = this.context.wakePolicyMemory;
    const entries = Array.isArray(seed) ? seed : seed && typeof seed === 'object' ? Object.values(seed as Record<string, unknown>) : [];
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const key = typeof record.key === 'string' ? record.key : '';
      if (!key) continue;
      this.wakePolicyMemory.set(key, {
        key,
        family: typeof record.family === 'string' ? record.family : key,
        source: (normalizeText(record.source) as AutopilotSignalSource) || 'system',
        score: clamp01(typeof record.score === 'number' ? record.score : 0.6),
        hitCount: typeof record.hitCount === 'number' ? record.hitCount : 0,
        lastSeenAt: typeof record.lastSeenAt === 'number' ? record.lastSeenAt : this.clock(),
        lastFiredAt: typeof record.lastFiredAt === 'number' ? record.lastFiredAt : null,
        suppressedUntil: typeof record.suppressedUntil === 'number' ? record.suppressedUntil : 0,
        decay: clamp01(typeof record.decay === 'number' ? record.decay : 1),
        lastReason: typeof record.lastReason === 'string' ? record.lastReason : '',
        lastTags: Array.isArray(record.lastTags) ? record.lastTags.map(normalizeText).filter(Boolean) : [],
      });
    }
  }

  private rememberWakePolicy(signal: AutopilotSignal, score: number, wakeAt: number, suppressed: boolean): WakePolicyRecord {
    const now = this.clock();
    const key = signalKey(signal);
    const family = `${signal.source}:${signal.tags[0] ?? signal.key}`;
    const previous = this.wakePolicyMemory.get(key);
    const lastFiredAt = previous?.lastFiredAt ?? null;
    const hitCount = (previous?.hitCount ?? 0) + 1;
    const decay = clamp01((previous?.decay ?? 1) * (suppressed ? 0.9 : 0.98));
    const record: WakePolicyRecord = {
      key,
      family,
      source: signal.source,
      score: clamp01(score),
      hitCount,
      lastSeenAt: now,
      lastFiredAt,
      suppressedUntil: suppressed ? Math.max(previous?.suppressedUntil ?? 0, wakeAt) : Math.max(previous?.suppressedUntil ?? 0, now),
      decay,
      lastReason: String(signal.payload.reason ?? signal.key ?? ''),
      lastTags: [...signal.tags].slice(0, 4),
    };
    this.wakePolicyMemory.set(key, record);
    return record;
  }

  private evaluateWakePolicy(signal: AutopilotSignal): { key: string; family: string; score: number; wakeAt: number; suppressed: boolean; reason: string } {
    const now = this.clock();
    const key = signalKey(signal);
    const family = `${signal.source}:${signal.tags[0] ?? signal.key}`;
    const memory = this.wakePolicyMemory.get(key);
    const objectiveText = joinDiscoveryText(this.objective, this.context.hint as string | undefined, this.lastSearchPlan?.intent.semanticQuery, ...(this.lastSearchPlan?.queries ?? []), ...(this.lastSearchPlan?.predictedSignals ?? []).map((entry) => entry.topic), signal.key, signal.payload.reason ? String(signal.payload.reason) : '', signal.tags.join(' '));
    const signalText = joinDiscoveryText(signal.key, signal.payload.reason ? String(signal.payload.reason) : '', JSON.stringify(signal.payload), signal.tags.join(' '));
    const overlap = semanticDiscoveryScore(signalText, objectiveText);
    const freshness = typeof signal.payload.freshness === 'number' ? clamp01(signal.payload.freshness) : 0.35;
    const age = Math.max(0, now - signal.at);
    const ageFactor = clamp01(1 - age / Math.max(signal.throttleMs * 4, 15_000));
    const repetitionPenalty = Math.min(0.5, (memory?.hitCount ?? 0) * 0.07 + (memory?.lastFiredAt && now - memory.lastFiredAt < signal.throttleMs ? 0.18 : 0));
    const decay = memory?.decay ?? 1;
    const baseScore = clamp01(signal.priority * 0.55 + freshness * 0.2 + overlap * 0.2 + ageFactor * 0.05);
    const score = clamp01(baseScore * decay - repetitionPenalty);
    const suppressed = (memory?.suppressedUntil ?? 0) > now || score < 0.38;
    const cadenceScale = suppressed ? 4 : score > 0.78 ? 0.55 : score > 0.62 ? 0.85 : 1.2;
    const wakeAt = signal.wakeMode === 'immediate' ? now : now + Math.max(0, Math.round(signal.debounceMs * cadenceScale + signal.throttleMs * (1 - score) * 0.5));
    const reason = suppressed ? `suppressed low-relevance signal ${signal.key}` : signal.payload.reason ? String(signal.payload.reason) : signal.key;
    this.rememberWakePolicy(signal, score, wakeAt, suppressed);
    return { key, family, score, wakeAt, suppressed, reason };
  }

  private buildDiscoveryProfile(snapshot: ReturnType<typeof summarizeHarnessState>): { needs: DiscoveryNeed[]; githubLabels: string[]; triggerSeeds: string[] } {
    const forecasted = this.lastSearchPlan?.predictedSignals ?? [];
    const sourceRanking = this.lastSearchPlan?.sourceRanking ?? [];
    const activityText = joinDiscoveryText(
      this.objective,
      this.context.hint as string | undefined,
      this.lastSearchPlan?.intent.semanticQuery,
      this.lastLiveWeb?.query,
      ...forecasted.map((signal) => `${signal.source} ${signal.topic} ${signal.latentNeed.label}`),
      ...sourceRanking.map((entry) => `${entry.source} ${entry.reason}`),
      ...this.observations.slice(-6).map((observation) => `${observation.focus} ${observation.value}`),
      ...Object.entries(this.signalSummary()).map(([source, count]) => `${source} ${count}`),
      ...Array.from(this.wakePolicyMemory.values()).map((record) => `${record.family} ${record.score.toFixed(2)}`),
    );
    const families = [
      { label: 'relationship-recall', source: 'email' as AutopilotSignalSource, key: 'relationship', channel: 'email' as const, wakeMode: 'debounce' as const, base: 0.74, terms: ['relationship', 'contact', 'follow-up', 'reply', 'thread', 'people'] },
      { label: 'thread-watcher', source: 'email' as AutopilotSignalSource, key: 'thread', channel: 'email' as const, wakeMode: 'debounce' as const, base: 0.7, terms: ['thread', 'inbox', 'reply', 'message', 'conversation'] },
      { label: 'calendar-conflict-watch', source: 'calendar' as AutopilotSignalSource, key: 'calendar', channel: 'calendar' as const, wakeMode: 'debounce' as const, base: 0.68, terms: ['calendar', 'meeting', 'schedule', 'availability', 'conflict'] },
      { label: 'platform-event-watch', source: 'integration' as AutopilotSignalSource, key: 'github', channel: 'browser' as const, wakeMode: 'immediate' as const, base: 0.66, terms: ['github', 'issue', 'pull', 'repository', 'repo', 'watch'] },
      { label: 'live-web-refresh', source: 'browser' as AutopilotSignalSource, key: 'web', channel: 'browser' as const, wakeMode: 'debounce' as const, base: 0.6, terms: ['web', 'search', 'evidence', 'freshness', 'article', 'source'] },
      { label: 'signal-observer', source: 'system' as AutopilotSignalSource, key: 'signal', channel: 'in-app' as const, wakeMode: 'debounce' as const, base: 0.64, terms: ['signal', 'telemetry', 'monitor', 'anomaly', 'trend', 'refresh'] },
    ];
    const needs = families.map((family) => {
      const semantic = semanticDiscoveryScore(activityText, family.terms.join(' '));
      const sourceCount = asNumber(this.signalSummary()[family.source] ?? 0, 0);
      const memoryScore = Array.from(this.wakePolicyMemory.values()).filter((record) => record.source === family.source).reduce((best, record) => Math.max(best, record.score), 0);
      const score = clamp01(family.base * 0.45 + semantic * 0.35 + Math.min(1, sourceCount / 4) * 0.1 + memoryScore * 0.1);
      const cadenceMinutes = Math.max(10, Math.round(240 / Math.max(0.2, score)));
      return {
        label: family.label,
        source: family.source,
        key: family.key,
        reason: `${family.label} elevated by semantic discovery score ${score.toFixed(2)}`,
        score,
        cadenceMinutes,
        action: `recompute ${family.label.replace(/-/g, ' ')} from learned discovery evidence`,
        channel: family.channel,
        wakeMode: family.wakeMode,
      };
    }).sort((left, right) => right.score - left.score);
    const githubLabels = unique([
      ...forecasted.filter((signal) => signal.source === 'github').map((signal) => signal.topic),
      ...needs.filter((need) => need.source === 'integration' || need.source === 'github').map((need) => need.key),
    ].flatMap((value) => tokenizeDiscoveryText(value))).slice(0, 6);
    return { needs, githubLabels, triggerSeeds: unique(tokenizeDiscoveryText(activityText)).slice(0, 12) };
  }

  pause(reason = 'manual pause'): void {
    this.status = 'paused';
    this.lastWakeReason = reason;
    this.auditTrail.push(`pause:${reason}`);
  }

  resume(reason = 'manual resume'): void {
    this.status = 'running';
    this.lastResumeAt = this.clock();
    this.lastWakeReason = reason;
    this.auditTrail.push(`resume:${reason}`);
  }

  ingestSignal(signal: AutopilotSignal): AutopilotSignal {
    const policy = this.evaluateWakePolicy(signal);
    const storedSignal = { ...signal, priority: policy.score, wakeMode: policy.suppressed ? 'throttle' : signal.wakeMode };
    this.signals.push(storedSignal);
    this.auditTrail.push(`signal:${signal.source}:${signal.key}`);
    this.auditTrail.push(`signal-policy:${policy.family}:${policy.score.toFixed(2)}:${policy.suppressed ? 'suppressed' : 'scheduled'}`);
    if (policy.suppressed) return storedSignal;
    this.scheduler.schedule({
      id: `${signal.id}-wake`,
      key: signalKey(signal),
      source: signal.source,
      reason: policy.reason,
      mode: signal.wakeMode,
      wakeAt: policy.wakeAt,
      payload: { ...signal.payload, policyScore: policy.score, policyFamily: policy.family },
      debounceMs: signal.debounceMs,
      throttleMs: signal.throttleMs,
      onWake: (wake) => this.onWake(wake),
    });
    return storedSignal;
  }

  private onWake(wake: AutopilotWake): void {
    this.status = 'running';
    this.lastResumeAt = this.clock();
    this.lastWakeReason = wake.reason;
    const existing = this.wakePolicyMemory.get(wake.key);
    if (existing) {
      const now = this.clock();
      this.wakePolicyMemory.set(wake.key, {
        ...existing,
        lastFiredAt: now,
        suppressedUntil: Math.max(existing.suppressedUntil, now + Math.max(wake.throttleMs, wake.debounceMs)),
        decay: clamp01(existing.decay * 0.92),
        score: clamp01(Math.max(existing.score, 0.65)),
        lastReason: wake.reason,
        lastTags: tokenizeDiscoveryText(JSON.stringify(wake.payload)).slice(0, 4),
      });
    }
    this.auditTrail.push(`wake:${wake.source}:${wake.key}:${wake.mode}`);
  }

  private maybeAutoResume(): void {
    if (this.status === 'paused' && this.scheduler.snapshot().pendingCount > 0) this.resume('auto-resume from pending wake');
    if (this.status === 'idle' && this.signals.length > 0) this.resume('auto-resume from live signal');
  }

  private signalSummary(): Record<string, number> {
    return this.signals.reduce<Record<string, number>>((acc, signal) => {
      acc[signal.source] = (acc[signal.source] ?? 0) + 1;
      return acc;
    }, {});
  }

  private buildLiveState(loopReason: string): AutopilotLiveState {
    const scheduler = this.scheduler.snapshot();
    return {
      mode: 'event-driven',
      status: this.status,
      loopCount: this.loopCount,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      lastResumeAt: this.lastResumeAt ? new Date(this.lastResumeAt).toISOString() : null,
      lastWakeReason: this.lastWakeReason,
      pendingSignals: scheduler.pendingCount,
      pendingSubscriptions: this.subscriptions.filter((subscription) => subscription.enabled).length,
      observationCount: this.observations.length,
      nextWakeAt: scheduler.nextWakeAt ? new Date(scheduler.nextWakeAt).toISOString() : null,
      debounceWindowMs: Math.max(...this.signals.map((signal) => signal.debounceMs), 0),
      throttleWindowMs: Math.max(...this.signals.map((signal) => signal.throttleMs), 0),
      liveWebResults: this.lastLiveWeb?.results.length ?? 0,
      liveWebFreshness: this.lastLiveWeb?.freshnessScore ?? 0,
      externalEvents: this.lastPlatformSignals?.events.length ?? 0,
      daemonRunning: this.liveDaemonStarted,
      lastExternalPollAt: this.lastLiveWeb?.searchedAt ? new Date(this.lastLiveWeb.searchedAt).toISOString() : null,
    };
  }

  private buildBackgroundTriggers(snapshot: ReturnType<typeof summarizeHarnessState>): AutopilotTrigger[] {
    const profile = this.buildDiscoveryProfile(snapshot);
    const triggers: AutopilotTrigger[] = [];
    for (const need of profile.needs.slice(0, 6)) {
      triggers.push(buildTrigger(need.label, need.reason, need.cadenceMinutes, need.action, need.source, need.key, need.wakeMode));
    }
    if (this.status === 'paused' && this.scheduler.snapshot().pendingCount > 0) {
      triggers.push(buildTrigger('auto-resume', 'wake-policy memory still has pending work and the loop is paused', 5, 'resume the loop after the next learned wake opportunity', 'system', 'resume', 'immediate'));
    }
    const recentFired = Array.from(this.wakePolicyMemory.values()).filter((record) => record.lastFiredAt !== null).sort((left, right) => (right.score - left.score) || ((right.lastFiredAt ?? 0) - (left.lastFiredAt ?? 0)));
    for (const record of recentFired.slice(0, 2)) {
      triggers.push(buildTrigger(`policy-reinforce-${record.family}`, `reinforce wake policy for ${record.family} with score ${record.score.toFixed(2)}`, Math.max(15, Math.round(180 / Math.max(0.2, record.score))), `re-evaluate ${record.family} with learned wake-policy memory`, record.source, record.key, record.score > 0.72 ? 'immediate' : 'debounce'));
    }
    return triggers.filter((trigger, index, list) => list.findIndex((entry) => entry.name === trigger.name && entry.key === trigger.key && entry.source === trigger.source) === index);
  }
  private buildCheckIns(snapshot: ReturnType<typeof summarizeHarnessState>): AutopilotCheckIn[] {
    const profile = this.buildDiscoveryProfile(snapshot);
    const checkIns: AutopilotCheckIn[] = [];
    for (const need of profile.needs.slice(0, 6)) {
      checkIns.push(buildCheckIn(need.label, Math.max(10, Math.round(need.cadenceMinutes / 2)), need.channel, need.reason, need.source));
    }
    if ((this.lastLiveWeb?.results.length ?? 0) > 0) {
      checkIns.push(buildCheckIn('live-web-review', 30, 'browser', 'review the latest verified web evidence and refresh the learned discovery model', 'browser'));
    }
    if (this.lastPlatformSignals?.events.length ?? 0 > 0) {
      checkIns.push(buildCheckIn('platform-event-review', 20, 'browser', 'review verified platform events and keep wake-policy memory calibrated', 'integration'));
    }
    if (this.status === 'paused') {
      checkIns.push(buildCheckIn('resume-observation', 5, 'in-app', 'wait for the next high-confidence wake opportunity before resuming', 'system'));
    }
    if (checkIns.length === 0) {
      checkIns.push(buildCheckIn('semantic-baseline-review', 60, 'in-app', 're-evaluate the current learned discovery profile and keep the loop ready', 'system'));
    }
    return checkIns.slice(0, 6);
  }
  private derivePriorities(snapshot: ReturnType<typeof summarizeHarnessState>, liveState: AutopilotLiveState): string[] {
    const priorities = [
      ...(this.lastSearchPlan?.predictedSignals ?? []).slice(0, 4).map((signal) => `protect semantic forecast: ${signal.topic}`),
      liveState.pendingSignals > 0 ? 'flush queued wakes without duplication' : '',
      liveState.status === 'paused' ? 'auto-resume on the next wake' : '',
    ];
    return unique(priorities);
  }

  private buildNextLoopHint(liveState: AutopilotLiveState, context: Record<string, unknown>): string {
    if (typeof context.hint === 'string' && context.hint.trim()) return context.hint.trim();
    if (liveState.nextWakeAt) return `wake again at ${liveState.nextWakeAt} after the scheduler flushes`;
    if (liveState.forecastedSignals > 0 && liveState.searchStrategy) return `use ${liveState.searchStrategy} and refresh the next ${liveState.forecastedSignals} live signal forecast(s)`;
    return 're-run on the next live signal and keep the event queue compact';
  }

  private snapshot(loopReason: string): AutopilotCycle {
    const snapshot = summarizeHarnessState(this.harnessState);
    const scheduler = this.scheduler.snapshot();
    const liveState = this.buildLiveState(loopReason);
    return {
      objective: this.objective,
      mode: 'event-driven',
      harnessSnapshot: snapshot,
      backgroundTriggers: this.buildBackgroundTriggers(snapshot),
      scheduledCheckIns: this.buildCheckIns(snapshot),
      priorities: this.derivePriorities(snapshot, liveState),
      nextLoopHint: this.buildNextLoopHint(liveState, this.context),
      liveState,
      liveWeb: this.lastLiveWeb,
      platformSignals: this.lastPlatformSignals,
      daemon: this.liveDaemon.snapshot(),
      subscriptions: [...this.subscriptions].filter((subscription) => subscription.enabled),
      observations: [...this.observations].slice(-8),
      scheduler,
      signalSummary: this.signalSummary(),
      auditTrail: [...this.auditTrail].slice(-12),
      loopReason,
    };
  }

  async tick(loopReason = 'tick'): Promise<AutopilotCycle> {
    this.loopCount += 1;
    this.lastTickAt = this.clock();
    if (this.liveDaemonStarted) await this.pollLiveSources();
    this.maybeAutoResume();
    this.scheduler.flushDue(this.clock());
    return this.snapshot(loopReason);
  }
}

export async function buildAutopilotCycle(objective: string, harnessState: Record<string, unknown> = {}, context: Record<string, unknown> = {}): Promise<AutopilotCycle> {
  const engine = new AutopilotEngine(objective, harnessState, context);
  return await engine.tick('bootstrap');
}

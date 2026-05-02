import { randomUUID } from 'node:crypto';
import { createObservation, createSignal, createSubscription, signalKey, type AutopilotObservation, type AutopilotSignal, type AutopilotSignalSource, type AutopilotSubscription, type AutopilotWake } from './events';
import { AutopilotSchedulerWorker, type SchedulerSnapshot } from './scheduler';
import { AutopilotLiveDaemon, type GithubWatch, type LiveDaemonSnapshot, type LiveWebSignalBundle, type PlatformSignalBundle } from './live-signals';
import { DEFAULT_SEMANTIC_NLU_PROVIDER } from '../search/index.ts';
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
  private readonly subscriptions: AutopilotSubscription[] = [];
  private readonly observations: AutopilotObservation[] = [];
  private readonly signals: AutopilotSignal[] = [];
  private readonly auditTrail: string[] = [];
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
      nluProvider: DEFAULT_SEMANTIC_NLU_PROVIDER,
    }, asNumber(this.context.daemonIntervalMs, 15_000));
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
    const watches = configured
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        owner: normalizeText(item.owner) || 'microsoft',
        repo: normalizeText(item.repo) || 'TypeScript',
        labels: asArray(item.labels).map(normalizeText).filter(Boolean),
        since: typeof item.since === 'string' ? item.since : undefined,
        state: normalizeText(item.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : normalizeText(item.state).toUpperCase() === 'ALL' ? 'ALL' : 'OPEN',
        perPage: asNumber(item.perPage, 5),
      })) as GithubWatch[];
    if (watches.length > 0) return watches;
    return [{ owner: 'microsoft', repo: 'TypeScript', state: 'OPEN', perPage: 3 }];
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
    let seeded = false;
    if (Array.isArray(this.context.signals)) {
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
          seeded = true;
        }
      }
    }
    if (!seeded) {
      const signal = semanticSignalSeed(this.objective, this.harnessState, this.context);
      this.signals.push(signal);
      this.auditTrail.push('signal:' + signal.source + ':' + signal.key);
    }
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
    this.signals.push(signal);
    this.auditTrail.push(`signal:${signal.source}:${signal.key}`);
    const wakeAt = signal.wakeMode === 'immediate' ? this.clock() : this.clock() + (signal.wakeMode === 'throttle' ? signal.throttleMs : signal.debounceMs);
    this.scheduler.schedule({
      id: `${signal.id}-wake`,
      key: signalKey(signal),
      source: signal.source,
      reason: signal.payload.reason ? String(signal.payload.reason) : signal.key,
      mode: signal.wakeMode,
      wakeAt,
      payload: signal.payload,
      debounceMs: signal.debounceMs,
      throttleMs: signal.throttleMs,
      onWake: (wake) => this.onWake(wake),
    });
    return signal;
  }

  private onWake(wake: AutopilotWake): void {
    this.status = 'running';
    this.lastResumeAt = this.clock();
    this.lastWakeReason = wake.reason;
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
    const triggers: AutopilotTrigger[] = [];
    const schedulerSnapshot = this.scheduler.snapshot();
    const forecasted = this.lastSearchPlan?.predictedSignals ?? [];

    for (const [index, signal] of forecasted.slice(0, 5).entries()) {
      triggers.push(buildTrigger(
        `${signal.topic}-forecast`,
        `semantic forecast ${index + 1} from ${signal.source} with posterior ${signal.confidence.toFixed(2)}`,
        Math.max(15, Math.round(360 / Math.max(0.25, Number(signal.priority) || 0.25))),
        `act on the forecasted need ${signal.topic} and preserve the evidence path`,
        signal.source as AutopilotSignalSource,
        signal.topic,
        signal.confidence > 0.7 ? 'immediate' : 'debounce',
      ));
    }

    if (forecasted.length === 0) {
      triggers.push(buildTrigger('semantic-forecast-refresh', 'no semantic forecast was available from the latest model pass', 45, 'refresh the semantic model and recompute future need distribution', 'system', 'forecast', 'debounce'));
    }

    if ((this.lastLiveWeb?.results.length ?? 0) > 0) {
      triggers.push(buildTrigger('live-web-refresh', 'fresh live web results should be rechecked before they age out', 30, 'refresh live web search results and crawl the freshest pages', 'browser', 'live-web', 'debounce'));
    }

    if ((this.lastPlatformSignals?.events.length ?? 0) > 0) {
      triggers.push(buildTrigger('platform-event-watch', 'external platform events were ingested and should keep waking the loop', 20, 'poll external platforms for new issue and pull-request events', 'integration', 'platform', 'debounce'));
    }

    if (this.status === 'paused' && schedulerSnapshot.pendingCount > 0) {
      triggers.push(buildTrigger('auto-resume', 'pending wake requests exist while the loop is paused', 5, 'resume the loop immediately after the next wake arrives', 'system', 'resume', 'immediate'));
    }

    if (schedulerSnapshot.pendingCount > 0) {
      triggers.push(buildTrigger('scheduler-pulse', 'the scheduler already has pending wakeups', 1, 'flush due wakeups and continue the autonomy loop', 'system', 'scheduler', 'immediate'));
    }

    return triggers.slice(0, 6);
  }

  private buildCheckIns(snapshot: ReturnType<typeof summarizeHarnessState>): AutopilotCheckIn[] {
    const checkIns: AutopilotCheckIn[] = [];
    const forecasted = this.lastSearchPlan?.predictedSignals ?? [];

    for (const signal of forecasted.slice(0, 5)) {
      const channel: AutopilotCheckIn['channel'] = signal.source === 'calendar' ? 'calendar' : signal.source === 'email' ? 'email' : signal.source === 'browser' ? 'browser' : 'in-app';
      checkIns.push(buildCheckIn(
        `${signal.topic}-check-in`,
        Math.max(10, Math.round(180 / Math.max(0.25, Number(signal.priority) || 0.25))),
        channel,
        `revisit the semantic forecast for ${signal.topic} and validate the next information need`,
        signal.source as AutopilotSignalSource,
      ));
    }

    if ((this.lastLiveWeb?.results.length ?? 0) > 0) checkIns.push(buildCheckIn('live-web-review', 30, 'browser', 'review the latest web evidence and keep freshness-aware results current', 'browser'));
    if ((this.lastPlatformSignals?.events.length ?? 0) > 0) checkIns.push(buildCheckIn('platform-event-review', 20, 'browser', 'revisit external platform changes and continue the wake cycle', 'integration'));
    if (this.status === 'paused') checkIns.push(buildCheckIn('resume-observation', 5, 'in-app', 'wake the loop when the next pending signal clears', 'system'));
    if (checkIns.length === 0) checkIns.push(buildCheckIn('semantic-baseline-review', 60, 'in-app', 'review the current semantic forecast and keep the loop ready', 'system'));
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

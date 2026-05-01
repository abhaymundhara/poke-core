import { randomUUID } from 'node:crypto';
import { createObservation, createSignal, createSubscription, signalKey, type AutopilotObservation, type AutopilotSignal, type AutopilotSignalSource, type AutopilotSubscription, type AutopilotWake } from './events';
import { AutopilotSchedulerWorker, type SchedulerSnapshot } from './scheduler';

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
  const relationships = asArray(harnessState.relationships);
  const threads = asArray(harnessState.threads);
  const calendar = asArray(harnessState.calendar);
  const signals = asArray(harnessState.signals);
  const staleTransactional = asNumber(harnessState.staleTransactional, asNumber(harnessState.stale, 0));
  const relationshipWeight = Math.min(1, asNumber(harnessState.relationshipWeight, 0.35) + relationships.length * 0.08);
  const openThreads = Math.max(threads.length, asNumber(harnessState.openThreads, 0));
  const calendarConflicts = Math.max(asNumber(harnessState.calendarConflicts, 0), calendar.filter((entry) => typeof entry === 'object' && entry !== null && 'conflict' in (entry as Record<string, unknown>)).length);
  const signalIntensity = Math.min(1, signals.length * 0.12 + asNumber(harnessState.signalIntensity, 0.2));
  return { relationshipWeight, openThreads, calendarConflicts, staleTransactional, signalIntensity };
}

function buildTrigger(name: string, reason: string, cadenceMinutes: number, action: string, source?: AutopilotSignalSource, key?: string, wakeMode?: AutopilotSignal['wakeMode']): AutopilotTrigger {
  return {
    id: `${name}-${cadenceMinutes}`,
    name,
    reason,
    cadenceMinutes,
    nextRunAt: new Date(Date.now() + cadenceMinutes * 60_000).toISOString(),
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

function inferSources(objective: string, harnessState: Record<string, unknown>, context: Record<string, unknown>): AutopilotSignalSource[] {
  const haystack = `${objective} ${JSON.stringify(harnessState)} ${JSON.stringify(context)}`.toLowerCase();
  const sources: AutopilotSignalSource[] = [];
  if (/(email|inbox|thread|reply|forward|mail|gmail|outlook)/.test(haystack)) sources.push('email');
  if (/(calendar|meeting|schedule|reschedule|availability|timezone|event)/.test(haystack)) sources.push('calendar');
  if (/(browser|web|site|page|url|navigate|click|extract|screenshot|dom)/.test(haystack)) sources.push('browser');
  if (/(file|filesystem|folder|directory|path|write|read|diff|export|scan)/.test(haystack)) sources.push('filesystem');
  if (/(github|notion|linear|todoist|vercel|slack|integration|repo|issue)/.test(haystack)) sources.push('integration');
  if (/(preference|profile|tone|style|memory|model|grounding)/.test(haystack)) sources.push('memory');
  return unique(sources.length > 0 ? sources : ['system']);
}

function defaultSubscriptions(objective: string, harnessState: Record<string, unknown>, context: Record<string, unknown>): AutopilotSubscription[] {
  const snapshot = summarizeHarnessState(harnessState);
  const haystack = `${objective} ${JSON.stringify(harnessState)} ${JSON.stringify(context)}`.toLowerCase();
  const subs: AutopilotSubscription[] = [];
  if (snapshot.relationshipWeight >= 0.4 || /(relationship|follow up|reply|contact|thread)/.test(haystack)) {
    subs.push(createSubscription({ source: 'email', topic: 'relationship-watch', match: ['thread', 'reply', 'follow up', 'contact'], debounceMs: 300, throttleMs: 1_500 }));
  }
  if (snapshot.openThreads > 0 || /(inbox|thread|email|message)/.test(haystack)) {
    subs.push(createSubscription({ source: 'email', topic: 'thread-watch', match: ['inbox', 'thread', 'reply'], debounceMs: 250, throttleMs: 1_200 }));
  }
  if (snapshot.calendarConflicts > 0 || /(calendar|meeting|schedule|availability|timezone)/.test(haystack)) {
    subs.push(createSubscription({ source: 'calendar', topic: 'schedule-watch', match: ['meeting', 'schedule', 'conflict', 'availability'], debounceMs: 200, throttleMs: 900 }));
  }
  if (snapshot.staleTransactional > 0 || /(invoice|receipt|booking|payment|confirmation|deadline)/.test(haystack)) {
    subs.push(createSubscription({ source: 'email', topic: 'transactional-watch', match: ['invoice', 'receipt', 'booking', 'payment', 'confirmation'], debounceMs: 500, throttleMs: 2_000 }));
  }
  if (snapshot.signalIntensity > 0.25 || /(signal|telemetry|trend|monitor|observe|heartbeat)/.test(haystack)) {
    subs.push(createSubscription({ source: 'system', topic: 'signal-watch', match: ['signal', 'telemetry', 'trend', 'heartbeat'], debounceMs: 150, throttleMs: 600 }));
  }
  return subs.length > 0 ? subs : [createSubscription({ source: 'system', topic: 'idle-watch', match: ['idle', 'resume'], debounceMs: 250, throttleMs: 1_000 })];
}

function signalFromObjective(source: AutopilotSignalSource, objective: string, harnessState: Record<string, unknown>, context: Record<string, unknown>): AutopilotSignal {
  const lower = `${objective} ${JSON.stringify(harnessState)} ${JSON.stringify(context)}`.toLowerCase();
  const tags: string[] = [];
  if (/(relationship|contact|follow up|reply)/.test(lower)) tags.push('relationship');
  if (/(thread|inbox|email|message)/.test(lower)) tags.push('thread');
  if (/(calendar|meeting|schedule|availability|timezone)/.test(lower)) tags.push('calendar');
  if (/(signal|telemetry|trend|monitor|observe)/.test(lower)) tags.push('signal');
  if (/(browser|web|page|click|extract)/.test(lower)) tags.push('browser');
  if (/(file|filesystem|path|folder|diff|scan)/.test(lower)) tags.push('filesystem');
  return createSignal({
    source,
    key: tags[0] ?? source,
    reason: normalizeText(context.reason) || objective,
    payload: { objective, harnessState, context },
    priority: /(urgent|asap|today|tomorrow|soon)/.test(lower) ? 0.9 : 0.7,
    debounceMs: /(signal|trend|monitor|observe|thread|calendar)/.test(lower) ? 220 : 120,
    throttleMs: /(relationship|thread|calendar|email)/.test(lower) ? 1_200 : 900,
    wakeMode: /(signal|thread|calendar|calendar conflict|inbox)/.test(lower) ? 'debounce' : 'immediate',
    tags: tags.length > 0 ? tags : ['bootstrap'],
  });
}

export class AutopilotEngine {
  private readonly scheduler: AutopilotSchedulerWorker;
  private readonly subscriptions: AutopilotSubscription[] = [];
  private readonly observations: AutopilotObservation[] = [];
  private readonly signals: AutopilotSignal[] = [];
  private readonly auditTrail: string[] = [];
  private status: 'idle' | 'running' | 'paused' = 'idle';
  private loopCount = 0;
  private lastTickAt: number | null = null;
  private lastResumeAt: number | null = null;
  private lastWakeReason: string | null = null;

  constructor(
    private readonly objective: string,
    private readonly harnessState: Record<string, unknown> = {},
    private readonly context: Record<string, unknown> = {},
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.scheduler = new AutopilotSchedulerWorker(this.clock);
    this.seed();
  }

  private seed(): void {
    for (const subscription of defaultSubscriptions(this.objective, this.harnessState, this.context)) this.subscriptions.push(subscription);
    this.seedContextSubscriptions();
    this.seedObservations();
    this.seedSignals();
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

  private seedObservations(): void {
    const snapshot = summarizeHarnessState(this.harnessState);
    this.observe('system', 'relationship-weight', snapshot.relationshipWeight.toFixed(2), snapshot.relationshipWeight, 30_000, ['harness', 'relationship']);
    this.observe('system', 'open-threads', String(snapshot.openThreads), Math.min(1, snapshot.openThreads / 10), 30_000, ['harness', 'thread']);
    this.observe('system', 'calendar-conflicts', String(snapshot.calendarConflicts), Math.min(1, snapshot.calendarConflicts / 5), 30_000, ['harness', 'calendar']);
    this.observe('system', 'stale-transactional', String(snapshot.staleTransactional), Math.min(1, snapshot.staleTransactional / 10), 30_000, ['harness', 'transactional']);
    this.observe('system', 'signal-intensity', snapshot.signalIntensity.toFixed(2), snapshot.signalIntensity, 30_000, ['harness', 'signal']);
    if (Array.isArray(this.context.observations)) {
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
  }

  private seedSignals(): void {
    const sources = inferSources(this.objective, this.harnessState, this.context);
    for (const source of sources) {
      this.ingestSignal(signalFromObjective(source, this.objective, this.harnessState, this.context));
    }
    if (Array.isArray(this.context.signals)) {
      for (const item of this.context.signals) {
        if (typeof item === 'object' && item !== null) {
          const record = item as Record<string, unknown>;
          const source = (normalizeText(record.source) as AutopilotSignalSource) || 'system';
          this.ingestSignal({
            ...signalFromObjective(source, this.objective, this.harnessState, this.context),
            id: `${normalizeText(record.id) || randomUUID()}-${this.clock()}`,
            source,
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
          });
        }
      }
    }
  }

  observe(source: AutopilotSignalSource, focus: string, value: string, confidence = 0.7, freshnessMs = 60_000, tags: string[] = []): AutopilotObservation {
    const observation = createObservation({ source, focus, value, confidence, freshnessMs, tags });
    this.observations.push(observation);
    this.auditTrail.push(`observation:${source}:${focus}`);
    return observation;
  }

  subscribe(subscription: AutopilotSubscription): AutopilotSubscription {
    this.subscriptions.push(subscription);
    this.auditTrail.push(`subscription:${subscription.source}:${subscription.topic}`);
    return subscription;
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
    };
  }

  private buildBackgroundTriggers(snapshot: ReturnType<typeof summarizeHarnessState>): AutopilotTrigger[] {
    const triggers: AutopilotTrigger[] = [];
    const hasEmailSubscription = this.subscriptions.some((subscription) => subscription.source === 'email' && subscription.enabled);
    const hasCalendarSubscription = this.subscriptions.some((subscription) => subscription.source === 'calendar' && subscription.enabled);
    const hasBrowserSubscription = this.subscriptions.some((subscription) => subscription.source === 'browser' && subscription.enabled);
    const schedulerSnapshot = this.scheduler.snapshot();

    if (snapshot.relationshipWeight >= 0.55 || hasEmailSubscription || /relationship|contact|follow up|reply/i.test(this.objective)) {
      triggers.push(buildTrigger('relationship-recall', 'relationship context is active and should not rot', 1_440, 'recall relationships and compact stale thread noise', 'email', 'relationship', 'debounce'));
    }

    if (snapshot.openThreads > 0 || hasEmailSubscription || /thread|inbox|reply|email|message/i.test(this.objective)) {
      triggers.push(buildTrigger('thread-watcher', 'open threads need a follow-up cycle', 360, 'compact the current thread and identify the next reply', 'email', 'thread', 'debounce'));
    }

    if (snapshot.calendarConflicts > 0 || hasCalendarSubscription || /calendar|meeting|schedule|conflict|availability/i.test(this.objective)) {
      triggers.push(buildTrigger('calendar-conflict-watch', 'calendar state has unresolved overlap or scheduling risk', 180, 'run conflict detection and propose a reschedule', 'calendar', 'calendar', 'debounce'));
    }

    if (snapshot.staleTransactional > 0 || /invoice|receipt|booking|payment|confirmation|deadline/i.test(this.objective)) {
      triggers.push(buildTrigger('transactional-compaction', 'transactional records should not crowd the harness', 720, 'compact stale transactional data and preserve durable thread history', 'email', 'transactional', 'throttle'));
    }

    if (snapshot.signalIntensity > 0.35 || this.signals.length > 3 || hasBrowserSubscription || /signal|telemetry|monitor|anomaly|trend/i.test(this.objective)) {
      triggers.push(buildTrigger('signal-observer', 'signal intensity suggests the loop should re-run without a user nudge', 90, 'observe signals, summarize drift, and refresh the working set', 'system', 'signal', 'debounce'));
    }

    if (this.status === 'paused' && schedulerSnapshot.pendingCount > 0) {
      triggers.push(buildTrigger('auto-resume', 'pending wake requests exist while the loop is paused', 5, 'resume the loop immediately after the next wake arrives', 'system', 'resume', 'immediate'));
    }

    if (triggers.length === 0) {
      triggers.push(buildTrigger('idle-watch', 'keep the loop ready for the next live signal', 60, 'wait for background sensing or a new wake signal', 'system', 'idle', 'debounce'));
    }

    if (schedulerSnapshot.pendingCount > 0) {
      triggers.push(buildTrigger('scheduler-pulse', 'the scheduler already has pending wakeups', 1, 'flush due wakeups and continue the autonomy loop', 'system', 'scheduler', 'immediate'));
    }

    return triggers.slice(0, 6);
  }

  private buildCheckIns(snapshot: ReturnType<typeof summarizeHarnessState>): AutopilotCheckIn[] {
    const checkIns: AutopilotCheckIn[] = [];
    if (snapshot.relationshipWeight >= 0.55) checkIns.push(buildCheckIn('relationship-check-in', 1_440, 'email', 'revisit the relevant thread with relationship-weighted recall', 'email'));
    if (snapshot.openThreads > 0) checkIns.push(buildCheckIn('thread-follow-up', 360, 'email', 'check whether the open thread needs a reply or compaction', 'email'));
    if (snapshot.calendarConflicts > 0) checkIns.push(buildCheckIn('calendar-review', 180, 'calendar', 're-check the schedule and confirm conflict-free windows', 'calendar'));
    if (snapshot.staleTransactional > 0) checkIns.push(buildCheckIn('transactional-cleanup', 720, 'browser', 'review whether transactional artifacts are still worth keeping', 'browser'));
    if (snapshot.signalIntensity > 0.35 || this.signals.length > 3) checkIns.push(buildCheckIn('signal-observation', 90, 'browser', 're-scan the latest signals and capture trend drift', 'browser'));
    if (this.status === 'paused') checkIns.push(buildCheckIn('resume-observation', 5, 'in-app', 'wake the loop when the next pending signal clears', 'system'));
    return checkIns.slice(0, 6);
  }

  private derivePriorities(snapshot: ReturnType<typeof summarizeHarnessState>, liveState: AutopilotLiveState): string[] {
    const priorities = [
      snapshot.relationshipWeight >= 0.55 ? 'preserve relationship context' : '',
      snapshot.openThreads > 0 ? 'keep active threads warm' : '',
      snapshot.calendarConflicts > 0 ? 'resolve scheduling friction' : '',
      snapshot.staleTransactional > 0 ? 'trim stale transactional noise' : '',
      snapshot.signalIntensity > 0.35 || this.signals.length > 3 ? 'watch the signal surface' : '',
      liveState.status === 'paused' ? 'auto-resume on the next wake' : '',
      liveState.pendingSignals > 0 ? 'flush queued wakes without duplication' : '',
    ];
    return unique(priorities);
  }

  private buildNextLoopHint(liveState: AutopilotLiveState, context: Record<string, unknown>): string {
    if (typeof context.hint === 'string' && context.hint.trim()) return context.hint.trim();
    if (liveState.nextWakeAt) return `wake again at ${liveState.nextWakeAt} after the scheduler flushes`;
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
      subscriptions: [...this.subscriptions].filter((subscription) => subscription.enabled),
      observations: [...this.observations].slice(-8),
      scheduler,
      signalSummary: this.signalSummary(),
      auditTrail: [...this.auditTrail].slice(-12),
      loopReason,
    };
  }

  tick(loopReason = 'tick'): AutopilotCycle {
    this.loopCount += 1;
    this.lastTickAt = this.clock();
    this.maybeAutoResume();
    this.scheduler.flushDue(this.clock());
    return this.snapshot(loopReason);
  }
}

export function buildAutopilotCycle(objective: string, harnessState: Record<string, unknown> = {}, context: Record<string, unknown> = {}): AutopilotCycle {
  const engine = new AutopilotEngine(objective, harnessState, context);
  return engine.tick('bootstrap');
}

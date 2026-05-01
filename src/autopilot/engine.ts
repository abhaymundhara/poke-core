export type AutopilotTrigger = {
  id: string;
  name: string;
  reason: string;
  cadenceMinutes: number;
  nextRunAt: string;
  action: string;
};

export type AutopilotCheckIn = {
  id: string;
  label: string;
  when: string;
  channel: 'in-app' | 'email' | 'calendar' | 'browser';
  focus: string;
};

export type AutopilotCycle = {
  objective: string;
  mode: 'proactivity';
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
};

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function buildTrigger(name: string, reason: string, cadenceMinutes: number, action: string): AutopilotTrigger {
  return {
    id: `${name}-${cadenceMinutes}`,
    name,
    reason,
    cadenceMinutes,
    nextRunAt: new Date(Date.now() + cadenceMinutes * 60_000).toISOString(),
    action,
  };
}

function buildCheckIn(label: string, minutes: number, channel: AutopilotCheckIn['channel'], focus: string): AutopilotCheckIn {
  return {
    id: `${label}-${minutes}`,
    label,
    when: new Date(Date.now() + minutes * 60_000).toISOString(),
    channel,
    focus,
  };
}

export function buildAutopilotCycle(objective: string, harnessState: Record<string, unknown> = {}, context: Record<string, unknown> = {}): AutopilotCycle {
  const snapshot = summarizeHarnessState(harnessState);
  const priorities: string[] = [];
  const backgroundTriggers: AutopilotTrigger[] = [];
  const scheduledCheckIns: AutopilotCheckIn[] = [];

  if (snapshot.relationshipWeight >= 0.55 || /relationship|contact|follow up|reply/i.test(objective)) {
    priorities.push('preserve relationship context');
    backgroundTriggers.push(buildTrigger('relationship-recall', 'relationship context is active and should not rot', 1440, 'recall relationships and compact stale thread noise'));
    scheduledCheckIns.push(buildCheckIn('relationship-check-in', 1440, 'email', 'revisit the relevant thread with relationship-weighted recall'));
  }

  if (snapshot.openThreads > 0 || /thread|inbox|reply|email|message/i.test(objective)) {
    priorities.push('keep active threads warm');
    backgroundTriggers.push(buildTrigger('thread-watcher', 'there is live thread state that needs a follow-up cycle', 360, 'compact the current thread and identify the next reply'));
    scheduledCheckIns.push(buildCheckIn('thread-follow-up', 360, 'email', 'check whether the open thread needs a reply or compaction'));
  }

  if (snapshot.calendarConflicts > 0 || /calendar|meeting|schedule|conflict|availability/i.test(objective)) {
    priorities.push('resolve scheduling friction');
    backgroundTriggers.push(buildTrigger('calendar-conflict-watch', 'calendar state has unresolved overlap or scheduling risk', 180, 'run conflict detection and propose a reschedule'));
    scheduledCheckIns.push(buildCheckIn('calendar-review', 180, 'calendar', 're-check the schedule and confirm conflict-free windows'));
  }

  if (snapshot.staleTransactional > 0 || /invoice|receipt|booking|payment|confirmation|deadline/i.test(objective)) {
    priorities.push('trim stale transactional noise');
    backgroundTriggers.push(buildTrigger('transactional-compaction', 'transactional records are aging out and should not crowd the harness', 720, 'compact stale transactional data and preserve the durable thread history'));
    scheduledCheckIns.push(buildCheckIn('transactional-cleanup', 720, 'browser', 'review whether transactional artifacts are still worth keeping'));
  }

  if (snapshot.signalIntensity > 0.35 || /signal|telemetry|monitor|anomaly|trend/i.test(objective)) {
    priorities.push('watch the signal surface');
    backgroundTriggers.push(buildTrigger('signal-observer', 'signal intensity suggests the cycle should re-run without a user nudge', 90, 'observe signals, summarize trend drift, and refresh the working set'));
    scheduledCheckIns.push(buildCheckIn('signal-observation', 90, 'browser', 're-scan the latest signals and capture trend drift'));
  }

  if (priorities.length === 0) priorities.push('stay ready and keep the harness compact');
  const nextLoopHint = context.hint ? String(context.hint) : 're-run the loop after the next harness refresh and keep background triggers explicit';

  return {
    objective,
    mode: 'proactivity',
    harnessSnapshot: snapshot,
    backgroundTriggers,
    scheduledCheckIns,
    priorities,
    nextLoopHint,
  };
}

import { AutopilotEngine, buildAutopilotCycle } from './engine';
import { createSignal } from './events';

export type AutopilotBenchmarkCaseResult = {
  name: string;
  score: number;
  passed: boolean;
  metrics: Record<string, number | boolean | string>;
  notes: string[];
};

export type AutopilotBenchmarkSummary = {
  averageScore: number;
  minScore: number;
  maxScore: number;
  passRate: number;
  verdict: 'pass' | 'needs-work';
};

export type AutopilotAudit = {
  standards: Record<string, number>;
  results: AutopilotBenchmarkCaseResult[];
  summary: AutopilotBenchmarkSummary;
  passed: boolean;
  gaps: string[];
};

function createClock(start = 1_717_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

function scoreRatio(passed: boolean, weight = 1): number {
  return passed ? weight : 0;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function runWakeOnSignalCase(): AutopilotBenchmarkCaseResult {
  const clock = createClock();
  const engine = new AutopilotEngine('keep me awake on live thread and calendar signals', { relationshipWeight: 0.68, openThreads: 2, calendarConflicts: 1 }, {}, clock.now);
  engine.ingestSignal(createSignal({ source: 'email', key: 'reply', reason: 'new reply arrived', wakeMode: 'immediate', tags: ['thread', 'relationship'] }));
  clock.advance(1);
  const snapshot = engine.tick('wake-on-signal');
  const wakeTriggered = snapshot.liveState.status === 'running' && snapshot.liveState.lastWakeReason !== null;
  const selfTrigger = snapshot.backgroundTriggers.some((trigger) => trigger.name === 'thread-watcher' || trigger.name === 'relationship-recall');
  const score = average([
    scoreRatio(wakeTriggered, 0.45),
    scoreRatio(snapshot.scheduler.pendingCount === 0, 0.2),
    scoreRatio(selfTrigger, 0.35),
  ]);
  return {
    name: 'wake-on-signal',
    score,
    passed: score >= 0.9,
    metrics: {
      wakeTriggered,
      pendingCount: snapshot.scheduler.pendingCount,
      selfTrigger,
      status: snapshot.liveState.status,
    },
    notes: snapshot.auditTrail,
  };
}

function runDebounceCollapseCase(): AutopilotBenchmarkCaseResult {
  const clock = createClock();
  const engine = new AutopilotEngine('debounce repeated telemetry and thread churn', { signalIntensity: 0.75 }, {}, clock.now);
  for (let i = 0; i < 12; i += 1) {
    engine.ingestSignal(createSignal({ source: 'system', key: 'telemetry-spike', reason: `spike ${i}`, wakeMode: 'debounce', debounceMs: 400, throttleMs: 2_000, tags: ['signal', 'telemetry'] }));
    clock.advance(15);
  }
  const beforeFlush = engine.tick('debounce-before-flush');
  clock.advance(500);
  const afterFlush = engine.tick('debounce-after-flush');
  const collapsedToSingleWake = beforeFlush.scheduler.pendingCount === 1;
  const flushedCleanly = afterFlush.scheduler.pendingCount === 0;
  const signalCount = afterFlush.signalSummary.system ?? 0;
  const score = average([
    scoreRatio(collapsedToSingleWake, 0.45),
    scoreRatio(flushedCleanly, 0.2),
    scoreRatio(signalCount === 12, 0.35),
  ]);
  return {
    name: 'debounce-collapse',
    score,
    passed: score >= 0.9,
    metrics: {
      beforePending: beforeFlush.scheduler.pendingCount,
      afterPending: afterFlush.scheduler.pendingCount,
      signalCount,
      loopCount: afterFlush.liveState.loopCount,
    },
    notes: afterFlush.auditTrail,
  };
}

function runAutoResumeCase(): AutopilotBenchmarkCaseResult {
  const clock = createClock();
  const engine = new AutopilotEngine('resume without user nudges', { openThreads: 1 }, {}, clock.now);
  engine.pause('manual hold');
  engine.ingestSignal(createSignal({ source: 'email', key: 'resume', reason: 'wake the loop', wakeMode: 'immediate', tags: ['resume', 'thread'] }));
  clock.advance(1);
  const snapshot = engine.tick('auto-resume');
  const resumed = snapshot.liveState.status === 'running';
  const wakeReasoned = typeof snapshot.liveState.lastWakeReason === 'string' && /resume|wake|auto/i.test(snapshot.liveState.lastWakeReason);
  const score = average([
    scoreRatio(resumed, 0.6),
    scoreRatio(wakeReasoned, 0.4),
  ]);
  return {
    name: 'auto-resume',
    score,
    passed: score >= 0.9,
    metrics: {
      resumed,
      wakeReason: snapshot.liveState.lastWakeReason ?? 'none',
      pendingCount: snapshot.scheduler.pendingCount,
      status: snapshot.liveState.status,
    },
    notes: snapshot.auditTrail,
  };
}

function runLiveObservationCase(): AutopilotBenchmarkCaseResult {
  const clock = createClock();
  const engine = new AutopilotEngine('observe live state across sources', { relationshipWeight: 0.3, openThreads: 1, calendarConflicts: 1 }, {}, clock.now);
  engine.observe('email', 'thread-depth', 'open thread needs reply', 0.91, 20_000, ['thread']);
  engine.observe('calendar', 'availability', 'conflict window detected', 0.94, 20_000, ['calendar']);
  engine.observe('browser', 'page-state', 'live page changed', 0.87, 20_000, ['browser']);
  const snapshot = engine.tick('live-observation');
  const sources = new Set(snapshot.observations.slice(-3).map((observation) => observation.source));
  const breadth = sources.size >= 3;
  const score = average([
    scoreRatio(breadth, 0.7),
    scoreRatio(snapshot.liveState.observationCount >= 8, 0.3),
  ]);
  return {
    name: 'live-observation',
    score,
    passed: score >= 0.85,
    metrics: {
      sources: [...sources].join(','),
      observationCount: snapshot.liveState.observationCount,
      pendingSubscriptions: snapshot.liveState.pendingSubscriptions,
    },
    notes: snapshot.auditTrail,
  };
}

function runCrossSourceCoverageCase(): AutopilotBenchmarkCaseResult {
  const clock = createClock();
  const engine = new AutopilotEngine(
    'pull email, calendar, browser, filesystem, and integration signals into one loop',
    { relationshipWeight: 0.52, openThreads: 2, calendarConflicts: 1, staleTransactional: 1, signalIntensity: 0.65 },
    {
      signals: [
        { source: 'email', key: 'reply', reason: 'email signal' },
        { source: 'calendar', key: 'meeting', reason: 'calendar signal' },
        { source: 'browser', key: 'page', reason: 'browser signal' },
        { source: 'filesystem', key: 'path', reason: 'filesystem signal' },
        { source: 'integration', key: 'issue', reason: 'integration signal' },
      ],
    },
    clock.now,
  );
  clock.advance(2);
  const snapshot = engine.tick('cross-source');
  const uniqueSources = Object.keys(snapshot.signalSummary).length;
  const diverseSubscriptions = new Set(snapshot.subscriptions.map((subscription) => subscription.source)).size;
  const score = average([
    scoreRatio(uniqueSources >= 5, 0.5),
    scoreRatio(diverseSubscriptions >= 4, 0.3),
    scoreRatio(snapshot.backgroundTriggers.some((trigger) => trigger.name === 'signal-observer'), 0.2),
  ]);
  return {
    name: 'cross-source-coverage',
    score,
    passed: score >= 0.9,
    metrics: {
      uniqueSources,
      diverseSubscriptions,
      triggerCount: snapshot.backgroundTriggers.length,
    },
    notes: snapshot.auditTrail,
  };
}

export function runAutopilotBenchmark() {
  const results = [
    runWakeOnSignalCase(),
    runDebounceCollapseCase(),
    runAutoResumeCase(),
    runLiveObservationCase(),
    runCrossSourceCoverageCase(),
  ];
  const scores = results.map((result) => result.score);
  const summary: AutopilotBenchmarkSummary = {
    averageScore: average(scores),
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
    passRate: results.filter((result) => result.passed).length / results.length,
    verdict: results.every((result) => result.passed) ? 'pass' : 'needs-work',
  };

  return { results, summary };
}

export function runAutopilotAudit(): AutopilotAudit {
  const standards = {
    wakeOnSignal: 0.9,
    debounceCollapse: 0.9,
    autoResume: 0.9,
    liveObservation: 0.85,
    crossSourceCoverage: 0.9,
  };
  const benchmark = runAutopilotBenchmark();
  const gaps = benchmark.results.filter((result) => result.score < standards[
    result.name === 'wake-on-signal'
      ? 'wakeOnSignal'
      : result.name === 'debounce-collapse'
        ? 'debounceCollapse'
        : result.name === 'auto-resume'
          ? 'autoResume'
          : result.name === 'live-observation'
            ? 'liveObservation'
            : 'crossSourceCoverage'
  ]).map((result) => result.name);
  const passed = gaps.length === 0 && benchmark.summary.passRate === 1;
  return { standards, results: benchmark.results, summary: benchmark.summary, passed, gaps };
}

export function formatAutopilotBenchmark(): string {
  const benchmark = runAutopilotBenchmark();
  const lines = [
    `average score: ${benchmark.summary.averageScore.toFixed(3)}`,
    `min score: ${benchmark.summary.minScore.toFixed(3)}`,
    `max score: ${benchmark.summary.maxScore.toFixed(3)}`,
    `pass rate: ${(benchmark.summary.passRate * 100).toFixed(1)}%`,
    `verdict: ${benchmark.summary.verdict}`,
    '',
  ];

  for (const result of benchmark.results) {
    lines.push(`${result.name}: ${result.score.toFixed(3)} passed=${result.passed} metrics=${JSON.stringify(result.metrics)}`);
  }

  return lines.join('\n');
}

export function formatAutopilotAudit(): string {
  const audit = runAutopilotAudit();
  const lines = [
    `passed: ${audit.passed}`,
    `average score: ${audit.summary.averageScore.toFixed(3)}`,
    `pass rate: ${(audit.summary.passRate * 100).toFixed(1)}%`,
    `gaps: ${audit.gaps.length > 0 ? audit.gaps.join(', ') : 'none'}`,
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  console.log(formatAutopilotBenchmark());
  console.log('');
  console.log(formatAutopilotAudit());
}

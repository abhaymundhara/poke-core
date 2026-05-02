import { AutopilotEngine } from './engine';
import { createSignal } from './events';
import { pollLiveWebSignals } from './live-signals';

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

async function runWakeOnSignalCase(): Promise<AutopilotBenchmarkCaseResult> {
  const clock = createClock();
  const engine = new AutopilotEngine('keep me awake on live thread and calendar signals', { relationshipWeight: 0.68, openThreads: 2, calendarConflicts: 1 }, { liveDaemon: false }, clock.now);
  engine.ingestSignal(createSignal({ source: 'email', key: 'reply', reason: 'new reply arrived', wakeMode: 'immediate', tags: ['thread', 'relationship'] }));
  clock.advance(1);
  const snapshot = await engine.tick('wake-on-signal');
  const wakeTriggered = snapshot.liveState.status === 'running' && snapshot.liveState.lastWakeReason !== null;
  const selfTrigger = snapshot.backgroundTriggers.some((trigger) => trigger.name === 'thread-watcher' || trigger.name === 'relationship-recall');
  const score = [scoreRatio(wakeTriggered, 0.45), scoreRatio(snapshot.scheduler.pendingCount === 0, 0.2), scoreRatio(selfTrigger, 0.35)].reduce((sum, value) => sum + value, 0);
  return {
    name: 'wake-on-signal',
    score,
    passed: score >= 0.9,
    metrics: { wakeTriggered, pendingCount: snapshot.scheduler.pendingCount, selfTrigger, status: snapshot.liveState.status },
    notes: snapshot.auditTrail,
  };
}

async function runDebounceCollapseCase(): Promise<AutopilotBenchmarkCaseResult> {
  const clock = createClock();
  const engine = new AutopilotEngine('debounce repeated telemetry and thread churn', { signalIntensity: 0.75 }, { liveDaemon: false }, clock.now);
  for (let i = 0; i < 12; i += 1) {
    engine.ingestSignal(createSignal({ source: 'system', key: 'telemetry-spike', reason: `spike ${i}`, wakeMode: 'debounce', debounceMs: 400, throttleMs: 2_000, tags: ['signal', 'telemetry'] }));
    clock.advance(15);
  }
  const beforeFlush = await engine.tick('debounce-before-flush');
  clock.advance(500);
  const afterFlush = await engine.tick('debounce-after-flush');
  const collapsedToSingleWake = beforeFlush.scheduler.pendingCount === 1;
  const flushedCleanly = afterFlush.scheduler.pendingCount === 0;
  const signalCount = afterFlush.signalSummary.system ?? 0;
  const score = [scoreRatio(collapsedToSingleWake, 0.45), scoreRatio(flushedCleanly, 0.2), scoreRatio(signalCount === 12, 0.35)].reduce((sum, value) => sum + value, 0);
  return {
    name: 'debounce-collapse',
    score,
    passed: score >= 0.9,
    metrics: { beforePending: beforeFlush.scheduler.pendingCount, afterPending: afterFlush.scheduler.pendingCount, signalCount, loopCount: afterFlush.liveState.loopCount },
    notes: afterFlush.auditTrail,
  };
}

async function runAutoResumeCase(): Promise<AutopilotBenchmarkCaseResult> {
  const clock = createClock();
  const engine = new AutopilotEngine('resume without user nudges', { openThreads: 1 }, { liveDaemon: false }, clock.now);
  engine.pause('manual hold');
  engine.ingestSignal(createSignal({ source: 'email', key: 'resume', reason: 'wake the loop', wakeMode: 'immediate', tags: ['resume', 'thread'] }));
  clock.advance(1);
  const snapshot = await engine.tick('auto-resume');
  const resumed = snapshot.liveState.status === 'running';
  const wakeReasoned = typeof snapshot.liveState.lastWakeReason === 'string' && /resume|wake|auto/i.test(snapshot.liveState.lastWakeReason);
  const score = [scoreRatio(resumed, 0.6), scoreRatio(wakeReasoned, 0.4)].reduce((sum, value) => sum + value, 0);
  return {
    name: 'auto-resume',
    score,
    passed: score >= 0.9,
    metrics: { resumed, wakeReason: snapshot.liveState.lastWakeReason ?? 'none', pendingCount: snapshot.scheduler.pendingCount, status: snapshot.liveState.status },
    notes: snapshot.auditTrail,
  };
}

async function runLiveWebFreshnessCase(): Promise<AutopilotBenchmarkCaseResult> {
  const bundle = await pollLiveWebSignals('latest TypeScript release notes');
  const hasResults = bundle.results.length >= 3;
  const crawled = bundle.crawls.length >= 1;
  const freshEnough = bundle.freshnessScore >= 0.3;
  const signalCount = bundle.signals.length;
  const score = [scoreRatio(hasResults, 0.35), scoreRatio(crawled, 0.35), scoreRatio(freshEnough, 0.2), scoreRatio(signalCount >= 2, 0.1)].reduce((sum, value) => sum + value, 0);
  return {
    name: 'live-web-freshness',
    score,
    passed: score >= 0.9,
    metrics: {
      resultCount: bundle.results.length,
      crawlCount: bundle.crawls.length,
      freshnessScore: bundle.freshnessScore,
      signalCount,
    },
    notes: bundle.results.slice(0, 3).map((result) => `${result.source}:${result.title}`),
  };
}

async function runPlatformSignalCase(): Promise<AutopilotBenchmarkCaseResult> {
  const clock = createClock();
  const engine = new AutopilotEngine(
    'ingest real github issue and pull-request events',
    { relationshipWeight: 0.4, openThreads: 1, calendarConflicts: 0, staleTransactional: 0, signalIntensity: 0.4 },
    { liveDaemon: false, githubWatches: [{ owner: 'microsoft', repo: 'TypeScript', perPage: 3, state: 'OPEN' }] },
    clock.now,
  );
  engine.startDaemon(1);
  const live = await engine.pollLiveSources();
  const snapshot = (engine as any).snapshot('platform-ingestion');
  const hasPlatformEvents = live.platform.events.length > 0;
  const externalEvents = snapshot.liveState.externalEvents >= live.platform.events.length;
  const triggered = snapshot.backgroundTriggers.some((trigger: any) => trigger.name === 'platform-event-watch' || trigger.name === 'signal-observer');
  const score = [scoreRatio(hasPlatformEvents, 0.5), scoreRatio(externalEvents, 0.3), scoreRatio(triggered, 0.2)].reduce((sum, value) => sum + value, 0);
  engine.stopDaemon();
  return {
    name: 'platform-signal-ingestion',
    score,
    passed: score >= 0.9,
    metrics: {
      platformEvents: live.platform.events.length,
      externalEvents: snapshot.liveState.externalEvents,
      daemonRunning: snapshot.liveState.daemonRunning,
      triggerCount: snapshot.backgroundTriggers.length,
    },
    notes: live.platform.events.slice(0, 3).map((event) => `${event.kind}:${event.title}`),
  };
}

async function runDaemonProactivityCase(): Promise<AutopilotBenchmarkCaseResult> {
  const clock = createClock();
  const engine = new AutopilotEngine(
    'daemon wakes on real external changes',
    { relationshipWeight: 0.5, openThreads: 1, calendarConflicts: 1, signalIntensity: 0.55 },
    { liveDaemon: false, githubWatches: [{ owner: 'microsoft', repo: 'TypeScript', perPage: 2, state: 'OPEN' }] },
    clock.now,
  );
  engine.startDaemon(1);
  const before = await engine.pollLiveSources();
  const snapshot = (engine as any).snapshot('daemon-proactivity');
  const daemonRunning = snapshot.daemon.running && snapshot.liveState.daemonRunning;
  const wakeReasoned = typeof snapshot.liveState.lastWakeReason === 'string' && snapshot.liveState.lastWakeReason.length > 0;
  const liveWake = snapshot.auditTrail.some((entry: string) => entry.startsWith('live-wake:'));
  const refreshed = snapshot.liveState.liveWebResults >= before.web.results.length && snapshot.liveState.externalEvents >= before.platform.events.length;
  const score = [scoreRatio(daemonRunning, 0.35), scoreRatio(wakeReasoned, 0.25), scoreRatio(liveWake, 0.2), scoreRatio(refreshed, 0.2)].reduce((sum, value) => sum + value, 0);
  engine.stopDaemon();
  return {
    name: 'daemon-proactivity',
    score,
    passed: score >= 0.9,
    metrics: {
      daemonRunning,
      liveWake,
      wakeReason: snapshot.liveState.lastWakeReason ?? 'none',
      liveWebResults: snapshot.liveState.liveWebResults,
      externalEvents: snapshot.liveState.externalEvents,
    },
    notes: snapshot.auditTrail,
  };
}

export async function runAutopilotBenchmark() {
  const results = await Promise.all([
    runWakeOnSignalCase(),
    runDebounceCollapseCase(),
    runAutoResumeCase(),
    runLiveWebFreshnessCase(),
    runPlatformSignalCase(),
    runDaemonProactivityCase(),
  ]);
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

function standardKeyFor(name: string): keyof AutopilotAudit['standards'] {
  if (name === 'wake-on-signal') return 'wakeOnSignal';
  if (name === 'debounce-collapse') return 'debounceCollapse';
  if (name === 'auto-resume') return 'autoResume';
  if (name === 'live-web-freshness') return 'liveWebFreshness';
  if (name === 'platform-signal-ingestion') return 'platformSignalIngestion';
  return 'daemonProactivity';
}

export async function runAutopilotAudit(): Promise<AutopilotAudit> {
  const standards = {
    wakeOnSignal: 0.9,
    debounceCollapse: 0.9,
    autoResume: 0.9,
    liveWebFreshness: 0.9,
    platformSignalIngestion: 0.9,
    daemonProactivity: 0.9,
  };
  const benchmark = await runAutopilotBenchmark();
  const gaps = benchmark.results.filter((result) => result.score < standards[standardKeyFor(result.name)]).map((result) => result.name);
  const passed = gaps.length === 0 && benchmark.summary.passRate === 1;
  return { standards, results: benchmark.results, summary: benchmark.summary, passed, gaps };
}

export async function formatAutopilotBenchmark(): Promise<string> {
  const benchmark = await runAutopilotBenchmark();
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

export async function formatAutopilotAudit(): Promise<string> {
  const audit = await runAutopilotAudit();
  return [`passed: ${audit.passed}`, `average score: ${audit.summary.averageScore.toFixed(3)}`, `pass rate: ${(audit.summary.passRate * 100).toFixed(1)}%`, `gaps: ${audit.gaps.length > 0 ? audit.gaps.join(', ') : 'none'}`].join('\n');
}

if (import.meta.main) {
  console.log(await formatAutopilotBenchmark());
  console.log('');
  console.log(await formatAutopilotAudit());
}

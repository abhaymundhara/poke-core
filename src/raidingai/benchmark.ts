import { canonicalThreadIdentity, expandRecurrence, reconcileAttendees, normalizeWallTime } from '../deep-primitives';
import { runVisionLoop, type VisionFrame } from '../skills/computer-use';
import { BehavioralLearningLayer } from '../memory/behavioral-learning';
import { MemoryConsolidationJob } from '../memory/consolidation';
import { RAIDINGAI_FIXTURES } from './fixtures';

export type RaidingAiCaseResult = { name: string; score: number; passed: boolean; notes: string[]; metrics: Record<string, number | string | boolean> };
export type RaidingAiSummary = { averageScore: number; minScore: number; maxScore: number; passRate: number; verdict: 'pass' | 'needs-work' };
export type RaidingAiAudit = { results: RaidingAiCaseResult[]; summary: RaidingAiSummary; passed: boolean; gaps: string[] };

function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function minScore(values: number[]): number { let result = Number.POSITIVE_INFINITY; for (const value of values) if (value < result) result = value; return values.length ? result : 0; }
function maxScore(values: number[]): number { let result = Number.NEGATIVE_INFINITY; for (const value of values) if (value > result) result = value; return values.length ? result : 0; }
function scoreRatio(condition: boolean, weight: number): number { return condition ? weight : 0; }
function assertNear(actual: string, expected: string): boolean { return actual === expected; }

function runComputerUseCase(): RaidingAiCaseResult {
  const frames = RAIDINGAI_FIXTURES.computerUse.frames as Iterable<VisionFrame> | (() => Iterable<VisionFrame>);
  const result = runVisionLoop(frames, { keys: RAIDINGAI_FIXTURES.computerUse.keys as Iterable<string> | (() => Iterable<string>), fallbackSelectors: RAIDINGAI_FIXTURES.computerUse.fallbackSelectors as Iterable<string> | (() => Iterable<string>) });
  const recovered = result.driftRecoveries >= 1;
  const score = [scoreRatio(result.perceptionCount === 3, 0.25), scoreRatio(recovered, 0.35), scoreRatio(result.finalSelector === 'selector-b', 0.2), scoreRatio(result.lastAction === 'enter', 0.2)].reduce((sum, value) => sum + value, 0);
  return { name: 'computer-use', score, passed: score >= 0.9, notes: [`perceptions:${result.perceptionCount}`, `drift:${result.driftRecoveries}`, `selector:${result.finalSelector ?? 'none'}`], metrics: { perceptions: result.perceptionCount, driftRecoveries: result.driftRecoveries, finalSelector: result.finalSelector ?? 'none', lastAction: result.lastAction ?? 'none' } };
}

function runDeepPrimitivesCase(): RaidingAiCaseResult {
  const fixtures = RAIDINGAI_FIXTURES;
  const threadA = canonicalThreadIdentity(fixtures.deepPrimitives.threadA as any);
  const threadB = canonicalThreadIdentity(fixtures.deepPrimitives.threadB as any);
  const normalized = normalizeWallTime(fixtures.deepPrimitives.timezone.local, fixtures.deepPrimitives.timezone.timeZone);
  const attendees = reconcileAttendees(fixtures.deepPrimitives.attendees as any, fixtures.deepPrimitives.timezone.timeZone, fixtures.signalBridge.localeHint);
  const recurrence = expandRecurrence(fixtures.deepPrimitives.recurrence as any);
  const expectedDays = String(fixtures.deepPrimitives.recurrence.rule).match(/BYDAY=([^;]+)/)?.[1].split(',').filter(Boolean) ?? [];
  const score = [
    scoreRatio(threadA.threadId === threadB.threadId, 0.35),
    scoreRatio(assertNear(normalized.utc, fixtures.deepPrimitives.timezone.expectedUtc), 0.3),
    scoreRatio(attendees.length === fixtures.deepPrimitives.attendees.length, 0.15),
    scoreRatio(recurrence.length === 3 && (expectedDays[0] ? recurrence[0]?.weekday === expectedDays[0] : recurrence.length > 0), 0.2),
  ].reduce((sum, value) => sum + value, 0);
  return { name: 'deep-primitives', score, passed: score >= 0.9, notes: [threadA.threadId, threadB.threadId, normalized.utc, recurrence.map((instance) => instance.startUtc).join(',')], metrics: { threadId: threadA.threadId, normalizedUtc: normalized.utc, attendeeCount: attendees.length, recurrenceCount: recurrence.length } };
}

function runMemoryConsolidationCase(): RaidingAiCaseResult {
  const fixtures = RAIDINGAI_FIXTURES.memory;
  const job = new MemoryConsolidationJob({ now: Date.now(), workingFacts: fixtures.facts as any, episodicItems: fixtures.episodes as any, decayHalfLifeHours: 24 });
  const result = job.run();
  const hasRelevantDocument = result.semanticDocuments.length >= 1;
  const hasLinkCoverage = result.links.length >= 1;
  const promotedEnough = result.promotedFacts.length >= Math.min(3, fixtures.facts.length);
  const score = [scoreRatio(hasRelevantDocument, 0.35), scoreRatio(hasLinkCoverage, 0.25), scoreRatio(promotedEnough, 0.4)].reduce((sum, value) => sum + value, 0);
  return { name: 'memory-consolidation', score, passed: score >= 0.9, notes: [result.summary], metrics: { promotedFacts: result.promotedFacts.length, semanticDocuments: result.semanticDocuments.length, links: result.links.length, decayedFacts: result.decayedFacts.length } };
}

function runBehavioralModelCase(): RaidingAiCaseResult {
  const storagePath = '.poke-core/behavioral-audit.json';
  const first = new BehavioralLearningLayer({ storagePath });
  const result = first.learn({ now: Date.now(), workingFacts: RAIDINGAI_FIXTURES.memory.facts as any, episodicItems: RAIDINGAI_FIXTURES.memory.episodes as any, sourceDocuments: [] });
  const reopened = new BehavioralLearningLayer({ storagePath }).snapshot();
  const hasTheory = result.theory.latentAxes.length >= 2 && result.theory.crossContextGeneralizations.length >= 2;
  const hasPolicies = result.policies.some((policy) => policy.persistent && policy.enabled) && result.policies.some((policy) => typeof policy.action.type === 'string' && policy.action.type.length > 0);
  const hasForecasts = result.forecasts.length >= 3 && result.nextBestActions.length >= 2;
  const persisted = reopened.theory != null && reopened.policies.length >= result.policies.length && reopened.forecasts.length >= result.forecasts.length;
  const score = [scoreRatio(hasTheory, 0.3), scoreRatio(hasPolicies, 0.25), scoreRatio(hasForecasts, 0.25), scoreRatio(persisted, 0.2)].reduce((sum, value) => sum + value, 0);
  return { name: 'behavioral-model', score, passed: score >= 0.9, notes: [result.summary, result.theory.summary], metrics: { latentAxes: result.theory.latentAxes.length, policies: result.policies.length, forecasts: result.forecasts.length, persisted: persisted } };
}

export function runRaidingAiBenchmark() {
  const results = [runComputerUseCase(), runDeepPrimitivesCase(), runMemoryConsolidationCase(), runBehavioralModelCase()];
  const scores = results.map((result) => result.score);
  const summary: RaidingAiSummary = { averageScore: average(scores), minScore: minScore(scores), maxScore: maxScore(scores), passRate: results.filter((result) => result.passed).length / results.length, verdict: results.every((result) => result.passed) ? 'pass' : 'needs-work' };
  return { results, summary };
}

export function runRaidingAiAudit(): RaidingAiAudit {
  const benchmark = runRaidingAiBenchmark();
  const thresholds = { 'computer-use': 0.9, 'deep-primitives': 0.9, 'memory-consolidation': 0.9, 'behavioral-model': 0.9 } as const;
  const gaps = benchmark.results.filter((result) => result.score < thresholds[result.name as keyof typeof thresholds]).map((result) => result.name);
  const passed = gaps.length === 0 && benchmark.summary.passRate === 1;
  return { results: benchmark.results, summary: benchmark.summary, passed, gaps };
}

export function formatRaidingAiBenchmark(): string {
  const benchmark = runRaidingAiBenchmark();
  const lines = [`average score: ${benchmark.summary.averageScore.toFixed(3)}`, `min score: ${benchmark.summary.minScore.toFixed(3)}`, `max score: ${benchmark.summary.maxScore.toFixed(3)}`, `pass rate: ${(benchmark.summary.passRate * 100).toFixed(1)}%`, `verdict: ${benchmark.summary.verdict}`, ''];
  for (const result of benchmark.results) lines.push(`${result.name}: ${result.score.toFixed(3)} passed=${result.passed} metrics=${JSON.stringify(result.metrics)}`);
  return lines.join('\n');
}

export function formatRaidingAiAudit(): string {
  const audit = runRaidingAiAudit();
  return [`passed: ${audit.passed}`, `average score: ${audit.summary.averageScore.toFixed(3)}`, `pass rate: ${(audit.summary.passRate * 100).toFixed(1)}%`, `gaps: ${audit.gaps.length > 0 ? audit.gaps.join(', ') : 'none'}`].join('\n');
}

if (import.meta.main) {
  console.log(formatRaidingAiBenchmark());
  console.log('');
  console.log(formatRaidingAiAudit());
}

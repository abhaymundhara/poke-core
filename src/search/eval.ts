import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSemanticSearchIntent, createSearchSession, SearchPolicyStore, type SearchPolicyRule, type SemanticNluProvider } from './index.ts';

const policyPath = resolve(process.cwd(), '.poke-core', 'search-eval-policy.json');
rmSync(policyPath, { force: true });

const provider: SemanticNluProvider = {
  name: 'eval-llm',
  async extract() {
    return {
      semanticQuery: 'poke-core semantic nlu trust graph',
      entities: ['poke-core', 'semantic NLU'],
      topics: ['source trust', 'multi-hop reasoning'],
      constraints: [{ field: 'quality', operator: 'must', value: 'official sources', confidence: 0.9 }],
      sourcePriors: [{ source: 'github', weight: 0.9, reason: 'repository evidence' }, { source: 'scholar', weight: 0.78, reason: 'epistemic reliability' }],
      freshness: 'recent',
      focus: 'multi-hop',
      hopBudget: 4,
      trustMode: 'official-first',
      confidence: 0.88,
    };
  },
};

const intent = await buildSemanticSearchIntent('Verify latest poke-core semantic search behavior with official evidence', { live: true }, provider);
assert.equal(intent.nlu.provider, 'eval-llm');
assert.equal(intent.nlu.fallbackUsed, false);
assert.equal(intent.hopBudget, 4);
assert.ok(intent.constraints.some((constraint) => constraint.value === 'official sources'));

const invalidIntent = await buildSemanticSearchIntent('bad provider should not corrupt planning', {}, {
  name: 'invalid-eval-llm',
  async extract() {
    return {
      semanticQuery: 'bad',
      entities: [],
      topics: [],
      constraints: [{ field: 'quality', operator: 'must', value: 'x', confidence: 'bad' }],
      sourcePriors: [{ source: 'web', weight: 'bad', reason: 'bad' }],
      freshness: 'recent',
      focus: 'semantic',
      hopBudget: 'NaN',
      trustMode: 'broad',
      confidence: 'bad',
    };
  },
});
assert.equal(invalidIntent.nlu.fallbackUsed, true);
assert.ok(Number.isFinite(invalidIntent.nlu.confidence));

const session = createSearchSession({
  policyPath,
  nluProvider: provider,
  behaviorSeed: {
    trajectory: [
      { sessionId: 's1', source: 'github', action: 'inspect issue', outcome: 'success', topic: 'search policy' },
      { sessionId: 's2', source: 'github', action: 'review diff', outcome: 'success', topic: 'search policy' },
      { sessionId: 's3', source: 'email', action: 'follow up', outcome: 'failure', topic: 'user follow-up' },
    ],
  },
});

const plan = await session.runSemantic('Verify latest poke-core semantic search behavior with official evidence', { live: true }, [
  { title: 'Official repository', url: 'https://github.com/abhaymundhara/poke-core', snippet: 'poke-core semantic search policy is implemented with claim-level verification', source: 'github', publishedAt: '2026-04-30T00:00:00.000Z', claims: ['semantic search policy is implemented'], trust: 0.93, freshness: 0.95, score: 0.91 },
  { title: 'Design note', url: 'https://example.edu/search-reasoning', snippet: 'claim-level verification supports multi-hop reasoning and confidence propagation', source: 'scholar', claims: ['claim-level verification supports multi-hop reasoning'], trust: 0.88, freshness: 0.72, score: 0.86 },
  { title: 'Contrary stale post', url: 'https://medium.com/example/stale', snippet: 'semantic search policy is not implemented', source: 'web', publishedAt: '2022-01-01T00:00:00.000Z', claims: ['semantic search policy is not implemented'], trust: 0.32, freshness: 0.1, score: 0.2 },
]);

assert.ok(plan.sourceRanking[0].score >= plan.sourceRanking.at(-1)!.score);
assert.ok(plan.evidenceGraph.claims.length >= 2);
assert.ok(plan.evidenceGraph.conflicts.length >= 1);
assert.ok(plan.evidenceGraph.confidence > 0.45);
assert.ok(plan.predictedSignals.some((signal) => signal.topic === 'search policy'));

const store = new SearchPolicyStore(policyPath);
const before = store.load().version;
const validRule: SearchPolicyRule = { id: 'eval-rule', description: 'Keep hop budgets bounded.', enabled: true, maxHopBudget: 5, guardrails: ['bounded-hop-budget'] };
const rewritten = store.rewriteFromFeedback({ summary: 'eval accepted rewrite', rules: [validRule], sourceReliability: { github: 0.92 } });
assert.equal(rewritten.version, before + 1);
assert.equal(rewritten.auditLog.at(-1)?.accepted, true);
assert.equal(rewritten.sourceReliability.github.score, 0.92);

const rejected = store.rewriteFromFeedback({ summary: 'eval rejected rewrite', rules: [{ ...validRule, id: 'bad-rule', maxHopBudget: 99 }] });
assert.equal(rejected.version, rewritten.version);
assert.equal(rejected.auditLog.at(-1)?.accepted, false);

const rolledBack = store.rollback(1);
assert.equal(rolledBack.version, 1);
assert.equal(rolledBack.auditLog.at(-1)?.action, 'rollback');
assert.notEqual(rolledBack.sourceReliability.github.score, 0.92);

store.save({ ...store.load(), strategies: [] });
assert.ok(createSearchSession({ policyPath }).plan('empty policy should normalize').strategy.id.length > 0);

mkdirSync(resolve(process.cwd(), '.poke-core'), { recursive: true });
writeFileSync(resolve(process.cwd(), '.poke-core', 'behavioral-state.json'), JSON.stringify({ observations: [{ source: 'github', topic: 'persisted behavior', outcome: 'success' }] }));
const persistedForecast = createSearchSession({ policyPath }).forecast('use persisted behavior when no seed is passed');
assert.ok(persistedForecast.some((signal) => signal.topic === 'persisted behavior'));
rmSync(resolve(process.cwd(), '.poke-core', 'behavioral-state.json'), { force: true });

console.log(JSON.stringify({ passed: true, confidence: plan.evidenceGraph.confidence, claims: plan.evidenceGraph.claims.length, conflicts: plan.evidenceGraph.conflicts.length, policyVersion: rolledBack.version }, null, 2));

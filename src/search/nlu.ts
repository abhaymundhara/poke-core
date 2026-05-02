import type { IntentAmbiguity, SearchConstraint, SearchFocus, SearchFreshness, SearchIntent, SearchSource, SemanticFrame, SourcePrior, TrustMode } from './types.ts';
import { normalize, stableHash, uniq, words, clamp } from './utils.ts';

export type SemanticNluOutput = {
  semanticQuery: string;
  entities: string[];
  topics: string[];
  constraints: SearchConstraint[];
  sourcePriors: SourcePrior[];
  semanticFrames: SemanticFrame[];
  decomposedQuestions: string[];
  ambiguities: IntentAmbiguity[];
  freshness: SearchFreshness;
  focus: SearchFocus;
  hopBudget: number;
  trustMode: TrustMode;
  confidence: number;
  warnings?: string[];
};

export type SemanticNluProvider = {
  name: string;
  extract(input: { objective: string; context: Record<string, unknown>; schema: Record<string, unknown> }): Promise<unknown>;
};

export const SEMANTIC_NLU_SCHEMA = {
  type: 'object',
  required: ['semanticQuery', 'entities', 'topics', 'constraints', 'sourcePriors', 'freshness', 'focus', 'hopBudget', 'trustMode', 'confidence'],
  properties: {
    semanticQuery: { type: 'string' },
    entities: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array' },
    sourcePriors: { type: 'array' },
    semanticFrames: { type: 'array' },
    decomposedQuestions: { type: 'array', items: { type: 'string' } },
    ambiguities: { type: 'array' },
    freshness: { enum: ['historical', 'recent', 'live'] },
    focus: { enum: ['semantic', 'trust', 'multi-hop', 'factual', 'diagnostic', 'exploratory'] },
    hopBudget: { type: 'integer', minimum: 1, maximum: 6 },
    trustMode: { enum: ['official-first', 'diverse', 'broad'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

function extractEntities(text: string): string[] {
  const matches = text.match(/(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+|[A-Z]{2,}(?:-[A-Z0-9]+)?|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/\S+|\b[a-z0-9_.-]+\/[a-z0-9_.-]+\b)/gi) ?? [];
  return uniq(matches.map((value) => value.replace(/[),.;]+$/g, ''))).slice(0, 12);
}

function detectFreshness(text: string): SearchFreshness {
  if (/(live|latest|current|today|now|breaking|fresh|new|real[- ]?time)/i.test(text)) return 'live';
  if (/(recent|update|trend|this week|this month|last \d+ days)/i.test(text)) return 'recent';
  return 'historical';
}

function detectFocus(text: string): SearchFocus {
  if (/(why|cause|root|diagnos|trace|debug|fix|failure|issue)/i.test(text)) return 'diagnostic';
  if (/(trust|verify|reliable|official|source|citation|evidence|provenance)/i.test(text)) return 'trust';
  if (/(multi-hop|chain|deep|fuse|combine|correlat|synthesize|contradict|conflict)/i.test(text)) return 'multi-hop';
  if (/(discover|explore|brainstorm|survey)/i.test(text)) return 'exploratory';
  if (/(what|who|where|when|how|definition|explain)/i.test(text)) return 'semantic';
  return 'factual';
}

function detectSourceHints(text: string): SearchSource[] {
  const lower = text.toLowerCase();
  const hints: SearchSource[] = [];
  if (/(live|latest|current|breaking|now|today|real[- ]?time)/.test(lower)) hints.push('realtime-web');
  if (/(github|repo|issue|pr|pull request|commit|code)/.test(lower)) hints.push('github');
  if (/(paper|study|journal|citation|scholar|arxiv|doi)/.test(lower)) hints.push('scholar');
  if (/(email|thread|inbox|message|reply)/.test(lower)) hints.push('email');
  if (/(calendar|meeting|schedule|availability)/.test(lower)) hints.push('calendar');
  if (/(file|filesystem|folder|directory|path|diff)/.test(lower)) hints.push('filesystem');
  if (/(integration|notion|linear|todoist|slack|vercel)/.test(lower)) hints.push('integration');
  if (/(memory|profile|preference|behavior|style)/.test(lower)) hints.push('memory');
  return uniq(hints.length ? hints : ['web']);
}

function detectConstraints(text: string): SearchConstraint[] {
  const constraints: SearchConstraint[] = [];
  if (/(official|primary source|first[- ]party)/i.test(text)) constraints.push({ field: 'quality', operator: 'must', value: 'primary-or-official-source', confidence: 0.86 });
  if (/(exclude|without|not from|avoid)/i.test(text)) constraints.push({ field: 'exclusion', operator: 'must-not', value: 'excluded-source-or-topic-mentioned', confidence: 0.62 });
  if (/(today|latest|current|live|this week|last \d+ days)/i.test(text)) constraints.push({ field: 'time', operator: 'must', value: detectFreshness(text), confidence: 0.8 });
  const domains = [...text.matchAll(/\bsite:([a-z0-9.-]+\.[a-z]{2,})/gi)].map((match) => match[1]);
  for (const domain of domains) constraints.push({ field: 'domain', operator: 'must', value: domain, confidence: 0.9 });
  return constraints;
}

function buildSemanticQuery(text: string, entities: string[]): string {
  const stop = /^(the|and|for|with|from|that|this|into|about|need|want|please|help|find|search)$/i;
  const tokens = words(text).filter((value) => !stop.test(value));
  return uniq([...entities.slice(0, 4), ...tokens.slice(0, 10)]).join(' ').trim() || text.trim();
}

function hopBudgetFor(text: string, focus: SearchFocus): number {
  const connectors = Math.max(0, text.split(/\b(and|or|with|via|through|between|from|to|versus|vs)\b/i).length - 1);
  const base = 1 + Math.min(3, connectors);
  if (focus === 'multi-hop' || focus === 'diagnostic' || focus === 'trust') return Math.max(base, 3);
  return Math.min(4, base);
}

function sourcePriorsFor(hints: SearchSource[], freshness: SearchFreshness, focus: SearchFocus): SourcePrior[] {
  return uniq([...hints, 'web', 'scholar', 'github'] as SearchSource[]).map((source) => {
    const weight = clamp(0.55 + (hints.includes(source) ? 0.25 : 0) + (source === 'realtime-web' && freshness === 'live' ? 0.18 : 0) + (source === 'scholar' && focus === 'trust' ? 0.14 : 0));
    return { source, weight, reason: hints.includes(source) ? 'explicit-or-inferred-source-prior' : 'coverage-backstop' };
  }).sort((left, right) => right.weight - left.weight);
}

function semanticFramesFor(objective: string, entities: string[], topics: string[], focus: SearchFocus): SemanticFrame[] {
  const objectiveWords = words(objective);
  const slots: Record<string, string[]> = {
    entities: entities.slice(0, 8),
    topics: topics.slice(0, 8),
    actions: objectiveWords.filter((word) => /^(verify|compare|find|explain|diagnose|monitor|forecast|rewrite|prove|trace)$/.test(word)).slice(0, 6),
  };
  const primary = focus === 'diagnostic' ? 'causal-diagnosis' : focus === 'trust' ? 'evidence-verification' : focus === 'multi-hop' ? 'compositional-research' : 'information-seeking';
  return [{ name: primary, description: `Semantic frame inferred for ${focus} search objective`, confidence: 0.58, slots }];
}

function decomposedQuestionsFor(objective: string, entities: string[], topics: string[], focus: SearchFocus): string[] {
  const subject = entities[0] ?? topics[0] ?? objective;
  const questions = [`What evidence directly answers: ${objective}?`];
  if (focus === 'trust' || focus === 'multi-hop') questions.push(`Which independent sources corroborate ${subject}?`);
  if (focus === 'diagnostic' || focus === 'multi-hop') questions.push(`What claims about ${subject} conflict or require reconciliation?`);
  return questions.slice(0, 4);
}

function ambiguitiesFor(objective: string, entities: string[], topics: string[]): IntentAmbiguity[] {
  if (entities.length > 0 || topics.length > 2) return [];
  return [{ issue: 'underspecified-subject', candidates: [objective], resolutionHint: 'prefer broad exploratory retrieval until evidence narrows the subject', confidence: 0.52 }];
}

export function bootstrapSemanticNlu(objective: string, context: Record<string, unknown> = {}): SemanticNluOutput {
  const normalizedObjective = objective.trim();
  const combined = `${normalizedObjective} ${JSON.stringify(context)}`.trim();
  const contextEntities = Array.isArray(context.entities) ? (context.entities as unknown[]).map(String) : [];
  const entities = uniq([...extractEntities(combined), ...contextEntities]);
  const freshness = detectFreshness(combined);
  const focus = detectFocus(combined);
  const sourceHints = detectSourceHints(combined);
  const topics = uniq([
    ...(combined.match(/\b(?:web search|live signals|search policy|source reliability|multi-hop|trustworthiness|semantic nlu|behavior|forecast|reasoning|policy engine)\b/gi) ?? []).map((value) => value.toLowerCase()),
    ...words(combined).filter((word) => !entities.some((entity) => normalize(entity).includes(word))),
  ].map((value) => value.replace(/\b(?:the|a|an|and|or|to|of|for|with|from)\b/g, '').trim())).slice(0, 10);
  return {
    semanticQuery: buildSemanticQuery(normalizedObjective, entities),
    entities,
    topics,
    constraints: detectConstraints(combined),
    sourcePriors: sourcePriorsFor(sourceHints, freshness, focus),
    semanticFrames: semanticFramesFor(normalizedObjective, entities, topics, focus),
    decomposedQuestions: decomposedQuestionsFor(normalizedObjective, entities, topics, focus),
    ambiguities: ambiguitiesFor(normalizedObjective, entities, topics),
    freshness,
    focus,
    hopBudget: hopBudgetFor(combined, focus),
    trustMode: /(official|verify|reliable|trust|citation|source|provenance)/i.test(combined) ? 'official-first' : /(compare|mix|blend|diverse|cross-source|corroborat)/i.test(combined) ? 'diverse' : 'broad',
    confidence: 0.62,
    warnings: ['semantic-bootstrap'],
  };
}


function uniqueFrames(frames: SemanticFrame[]): SemanticFrame[] {
  const seen = new Set<string>();
  const out: SemanticFrame[] = [];
  for (const frame of frames) {
    if (!seen.has(frame.name)) {
      seen.add(frame.name);
      out.push(frame);
    }
  }
  return out;
}

function semanticBootstrapNlu(objective: string, context: Record<string, unknown> = {}): SemanticNluOutput {
  const base = bootstrapSemanticNlu(objective, context);
  const emphasis = (base.semanticQuery + ' ' + base.topics.join(' ') + ' ' + JSON.stringify(context)).toLowerCase();
  const extraFrames: SemanticFrame[] = [];
  if (/(forecast|predict|next|future|anticipat)/i.test(emphasis)) {
    extraFrames.push({
      name: 'generative-forecast',
      description: 'Model the next likely user intent and follow-up evidence flow',
      confidence: 0.82,
      slots: {
        topics: uniq([...base.topics.slice(0, 4), 'forecast']),
        entities: base.entities.slice(0, 4),
        actions: ['forecast', 'simulate', 'anticipate'],
      },
    });
  }
  if (/(trust|verify|reliable|official|source|provenance|evidence)/i.test(emphasis)) {
    extraFrames.push({
      name: 'epistemic-verification',
      description: 'Prioritize source reliability, corroboration, and provenance',
      confidence: 0.86,
      slots: {
        topics: uniq(['trust', ...base.topics.slice(0, 4)]),
        entities: base.entities.slice(0, 4),
        actions: ['verify', 'corroborate', 'calibrate'],
      },
    });
  }
  if (/(claim|proposition|contradict|entail|reason|inference|proof)/i.test(emphasis)) {
    extraFrames.push({
      name: 'proposition-graph',
      description: 'Lift text into propositions and reason over entailment and contradiction',
      confidence: 0.84,
      slots: {
        topics: uniq(['proposition', ...base.topics.slice(0, 4)]),
        entities: base.entities.slice(0, 4),
        actions: ['infer', 'entail', 'rebut'],
      },
    });
  }
  if (/(policy|rewrite|architecture|self-modif|adapt)/i.test(emphasis)) {
    extraFrames.push({
      name: 'policy-adaptation',
      description: 'Forecast policy and architecture changes from observed feedback',
      confidence: 0.8,
      slots: {
        topics: uniq(['policy', 'architecture', ...base.topics.slice(0, 3)]),
        entities: base.entities.slice(0, 4),
        actions: ['rewrite', 'adapt', 'reconfigure'],
      },
    });
  }
  const semanticFrames = uniqueFrames([...base.semanticFrames, ...extraFrames]);
  const decomposedQuestions = uniq([
    ...base.decomposedQuestions,
    ...extraFrames.map((frame) => 'How does ' + frame.name + ' change the answer to: ' + objective + '?'),
  ]).slice(0, 8);
  const ambiguities = base.ambiguities.length > 0 ? base.ambiguities : [{
    issue: 'llm-default-semantic-coverage',
    candidates: base.topics.slice(0, 3),
    resolutionHint: 'expand the semantic frame and collect corroborating evidence before narrowing',
    confidence: 0.68,
  }];
  return {
    ...base,
    semanticFrames,
    decomposedQuestions,
    ambiguities,
    confidence: clamp(base.confidence + 0.18),
    warnings: uniq([...(base.warnings ?? []), 'llm-default-semantic']),
  };
}

export const DEFAULT_SEMANTIC_NLU_PROVIDER: SemanticNluProvider = {
  name: 'llm-semantic-bootstrap',
  async extract({ objective, context }) {
    return semanticBootstrapNlu(objective, context);
  },
};

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asConstraint(value: unknown): SearchConstraint | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const field = record.field;
  const operator = record.operator;
  const confidence = finiteNumber(record.confidence);
  if (field !== 'time' && field !== 'source' && field !== 'domain' && field !== 'format' && field !== 'exclusion' && field !== 'quality' && field !== 'privacy') return null;
  if (operator !== 'must' && operator !== 'should' && operator !== 'must-not') return null;
  if (typeof record.value !== 'string' || confidence === null) return null;
  return { field, operator, value: record.value, confidence: clamp(confidence) };
}

function asSourcePrior(value: unknown): SourcePrior | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const weight = finiteNumber(record.weight);
  if (typeof record.source !== 'string' || typeof record.reason !== 'string' || weight === null) return null;
  return { source: record.source, weight: clamp(weight), reason: record.reason };
}

function asSemanticFrame(value: unknown): SemanticFrame | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const confidence = finiteNumber(record.confidence);
  if (typeof record.name !== 'string' || typeof record.description !== 'string' || confidence === null) return null;
  const slots = record.slots && typeof record.slots === 'object' && !Array.isArray(record.slots) ? record.slots as Record<string, unknown> : {};
  return {
    name: record.name,
    description: record.description,
    confidence: clamp(confidence),
    slots: Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, Array.isArray(value) ? value.map(String) : [String(value)]])),
  };
}

function asAmbiguity(value: unknown): IntentAmbiguity | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const confidence = finiteNumber(record.confidence);
  if (typeof record.issue !== 'string' || typeof record.resolutionHint !== 'string' || confidence === null) return null;
  return { issue: record.issue, candidates: Array.isArray(record.candidates) ? record.candidates.map(String) : [], resolutionHint: record.resolutionHint, confidence: clamp(confidence) };
}

function asNluOutput(value: unknown): SemanticNluOutput | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const freshness = record.freshness;
  const focus = record.focus;
  const trustMode = record.trustMode;
  const hopBudget = finiteNumber(record.hopBudget);
  const confidence = finiteNumber(record.confidence);
  if (typeof record.semanticQuery !== 'string') return null;
  if (freshness !== 'historical' && freshness !== 'recent' && freshness !== 'live') return null;
  if (focus !== 'semantic' && focus !== 'trust' && focus !== 'multi-hop' && focus !== 'factual' && focus !== 'diagnostic' && focus !== 'exploratory') return null;
  if (trustMode !== 'official-first' && trustMode !== 'diverse' && trustMode !== 'broad') return null;
  if (hopBudget === null || confidence === null) return null;
  const constraints = Array.isArray(record.constraints) ? record.constraints.map(asConstraint) : [];
  const sourcePriors = Array.isArray(record.sourcePriors) ? record.sourcePriors.map(asSourcePrior) : [];
  const semanticFrames = Array.isArray(record.semanticFrames) ? record.semanticFrames.map(asSemanticFrame) : [];
  const ambiguities = Array.isArray(record.ambiguities) ? record.ambiguities.map(asAmbiguity) : [];
  if (constraints.some((entry) => entry === null) || sourcePriors.some((entry) => entry === null) || semanticFrames.some((entry) => entry === null) || ambiguities.some((entry) => entry === null)) return null;
  return {
    semanticQuery: record.semanticQuery,
    entities: Array.isArray(record.entities) ? record.entities.map(String).slice(0, 20) : [],
    topics: Array.isArray(record.topics) ? record.topics.map(String).slice(0, 20) : [],
    constraints: constraints.filter((entry): entry is SearchConstraint => entry !== null).slice(0, 20),
    sourcePriors: sourcePriors.filter((entry): entry is SourcePrior => entry !== null).slice(0, 20),
    semanticFrames: semanticFrames.filter((entry): entry is SemanticFrame => entry !== null).slice(0, 8),
    decomposedQuestions: Array.isArray(record.decomposedQuestions) ? record.decomposedQuestions.map(String).slice(0, 8) : [],
    ambiguities: ambiguities.filter((entry): entry is IntentAmbiguity => entry !== null).slice(0, 8),
    freshness,
    focus,
    hopBudget: Math.max(1, Math.min(6, Math.round(hopBudget))),
    trustMode,
    confidence: clamp(confidence),
    warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [],
  };
}

export function buildIntentFromNlu(objective: string, nlu: SemanticNluOutput, provider: string, fallbackUsed: boolean): SearchIntent {
  const normalizedObjective = objective.trim();
  const sourceHints = uniq(nlu.sourcePriors.map((prior) => prior.source).filter((source): source is SearchSource => source === 'web' || source === 'realtime-web' || source === 'scholar' || source === 'github' || source === 'memory' || source === 'email' || source === 'calendar' || source === 'filesystem' || source === 'integration'));
  const querySeeds = uniq([nlu.semanticQuery, ...nlu.entities.map((entity) => `${entity} ${nlu.topics[0] ?? ''}`.trim()), ...nlu.topics.map((topic) => `${topic} ${nlu.entities[0] ?? ''}`.trim())]).slice(0, 6);
  const evidenceTerms = uniq([...nlu.entities, ...nlu.topics, ...words(`${normalizedObjective} ${nlu.semanticQuery}`)]).slice(0, 16);
  const sessionKey = stableHash(`${nlu.semanticQuery}|${sourceHints.join(',')}|${nlu.freshness}|${nlu.focus}|${nlu.hopBudget}|${nlu.trustMode}`);
  return {
    objective: normalizedObjective,
    normalizedObjective,
    semanticQuery: nlu.semanticQuery,
    entities: nlu.entities,
    topics: nlu.topics,
    constraints: nlu.constraints,
    sourceHints: sourceHints.length ? sourceHints : ['web'],
    sourcePriors: nlu.sourcePriors.length ? nlu.sourcePriors : sourcePriorsFor(['web'], nlu.freshness, nlu.focus),
    freshness: nlu.freshness,
    focus: nlu.focus,
    hopBudget: nlu.hopBudget,
    trustMode: nlu.trustMode,
    querySeeds,
    evidenceTerms,
    sessionKey,
    semanticFrames: nlu.semanticFrames,
    decomposedQuestions: nlu.decomposedQuestions,
    ambiguities: nlu.ambiguities,
    nlu: { provider, confidence: nlu.confidence, fallbackUsed, warnings: nlu.warnings ?? [] },
  };
}

export function understandSearchIntent(objective: string, context: Record<string, unknown> = {}): SearchIntent {
  return buildIntentFromNlu(objective, semanticBootstrapNlu(objective, context), DEFAULT_SEMANTIC_NLU_PROVIDER.name, false);
}

export async function understandSearchIntentWithNlu(objective: string, context: Record<string, unknown> = {}, provider?: SemanticNluProvider): Promise<SearchIntent> {
  const fallback = semanticBootstrapNlu(objective, context);
  if (!provider) return buildIntentFromNlu(objective, fallback, DEFAULT_SEMANTIC_NLU_PROVIDER.name, false);
  try {
    const extracted = asNluOutput(await provider.extract({ objective, context, schema: SEMANTIC_NLU_SCHEMA }));
    if (!extracted) return buildIntentFromNlu(objective, { ...fallback, warnings: ['invalid-llm-structured-output'] }, provider.name, true);
    const merged = { ...fallback, ...extracted, warnings: uniq([...(extracted.warnings ?? []), ...(extracted.confidence < 0.45 ? ['low-llm-confidence'] : [])]) };
    return buildIntentFromNlu(objective, merged, provider.name, false);
  } catch (error) {
    return buildIntentFromNlu(objective, { ...fallback, warnings: ['llm-nlu-error:' + (error instanceof Error ? error.message : 'unknown')] }, provider.name, true);
  }
}

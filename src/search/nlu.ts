import type { ConnectionView } from '../connections/types.ts';
import { extractWithDefaultProviderSync } from '../llm-bridge';
import { getRuntimeServices } from '../runtime/services.ts';
import type { IntentAmbiguity, SearchConstraint, SearchFocus, SearchFreshness, SearchIntent, SearchSource, SemanticFrame, SourcePrior, TrustMode } from './types.ts';
import { clamp, normalize, stableHash, uniq, words } from './utils.ts';

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

type ExternalSemanticBackend = 'openai' | 'anthropic' | 'ollama';

type ResolvedSemanticConnection = {
  provider: ExternalSemanticBackend;
  connection: ConnectionView;
  model: string;
  baseUrl: string;
  token?: string;
};

function firstString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function readContextString(context: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = context[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readSecretString(connection: ConnectionView, keys: string[]): string {
  for (const key of keys) {
    const secret = connection.secrets?.[key];
    if (typeof secret === 'string' && secret.trim()) return secret.trim();
    const metadata = connection.metadata?.[key];
    if (typeof metadata === 'string' && metadata.trim()) return metadata.trim();
  }
  return '';
}

function normalizeBackend(value: unknown): ExternalSemanticBackend | null {
  const normalized = firstString(value).toLowerCase();
  if (normalized === 'openai' || normalized === 'anthropic' || normalized === 'ollama') return normalized;
  return null;
}

function backendFromContext(context: Record<string, unknown>): ExternalSemanticBackend | null {
  return normalizeBackend(
    context.llmProvider ??
    context.semanticProvider ??
    context.modelProvider ??
    context.provider ??
    context.backend,
  );
}

function buildSemanticPrompt(objective: string, context: Record<string, unknown>, schema: Record<string, unknown>): string {
  const contextText = bundle(objective, context);
  return [
    'Return JSON only. Do not include markdown, commentary, or code fences.',
    'Resolve the user objective into the requested semantic schema.',
    'Objective:',
    objective.trim(),
    'Context:',
    contextText,
    'Schema:',
    JSON.stringify(schema),
  ].join('
');
}

function parseSemanticResponse(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('empty semantic response');
    try {
      return JSON.parse(trimmed);
    } catch {
      return { semanticQuery: trimmed };
    }
  }
  return value;
}

async function fetchJson<T>(url: string, init: RequestInit, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const raw = await response.text();
      if (!response.ok) {
        if (attempt < attempts && [429, 500, 502, 503, 504].includes(response.status)) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          continue;
        }
        throw new Error('semantic provider request failed with ' + response.status + ': ' + raw);
      }
      return raw ? JSON.parse(raw) as T : ({} as T);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('semantic provider request failed');
}

function resolveConnectionSettings(provider: ExternalSemanticBackend, connection: ConnectionView, context: Record<string, unknown>): ResolvedSemanticConnection {
  const baseUrl = readContextString(context, ['llmBaseUrl', 'baseUrl', 'endpoint']) || readSecretString(connection, ['baseUrl', 'baseURL', 'endpoint']) || (provider === 'openai' ? 'https://api.openai.com/v1' : provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'http://127.0.0.1:11434');
  const model = readContextString(context, ['llmModel', 'model']) || readSecretString(connection, ['model']) || (provider === 'openai' ? 'gpt-4o-mini' : provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'llama3.1');
  const token = readContextString(context, ['llmApiKey', 'apiKey', 'token']) || readSecretString(connection, ['apiKey', 'accessToken', 'token', 'bearerToken']);
  return { provider, connection, model, baseUrl, token: token || undefined };
}

async function resolveSemanticConnection(input: { objective: string; context: Record<string, unknown> }): Promise<ResolvedSemanticConnection> {
  const manager = getRuntimeServices().connectionManager;
  const preferred = backendFromContext(input.context);
  const candidates: ExternalSemanticBackend[] = preferred ? [preferred, ...(['openai', 'anthropic', 'ollama'] as ExternalSemanticBackend[]).filter((provider) => provider !== preferred)] : ['openai', 'anthropic', 'ollama'];

  for (const provider of candidates) {
    const selector: Record<string, unknown> = { provider };
    const connectionId = readContextString(input.context, ['llmConnectionId', 'connectionId', 'semanticConnectionId']);
    const accountId = readContextString(input.context, ['llmAccountId', 'accountId', 'semanticAccountId']);
    const label = readContextString(input.context, ['llmLabel', 'connectionLabel', 'semanticLabel']);
    if (connectionId) selector.connectionId = connectionId;
    if (accountId) selector.accountId = accountId;
    if (label) selector.label = label;

    const connection = await manager.getConnection(selector as any, { includeSecrets: true, autoRefresh: true });
    if (!connection?.secrets) continue;
    return resolveConnectionSettings(provider, connection, input.context);
  }

  throw new Error('no semantic llm connection available for openai, anthropic, or ollama');
}

async function invokeSemanticProvider(input: { objective: string; context: Record<string, unknown>; schema: Record<string, unknown> }): Promise<unknown> {
  const resolved = await resolveSemanticConnection(input);
  const prompt = buildSemanticPrompt(input.objective, input.context, input.schema);

  if (resolved.provider === 'openai') {
    const response = await fetchJson<{ choices?: Array<{ message?: { content?: string } }> }>(
      resolved.baseUrl.replace(/\/$/, '') + '/chat/completions',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + (resolved.token ?? ''),
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: resolved.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are a semantic intent planner. Return JSON only.' },
            { role: 'user', content: prompt },
          ],
        }),
      },
    );
    return parseSemanticResponse(response.choices?.[0]?.message?.content ?? response);
  }

  if (resolved.provider === 'anthropic') {
    const response = await fetchJson<{ content?: Array<{ type?: string; text?: string }> }>(
      resolved.baseUrl.replace(/\/$/, '') + '/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': resolved.token ?? '',
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: resolved.model,
          max_tokens: 1024,
          temperature: 0,
          messages: [
            { role: 'user', content: prompt },
          ],
        }),
      },
    );
    const text = (response.content ?? []).map((item) => item.text ?? '').join('').trim();
    return parseSemanticResponse(text || response);
  }

  const response = await fetchJson<{ message?: { content?: string }; response?: string }>(
    resolved.baseUrl.replace(/\/$/, '') + '/api/chat',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: resolved.model,
        stream: false,
        messages: [
          { role: 'system', content: 'You are a semantic intent planner. Return JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    },
  );
  return parseSemanticResponse(response.message?.content ?? response.response ?? response);
}

function bundle(objective: string, context: Record<string, unknown>): string {
  const contextText = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
  return [objective.trim(), contextText].filter(Boolean).join('\n');
}

function extractEntities(text: string): string[] {
  const matches = text.match(/(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+|[A-Z]{2,}(?:-[A-Z0-9]+)?|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/\S+|\b[a-z0-9_.-]+\/[a-z0-9_.-]+\b)/gi) ?? [];
  return uniq(matches.map((value) => value.replace(/[),.;]+$/g, ''))).slice(0, 16);
}

function extractTopics(text: string, entities: string[]): string[] {
  const patterns = text.match(/\b(?:trust model|semantic decomposition|proposition reasoning|contradiction resolution|entailment|source reliability|freshness|budget|policy rewrite|forecast|intent|evidence|corroboration)\b/gi) ?? [];
  const lexical = words(text).filter((word) => !entities.some((entity) => normalize(entity).includes(word)) && !/^(the|and|for|with|from|that|this|into|about|need|want|help|find|search|please|what|who|when|where|how|why)$/i.test(word));
  return uniq([...patterns.map((value) => value.toLowerCase()), ...lexical]).slice(0, 16);
}

function detectFreshness(text: string): SearchFreshness {
  if (/(live|latest|current|today|now|breaking|fresh|new|real[- ]?time|as of|at present)/i.test(text)) return 'live';
  if (/(recent|update|trend|this week|this month|last \d+ days|latest release|newly|recently)/i.test(text)) return 'recent';
  return 'historical';
}

function detectFocus(text: string): SearchFocus {
  if (/(why|cause|root|diagnos|debug|fix|failure|issue|bug|contradict|conflict|inconsisten)/i.test(text)) return 'diagnostic';
  if (/(trust|verify|reliable|official|source|citation|evidence|provenance|corroborat|authentic)/i.test(text)) return 'trust';
  if (/(multi-hop|chain|deep|fuse|combine|correlat|synthesize|entail|proof|proposition|logic)/i.test(text)) return 'multi-hop';
  if (/(discover|explore|brainstorm|survey|map the space|scan the landscape)/i.test(text)) return 'exploratory';
  if (/(what|who|where|when|how|definition|explain|summarize|compare)/i.test(text)) return 'semantic';
  return 'factual';
}

function inferSourceHints(text: string): SearchSource[] {
  const lower = text.toLowerCase();
  const hints: SearchSource[] = [];
  if (/(live|latest|current|breaking|now|today|real[- ]?time|fresh)/.test(lower)) hints.push('realtime-web');
  if (/(github|repo|issue|pr|pull request|commit|code|diff|branch)/.test(lower)) hints.push('github');
  if (/(paper|study|journal|citation|scholar|arxiv|doi|research|experiment)/.test(lower)) hints.push('scholar');
  if (/(email|thread|inbox|message|reply|conversation|cc|bcc)/.test(lower)) hints.push('email');
  if (/(calendar|meeting|schedule|availability|event|slot)/.test(lower)) hints.push('calendar');
  if (/(file|filesystem|folder|directory|path|diff|local)/.test(lower)) hints.push('filesystem');
  if (/(integration|notion|linear|todoist|slack|vercel|api|webhook)/.test(lower)) hints.push('integration');
  if (/(memory|profile|preference|behavior|style|history|session|trajectory)/.test(lower)) hints.push('memory');
  return uniq(hints.length ? hints : ['web']);
}

function buildConstraints(text: string): SearchConstraint[] {
  const constraints: SearchConstraint[] = [];
  if (/(official|primary source|first[- ]party|authoritative|original)/i.test(text)) constraints.push({ field: 'quality', operator: 'must', value: 'primary-or-official-source', confidence: 0.92 });
  if (/(exclude|without|not from|avoid|do not use|no source)/i.test(text)) constraints.push({ field: 'exclusion', operator: 'must-not', value: 'explicitly-excluded-sources-or-topics', confidence: 0.74 });
  if (/(today|latest|current|live|this week|last \d+ days|recent|now)/i.test(text)) constraints.push({ field: 'time', operator: 'must', value: detectFreshness(text), confidence: 0.9 });
  if (/(private|confidential|internal|sensitive|personal data|pii)/i.test(text)) constraints.push({ field: 'privacy', operator: 'must', value: 'privacy-sensitive-search', confidence: 0.86 });
  if (/(pdf|table|csv|json|api|documentation|docs|code|source)/i.test(text)) constraints.push({ field: 'format', operator: 'should', value: 'preferred-format-inferred-from-objective', confidence: 0.66 });
  for (const domain of [...text.matchAll(/\bsite:([a-z0-9.-]+\.[a-z]{2,})/gi)].map((match) => match[1])) {
    constraints.push({ field: 'domain', operator: 'must', value: domain, confidence: 0.97 });
  }
  return constraints;
}

function inferHopBudget(objective: string, context: Record<string, unknown>, focus: SearchFocus): number {
  const text = `${objective} ${JSON.stringify(context)}`;
  const connectiveCount = Math.max(0, text.split(/\b(and|or|with|via|through|between|from|to|versus|vs|after|before)\b/i).length - 1);
  const structureCount = Object.keys(context).length + (Array.isArray(context.sources) ? (context.sources as unknown[]).length : 0);
  const focusBoost = focus === 'multi-hop' || focus === 'diagnostic' || focus === 'trust' ? 1 : 0;
  return Math.max(1, Math.min(6, 1 + Math.min(4, Math.ceil(connectiveCount / 2) + Math.floor(structureCount / 4)) + focusBoost));
}

function inferTrustMode(text: string): TrustMode {
  if (/(official|verify|reliable|trust|citation|source|provenance|audit|proof)/i.test(text)) return 'official-first';
  if (/(compare|mix|blend|diverse|cross-source|corroborat|independent)/i.test(text)) return 'diverse';
  return 'broad';
}

function inferSemanticQuery(objective: string, entities: string[], topics: string[]): string {
  const terms = uniq([...entities.slice(0, 4), ...topics.slice(0, 6), ...words(objective)]).filter((token) => token.length > 1);
  return terms.join(' ').trim() || objective.trim();
}

function inferQuestions(objective: string, entities: string[], topics: string[], focus: SearchFocus): string[] {
  const subject = entities[0] ?? topics[0] ?? objective;
  const questions = [`What evidence directly answers: ${objective}?`];
  if (focus === 'trust' || focus === 'multi-hop') questions.push(`Which independent sources corroborate ${subject}?`);
  if (focus === 'diagnostic' || focus === 'multi-hop') questions.push(`Which semantic claims about ${subject} are in tension and need reconciliation?`);
  if (focus === 'exploratory') questions.push(`What adjacent angles or missing assumptions would narrow ${subject}?`);
  return questions.slice(0, 6);
}

function inferAmbiguities(objective: string, entities: string[], topics: string[]): IntentAmbiguity[] {
  if (entities.length > 0 || topics.length > 2) return [];
  return [{ issue: 'underspecified-subject', candidates: [objective], resolutionHint: 'collect broader semantic evidence and disambiguate the target before narrowing', confidence: 0.58 }];
}

function semanticFrameName(focus: SearchFocus): string {
  switch (focus) {
    case 'diagnostic': return 'causal-diagnosis';
    case 'trust': return 'evidence-verification';
    case 'multi-hop': return 'compositional-research';
    case 'exploratory': return 'exploratory-sensemaking';
    case 'semantic': return 'semantic-retrieval';
    default: return 'information-seeking';
  }
}

function inferSemanticFrames(objective: string, entities: string[], topics: string[], focus: SearchFocus): SemanticFrame[] {
  const actionSlots = words(objective).filter((word) => /^(verify|compare|find|explain|diagnose|monitor|forecast|rewrite|prove|trace|resolve|synthesize)$/i.test(word)).slice(0, 6);
  return [{
    name: semanticFrameName(focus),
    description: `Deep semantic frame inferred for ${focus} search objective`,
    confidence: clamp(0.68 + (focus === 'multi-hop' || focus === 'trust' || focus === 'diagnostic' ? 0.12 : 0)),
    slots: { entities: entities.slice(0, 8), topics: topics.slice(0, 8), actions: actionSlots },
  }];
}

function inferSourcePriors(hints: SearchSource[], freshness: SearchFreshness, focus: SearchFocus, objective: string): SourcePrior[] {
  const seed = uniq([...hints, 'web', 'scholar', 'github'] as SearchSource[]);
  return seed.map((source) => {
    const base = hints.includes(source) ? 0.7 : 0.46;
    const freshnessBoost = source === 'realtime-web' && freshness === 'live' ? 0.18 : source === 'web' && freshness === 'recent' ? 0.05 : 0;
    const focusBoost = source === 'scholar' && focus === 'trust' ? 0.16 : source === 'github' && /code|repo|commit|issue|pull request/i.test(objective) ? 0.1 : 0;
    return { source, weight: clamp(base + freshnessBoost + focusBoost), reason: hints.includes(source) ? 'semantic-source-prior' : 'coverage-backstop' };
  }).sort((left, right) => right.weight - left.weight);
}

function estimateConfidence(objective: string, context: Record<string, unknown>, entities: string[], topics: string[], constraints: SearchConstraint[], sourcePriors: SourcePrior[]): number {
  const structure = clamp(0.44 + Math.min(0.22, entities.length * 0.04) + Math.min(0.15, topics.length * 0.02) + Math.min(0.12, constraints.length * 0.03) + Math.min(0.12, sourcePriors.length * 0.015));
  const contextClarity = Object.keys(context).length > 0 ? 0.08 : 0;
  const lexicalCoverage = Math.min(0.18, uniq(words(bundle(objective, context))).length / 120);
  return clamp(structure + contextClarity + lexicalCoverage);
}

function localSemanticExtraction(objective: string, context: Record<string, unknown> = {}): SemanticNluOutput {
  const text = bundle(objective, context);
  const entities = uniq([...extractEntities(text), ...(Array.isArray(context.entities) ? (context.entities as unknown[]).map(String) : [])]).slice(0, 16);
  const freshness = detectFreshness(text);
  const focus = detectFocus(text);
  const sourceHints = inferSourceHints(text);
  const topics = extractTopics(text, entities);
  const constraints = buildConstraints(text);
  const sourcePriors = inferSourcePriors(sourceHints, freshness, focus, objective);
  const semanticFrames = inferSemanticFrames(objective, entities, topics, focus);
  const decomposedQuestions = inferQuestions(objective, entities, topics, focus);
  const ambiguities = inferAmbiguities(objective, entities, topics);
  return {
    semanticQuery: inferSemanticQuery(objective, entities, topics),
    entities,
    topics,
    constraints,
    sourcePriors,
    semanticFrames,
    decomposedQuestions,
    ambiguities,
    freshness,
    focus,
    hopBudget: inferHopBudget(objective, context, focus),
    trustMode: inferTrustMode(text),
    confidence: estimateConfidence(objective, context, entities, topics, constraints, sourcePriors),
    warnings: [],
  };
}

function uniqueFrames(frames: SemanticFrame[]): SemanticFrame[] {
  const seen = new Set<string>();
  const out: SemanticFrame[] = [];
  for (const frame of frames) {
    if (seen.has(frame.name)) continue;
    seen.add(frame.name);
    out.push(frame);
  }
  return out;
}

function normalizeSemanticOutput(output: SemanticNluOutput): SemanticNluOutput {
  return {
    ...output,
    semanticQuery: output.semanticQuery.trim(),
    entities: uniq(output.entities).slice(0, 20),
    topics: uniq(output.topics).slice(0, 20),
    constraints: output.constraints.slice(0, 20),
    sourcePriors: output.sourcePriors.slice(0, 20),
    semanticFrames: uniqueFrames(output.semanticFrames).slice(0, 8),
    decomposedQuestions: uniq(output.decomposedQuestions).slice(0, 8),
    ambiguities: output.ambiguities.slice(0, 8),
    hopBudget: Math.max(1, Math.min(6, Math.round(output.hopBudget))),
    confidence: clamp(output.confidence),
    warnings: uniq(output.warnings ?? []),
  };
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asConstraint(value: unknown): SearchConstraint | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const confidence = finiteNumber(record.confidence);
  if (confidence === null) return null;
  if (record.field !== 'time' && record.field !== 'source' && record.field !== 'domain' && record.field !== 'format' && record.field !== 'exclusion' && record.field !== 'quality' && record.field !== 'privacy') return null;
  if (record.operator !== 'must' && record.operator !== 'should' && record.operator !== 'must-not') return null;
  if (typeof record.value !== 'string') return null;
  return { field: record.field, operator: record.operator, value: record.value, confidence: clamp(confidence) };
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

function llmEndpoint(): string | null {
  return (process.env?.POKE_SEMANTIC_NLU_ENDPOINT ?? process.env?.OPENAI_BASE_URL ?? process.env?.OPENAI_API_BASE ?? null) || null;
}

function llmModel(): string {
  return process.env?.POKE_SEMANTIC_NLU_MODEL ?? process.env?.OPENAI_MODEL ?? process.env?.OPENAI_DEFAULT_MODEL ?? 'gpt-4.1-mini';
}

function promptForExtraction(objective: string, context: Record<string, unknown>): string {
  return [
    'Return JSON only.',
    'Extract a deep semantic decomposition of the search objective.',
    'Required fields: semanticQuery, entities, topics, constraints, sourcePriors, semanticFrames, decomposedQuestions, ambiguities, freshness, focus, hopBudget, trustMode, confidence, warnings.',
    'Interpret intents, constraints, source priors, and hop budget from the objective and context.',
    `Objective: ${objective}`,
    `Context: ${JSON.stringify(context)}`,
    `Schema: ${JSON.stringify(SEMANTIC_NLU_SCHEMA)}`,
  ].join('\n');
}

function extractTextFromResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const candidate = choice as Record<string, unknown>;
    if (typeof candidate.message === 'object' && candidate.message && !Array.isArray(candidate.message)) {
      const message = candidate.message as Record<string, unknown>;
      if (typeof message.content === 'string') return message.content;
    }
    if (typeof candidate.text === 'string') return candidate.text;
  }
  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.content === 'string') return entry.content;
      }
    }
  }
  return '';
}

async function invokeSemanticProvider(input: { objective: string; context: Record<string, unknown>; schema: Record<string, unknown> }): Promise<unknown> {
  const resolved = await resolveSemanticConnection(input);
  const prompt = buildSemanticPrompt(input.objective, input.context, input.schema);
  const endpoint = resolved.baseUrl.endsWith('/') ? resolved.baseUrl.slice(0, -1) : resolved.baseUrl;

  if (resolved.provider === 'openai') {
    const response = await fetchJson<{ choices?: Array<{ message?: { content?: string } }> }>(
      endpoint + '/chat/completions',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + (resolved.token ?? ''),
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: resolved.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are a semantic intent planner. Return JSON only.' },
            { role: 'user', content: prompt },
          ],
        }),
      },
    );
    return parseSemanticResponse(response.choices?.[0]?.message?.content ?? response);
  }

  if (resolved.provider === 'anthropic') {
    const response = await fetchJson<{ content?: Array<{ type?: string; text?: string }> }>(
      endpoint + '/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': resolved.token ?? '',
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: resolved.model,
          max_tokens: 1024,
          temperature: 0,
          messages: [
            { role: 'user', content: prompt },
          ],
        }),
      },
    );
    const text = (response.content ?? []).map((item) => item.text ?? '').join('').trim();
    return parseSemanticResponse(text || response);
  }

  const response = await fetchJson<{ message?: { content?: string }; response?: string }>(
    endpoint + '/api/chat',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: resolved.model,
        stream: false,
        messages: [
          { role: 'system', content: 'You are a semantic intent planner. Return JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    },
  );
  return parseSemanticResponse(response.message?.content ?? response.response ?? response);
}

function buildIntentFromNlu(objective: string, nlu: SemanticNluOutput, provider: string, fallbackUsed: boolean): SearchIntent {
  const normalizedObjective = objective.trim();
  const sourceHints = uniq(nlu.sourcePriors.map((prior) => prior.source).filter((source): source is SearchSource => source === 'web' || source === 'realtime-web' || source === 'scholar' || source === 'github' || source === 'memory' || source === 'email' || source === 'calendar' || source === 'filesystem' || source === 'integration'));
  const querySeeds = uniq([nlu.semanticQuery, ...nlu.entities.map((entity) => (entity + ' ' + (nlu.topics[0] ?? '')).trim()), ...nlu.topics.map((topic) => (topic + ' ' + (nlu.entities[0] ?? '')).trim())]).slice(0, 6);
  const evidenceTerms = uniq([...nlu.entities, ...nlu.topics, ...words((normalizedObjective + ' ' + nlu.semanticQuery))]).slice(0, 16);
  const sessionKey = stableHash([nlu.semanticQuery, sourceHints.join(','), nlu.freshness, nlu.focus, String(nlu.hopBudget), nlu.trustMode].join('|'));
  const fallbackConfidence = fallbackUsed ? clamp(nlu.confidence * 0.92) : nlu.confidence;
  return {
    objective: normalizedObjective,
    normalizedObjective,
    semanticQuery: nlu.semanticQuery,
    entities: nlu.entities,
    topics: nlu.topics,
    constraints: nlu.constraints,
    sourceHints: sourceHints.length ? sourceHints : ['web'],
    sourcePriors: nlu.sourcePriors.length ? nlu.sourcePriors : inferSourcePriors(['web'], nlu.freshness, nlu.focus, normalizedObjective),
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
    nlu: {
      provider,
      confidence: fallbackConfidence,
      fallbackUsed,
      warnings: uniq([...(nlu.warnings ?? []), fallbackUsed ? 'heuristic-fallback-used' : 'semantic-provider-used']),
    },
  };
}

export async function understandSearchIntentWithNlu(objective: string, context: Record<string, unknown> = {}, provider?: SemanticNluProvider): Promise<SearchIntent> {
  const activeProvider = provider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  const extracted = asNluOutput(await activeProvider.extract({ objective, context, schema: SEMANTIC_NLU_SCHEMA }));
  if (!extracted) throw new Error('semantic nlu provider returned invalid output');
  return buildIntentFromNlu(objective, normalizeSemanticOutput(extracted), activeProvider.name, false);
}

export function understandSearchIntent(objective: string, context: Record<string, unknown> = {}): SearchIntent {
  const extracted = asNluOutput(extractWithDefaultProviderSync<unknown>({ objective, context, schema: SEMANTIC_NLU_SCHEMA }, './src/search/nlu.ts', 'DEFAULT_LLM_SEMANTIC_NLU_PROVIDER'));
  if (!extracted) throw new Error('semantic nlu provider returned invalid output');
  return buildIntentFromNlu(objective, normalizeSemanticOutput(extracted), DEFAULT_LLM_SEMANTIC_NLU_PROVIDER.name, false);
}

export const DEFAULT_LLM_SEMANTIC_NLU_PROVIDER: SemanticNluProvider = {
  name: 'connection-managed-llm-semantic-nlu',
  async extract(input) {
    return await invokeSemanticProvider(input);
  },
};

export const DEFAULT_SEMANTIC_NLU_PROVIDER = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
export const DEFAULTLLMSEMANTICNLUPROVIDER = DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;

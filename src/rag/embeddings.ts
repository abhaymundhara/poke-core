const DEFAULT_DIMENSION = 40;

export type SemanticSignals = {
  tokens: string[];
  phrases: string[];
  axes: Record<string, number>;
};

const AXES = [
  'relationship', 'thread', 'transactional', 'preference', 'reference', 'calendar', 'filesystem', 'browser',
  'people', 'draft', 'reply', 'followup', 'evidence', 'urgency', 'recency', 'action', 'planning', 'review',
  'history', 'crossSource', 'tone', 'concision', 'finance', 'travel', 'meeting', 'conflict', 'issue', 'document',
  'knowledge', 'workflow', 'signal', 'compaction', 'memory', 'search', 'support', 'identity', 'question', 'decision',
  'priority', 'stability', 'change', 'contact', 'time', 'organization', 'coordination', 'visibility',
] as const;

type Axis = (typeof AXES)[number];
const AXIS_INDEX = Object.fromEntries(AXES.map((axis, index) => [axis, index])) as Record<Axis, number>;

const TOKEN_AXES: Record<string, Array<[Axis, number]>> = {
  relationship: [['relationship', 1], ['people', 0.4], ['history', 0.2], ['contact', 0.3]],
  contact: [['relationship', 0.6], ['contact', 0.7], ['people', 0.15]],
  colleague: [['relationship', 0.65], ['people', 0.25]],
  manager: [['relationship', 0.55], ['people', 0.25], ['organization', 0.15]],
  recruiter: [['relationship', 0.45], ['organization', 0.3], ['contact', 0.2]],
  teammate: [['relationship', 0.6], ['people', 0.3]],
  family: [['relationship', 0.4], ['people', 0.35], ['contact', 0.1]],
  thread: [['thread', 1], ['history', 0.2], ['reply', 0.25]],
  conversation: [['thread', 0.7], ['reply', 0.2], ['workflow', 0.1]],
  email: [['thread', 0.8], ['reply', 0.25], ['search', 0.1]],
  inbox: [['thread', 0.9], ['search', 0.15]],
  reply: [['reply', 1], ['draft', 0.5], ['action', 0.2]],
  draft: [['draft', 1], ['reply', 0.35], ['workflow', 0.1]],
  followup: [['followup', 1], ['relationship', 0.2], ['action', 0.15]],
  meeting: [['meeting', 1], ['calendar', 0.8], ['coordination', 0.25]],
  schedule: [['calendar', 0.85], ['coordination', 0.3], ['time', 0.2]],
  reschedule: [['calendar', 0.95], ['change', 0.35], ['coordination', 0.35]],
  timezone: [['calendar', 0.8], ['time', 0.6]],
  availability: [['calendar', 0.8], ['coordination', 0.3], ['time', 0.2]],
  conflict: [['conflict', 1], ['issue', 0.2], ['calendar', 0.35]],
  booking: [['transactional', 1], ['travel', 0.6]],
  invoice: [['transactional', 1], ['finance', 0.85], ['document', 0.15]],
  receipt: [['transactional', 0.95], ['finance', 0.55]],
  payment: [['transactional', 1], ['finance', 0.9]],
  refund: [['transactional', 1], ['finance', 0.85], ['issue', 0.15]],
  bill: [['transactional', 0.85], ['finance', 0.75]],
  confirmation: [['transactional', 0.75], ['stability', 0.2]],
  subscription: [['transactional', 0.75], ['finance', 0.5]],
  deadline: [['transactional', 0.45], ['urgency', 0.75], ['priority', 0.3]],
  docs: [['reference', 1], ['document', 0.6], ['knowledge', 0.35]],
  guide: [['reference', 0.85], ['knowledge', 0.3], ['review', 0.15]],
  spec: [['reference', 0.9], ['document', 0.55], ['knowledge', 0.4]],
  readme: [['reference', 0.85], ['document', 0.45]],
  policy: [['reference', 0.8], ['stability', 0.25], ['organization', 0.15]],
  architecture: [['reference', 0.55], ['organization', 0.35], ['workflow', 0.2]],
  note: [['reference', 0.35], ['document', 0.25], ['memory', 0.2]],
  memory: [['memory', 1], ['history', 0.4], ['state', 0.2]],
  preference: [['preference', 1], ['tone', 0.3]],
  persona: [['preference', 0.7], ['identity', 0.4]],
  tone: [['tone', 1], ['preference', 0.3]],
  concise: [['concision', 1], ['tone', 0.3]],
  brief: [['concision', 0.9], ['tone', 0.1]],
  detailed: [['review', 0.35], ['document', 0.3], ['knowledge', 0.1]],
  file: [['filesystem', 0.85], ['document', 0.4]],
  folder: [['filesystem', 0.9], ['organization', 0.35]],
  path: [['filesystem', 0.8], ['workflow', 0.2]],
  diff: [['filesystem', 0.85], ['review', 0.35], ['change', 0.2]],
  write: [['workflow', 0.35], ['action', 0.2]],
  read: [['knowledge', 0.3], ['document', 0.2]],
  browser: [['browser', 1], ['visibility', 0.3], ['workflow', 0.1]],
  screenshot: [['browser', 0.8], ['visibility', 0.55]],
  click: [['browser', 0.7], ['action', 0.2]],
  scroll: [['browser', 0.65], ['workflow', 0.1]],
  dom: [['browser', 0.8], ['document', 0.2], ['visibility', 0.2]],
  evidence: [['evidence', 1], ['review', 0.4], ['crossSource', 0.3]],
  source: [['evidence', 0.7], ['crossSource', 0.55]],
  cite: [['evidence', 0.9], ['review', 0.15]],
  audit: [['review', 0.9], ['stability', 0.2]],
  benchmark: [['review', 0.7], ['stability', 0.15]],
  autopilot: [['workflow', 0.45], ['coordination', 0.35], ['signal', 0.2]],
  trigger: [['workflow', 0.4], ['signal', 0.45]],
  checkin: [['coordination', 0.45], ['relationship', 0.15], ['workflow', 0.15]],
  signal: [['signal', 1], ['visibility', 0.3]],
  observe: [['signal', 0.8], ['visibility', 0.2]],
  monitor: [['signal', 0.9], ['visibility', 0.3]],
  compact: [['compaction', 1], ['stability', 0.2]],
  compaction: [['compaction', 1], ['stability', 0.25]],
  urgent: [['urgency', 1], ['priority', 0.4]],
  priority: [['priority', 1], ['urgency', 0.3]],
  stable: [['stability', 1], ['change', 0.1]],
  change: [['change', 1], ['workflow', 0.2]],
  decision: [['decision', 1], ['planning', 0.3]],
  question: [['question', 1]],
  support: [['support', 1], ['relationship', 0.15]],
};

const PHRASE_AXES: Array<{ pattern: RegExp; axes: Array<[Axis, number]> }> = [
  { pattern: /\bfollow[- ]?up\b/i, axes: [['followup', 1], ['relationship', 0.2]] },
  { pattern: /\bcheck[- ]?in\b/i, axes: [['coordination', 0.4], ['workflow', 0.2]] },
  { pattern: /\bthread history\b/i, axes: [['thread', 0.65], ['history', 0.5]] },
  { pattern: /\brelationship history\b/i, axes: [['relationship', 0.65], ['history', 0.5]] },
  { pattern: /\bstale transactional\b/i, axes: [['transactional', 0.45], ['compaction', 0.65]] },
  { pattern: /\bcross[- ]source\b/i, axes: [['crossSource', 1], ['evidence', 0.25]] },
  { pattern: /\bevidence retrieval\b/i, axes: [['evidence', 1], ['search', 0.3], ['crossSource', 0.2]] },
  { pattern: /\bcalendar conflict\b/i, axes: [['calendar', 0.7], ['conflict', 0.7]] },
  { pattern: /\bdraft reply\b/i, axes: [['draft', 0.65], ['reply', 0.65], ['workflow', 0.1]] },
  { pattern: /\btoken budget\b/i, axes: [['compaction', 0.8], ['stability', 0.15]] },
  { pattern: /\bvector search\b/i, axes: [['search', 0.8], ['knowledge', 0.3]] },
  { pattern: /\bsemantic rerank(?:er)?\b/i, axes: [['review', 0.7], ['evidence', 0.25]] },
  { pattern: /\bself audit\b/i, axes: [['review', 0.8], ['stability', 0.15]] },
];

function axisAdd(vector: number[], axis: Axis, amount: number) {
  vector[AXIS_INDEX[axis]] += amount;
}

function normalizeToken(token: string): string {
  let value = token.toLowerCase().trim();
  value = value.replace(/^['"`]+|['"`]+$/g, '');
  value = value.replace(/(?:'s|’s)$/u, '');
  if (value.length > 5) {
    if (value.endsWith('ies')) value = `${value.slice(0, -3)}y`;
    else if (value.endsWith('ing')) value = value.slice(0, -3);
    else if (value.endsWith('ed')) value = value.slice(0, -2);
    else if (value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1);
  }
  return value;
}

function isLikelyName(token: string): boolean {
  return /^[A-Z][a-z]{2,}$/.test(token);
}

export function tokenizeSemantic(text: string): string[] {
  return text.normalize('NFKC').split(/[^\p{L}\p{N}]+/gu).map(normalizeToken).filter((token) => token.length > 1);
}

export function extractSemanticSignals(text: string): SemanticSignals {
  const tokens = tokenizeSemantic(text);
  const phrases: string[] = [];
  const axes: Record<string, number> = {};
  const lower = text.toLowerCase();

  for (const { pattern, axes: phraseAxes } of PHRASE_AXES) {
    if (!pattern.test(lower)) continue;
    phrases.push(pattern.source.replace(/\\b/g, '').replace(/\\/g, ''));
    for (const [axis, weight] of phraseAxes) axes[axis] = (axes[axis] ?? 0) + weight;
  }

  if (/\?/.test(text)) axes.question = (axes.question ?? 0) + 0.3;
  if (/\b(please|kindly|could you|would you|can you)\b/i.test(text)) axes.workflow = (axes.workflow ?? 0) + 0.12;
  if (/\b(urgent|asap|today|tomorrow|soon|this week)\b/i.test(text)) axes.urgency = (axes.urgency ?? 0) + 0.18;
  if (/\b(save|preserve|keep|remember|compact)\b/i.test(text)) axes.memory = (axes.memory ?? 0) + 0.16;
  if (/\b(reply|draft|respond|follow[- ]?up)\b/i.test(text)) axes.reply = (axes.reply ?? 0) + 0.14;
  if (/\b(calendar|meeting|schedule|availability|timezone)\b/i.test(text)) axes.calendar = (axes.calendar ?? 0) + 0.12;
  if (/\b(thread|email|mail|inbox)\b/i.test(text)) axes.thread = (axes.thread ?? 0) + 0.12;
  if (/\b(relationship|contact|manager|colleague|recruiter|friend|family)\b/i.test(text)) axes.relationship = (axes.relationship ?? 0) + 0.12;
  if (/\b(file|folder|path|directory|diff|write|read|export|scan)\b/i.test(text)) axes.filesystem = (axes.filesystem ?? 0) + 0.12;
  if (/\b(browser|screenshot|click|scroll|dom|page|web)\b/i.test(text)) axes.browser = (axes.browser ?? 0) + 0.12;
  if (/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(text) || tokens.some(isLikelyName)) axes.people = (axes.people ?? 0) + 0.12;

  for (const token of tokens) {
    const mappings = TOKEN_AXES[token];
    if (mappings) {
      for (const [axis, weight] of mappings) axes[axis] = (axes[axis] ?? 0) + weight;
      continue;
    }

    if (token.length > 8) axes.knowledge = (axes.knowledge ?? 0) + 0.03;
    if (token.includes('meet') || token.includes('sched')) axes.calendar = (axes.calendar ?? 0) + 0.04;
    if (token.includes('mail') || token.includes('thread') || token.includes('reply')) axes.thread = (axes.thread ?? 0) + 0.04;
    if (token.includes('file') || token.includes('path') || token.includes('folder')) axes.filesystem = (axes.filesystem ?? 0) + 0.04;
    if (token.includes('follow')) axes.followup = (axes.followup ?? 0) + 0.04;
  }

  return { tokens, phrases, axes };
}

export class SemanticEmbeddingModel {
  readonly dimension = DEFAULT_DIMENSION;

  embedText(text: string): number[] {
    const signals = extractSemanticSignals(text);
    const vector = Array.from({ length: this.dimension }, () => 0);
    const tokenCount = Math.max(1, signals.tokens.length);

    for (const [axisName, amount] of Object.entries(signals.axes)) {
      const index = AXIS_INDEX[axisName as Axis];
      if (index !== undefined) vector[index] += amount;
    }

    const hasRecentCue = /\b(latest|recent|new|fresh|now|today)\b/i.test(text);
    const hasStableCue = /\b(keep|preserve|stable|durable|reliable)\b/i.test(text);
    const hasReviewCue = /\b(review|audit|trace|verify|evidence)\b/i.test(text);

    axisAdd(vector, 'recency', hasRecentCue ? 0.18 : 0);
    axisAdd(vector, 'stability', hasStableCue ? 0.18 : 0);
    axisAdd(vector, 'review', hasReviewCue ? 0.16 : 0);
    axisAdd(vector, 'workflow', Math.min(0.18, tokenCount * 0.003));
    axisAdd(vector, 'priority', /\b(best|priority|important|top)\b/i.test(text) ? 0.12 : 0);
    axisAdd(vector, 'visibility', /\b(visible|inspect|trace|evidence|audit)\b/i.test(text) ? 0.14 : 0);
    axisAdd(vector, 'search', /\b(search|find|retriev|lookup|locate)\b/i.test(text) ? 0.14 : 0);
    axisAdd(vector, 'crossSource', signals.phrases.length > 0 ? 0.12 : 0);

    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }
}

export const defaultSemanticEmbeddingModel = new SemanticEmbeddingModel();

export function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < size; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1;
  return dot / denominator;
}

export function vectorMagnitude(vector: number[]): number {
  return Math.hypot(...vector);
}

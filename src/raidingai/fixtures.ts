import { createHash, randomUUID } from 'node:crypto';
import { buildBehavioralModel } from '../memory/behavioral-theory';
import { BehavioralLearningLayer, type BehavioralObservation, type BehavioralPattern } from '../memory/behavioral-learning';
import { createDriftingClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { VisionFrame } from '../skills/computer-use';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';
import type { UserBehaviorTheory } from '../memory/behavioral-theory';

export type RaidingAiScenario = {
  seed: string;
  now: number;
  label: string;
  taskHint: string;
  theory: UserBehaviorTheory;
  computerUse: { frames: VisionFrame[]; keys: string[]; fallbackSelectors: string[] };
  deepPrimitives: {
    threadA: ThreadIdentityInput;
    threadB: ThreadIdentityInput;
    timezone: { local: string; timeZone: string; expectedUtc: string };
    attendees: Attendee[];
    recurrence: RecurrenceSpec;
  };
  memory: { facts: MemoryFact[]; episodes: EpisodicMemoryItem[] };
  traces: Array<{
    id: string;
    kind: 'computer-use' | 'thread-identity' | 'memory' | 'planner';
    description: string;
    frames?: VisionFrame[];
    fallbackSelectors?: string[];
    threadInputs?: ThreadIdentityInput[];
    workingFacts?: MemoryFact[];
    episodicItems?: EpisodicMemoryItem[];
    objective?: string;
    expected: Record<string, boolean | number | string>;
  }>;
};

type Rng = () => number;

type NodeSpec = { role: string; label: string; name: string; attrs: Record<string, string>; children: NodeSpec[] };

function hashText(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function seedFromInput(input?: { seed?: string; taskHint?: string; now?: number }): string {
  return hashText(String(input?.seed ?? ''), String(input?.taskHint ?? ''), String(input?.now ?? Date.now()), randomUUID()).slice(0, 24);
}

function createRng(seed: string): Rng {
  let state = parseInt(seed.slice(0, 8), 16) || 0x6d2b79f5;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function token(seed: string, scope: string, index = 0): string {
  return hashText(seed, scope, String(index)).slice(0, 10);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([:;,.])\s*/g, '$1 ').trim();
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((entry) => entry.length > 2);
}

function buildBootstrapObservations(seed: string, rng: Rng): BehavioralObservation[] {
  const channels = ['tone', 'channel', 'relationship', 'preference', 'signal', 'habit'] as const;
  return channels.map((category, index) => {
    const subject = token(seed, 'subject', index);
    const value = [token(seed, 'value', index), token(seed, 'value', index + 1), token(seed, 'value', index + 2)].join(' ');
    return {
      subject,
      value,
      category,
      source: 'scenario-' + token(seed, 'source', index),
      confidence: Number((0.72 + rng() * 0.23).toFixed(3)),
      observedAt: Date.now() - (index + 1) * 17_000,
      evidence: [subject, value, token(seed, 'evidence', index)],
      context: { seed, index },
    };
  });
}

function buildBootstrapFacts(observations: BehavioralObservation[], seed: string, now: number): MemoryFact[] {
  return observations.map((observation, index) => ({
    key: hashText(seed, observation.subject, observation.category, String(index)).slice(0, 20),
    value: `${observation.subject} ${observation.value}`.trim(),
    confidence: observation.confidence,
    source: observation.source,
    updatedAt: now - index * 11_000,
  }));
}

function buildBootstrapPatterns(observations: BehavioralObservation[]): BehavioralPattern[] {
  return observations.map((observation, index) => ({
    key: hashText(observation.subject, observation.value, String(index)).slice(0, 24),
    category: observation.category,
    subject: observation.subject,
    value: observation.value,
    evidenceCount: observation.evidence?.length ?? 0,
    sourceCount: 1,
    confidence: observation.confidence,
    firstObservedAt: observation.observedAt - 42_000,
    lastObservedAt: observation.observedAt,
    sources: [observation.source],
    examples: observation.evidence?.slice(0, 3) ?? [],
    contradictionScore: Number((0.04 + (index % 3) * 0.03).toFixed(3)),
  }));
}

function theoryWords(theory: UserBehaviorTheory): string[] {
  return [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)].flatMap(words);
}

function phraseFromTheory(theory: UserBehaviorTheory, seed: string, scope: string, index: number, min = 4, max = 7): string {
  const pool = theoryWords(theory);
  const count = Math.max(min, Math.min(max, 3 + (parseInt(token(seed, scope, index).slice(0, 2), 16) % (max - min + 1))));
  const parts: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const next = pool[(parseInt(token(seed, scope, index + i).slice(0, 2), 16) + i) % pool.length];
    if (next && !parts.includes(next)) parts.push(next);
  }
  const hashed = token(seed, scope, index).match(/.{1,4}/g)?.slice(0, 2) ?? [];
  return cleanText([...parts, ...hashed].join(' '));
}

function buildTheory(seed: string, now: number, rng: Rng): UserBehaviorTheory {
  const observations = buildBootstrapObservations(seed, rng);
  const facts = buildBootstrapFacts(observations, seed, now);
  const patterns = buildBootstrapPatterns(observations);
  const bootstrap = buildBehavioralModel({ now, observations, facts, patterns, priorTheory: null });
  const learning = new BehavioralLearningLayer({ storagePath: `.poke-core/generated/${seed}/behavioral-state.json` });
  const learned = learning.learn({ now, workingFacts: facts, episodicItems: synthesizeEpisodesFromTheory(bootstrap.theory, seed, now), sourceDocuments: [] });
  return learned.theory ?? bootstrap.theory;
}

function synthesizeEpisodesFromTheory(theory: UserBehaviorTheory, seed: string, now: number): EpisodicMemoryItem[] {
  const source = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return source.slice(0, 3).map((text, index) => ({
    id: `ep-${hashText(seed, text, String(index)).slice(0, 18)}`,
    taskId: `task-${hashText(seed, 'task', String(index)).slice(0, 18)}`,
    category: index === 0 ? 'decision' : index === 1 ? 'preference' : 'correction',
    summary: phraseFromText(text, seed, index),
    signals: words(text).slice(0, 5),
    score: Number((0.78 + (index * 0.04)).toFixed(3)),
    createdAt: now - index * 19_000,
  }));
}

function phraseFromText(text: string, seed: string, index: number): string {
  const tokens = words(text);
  const extra = token(seed, 'phrase', index).match(/.{1,4}/g) ?? [];
  return cleanText([...tokens.slice(0, 5), ...extra.slice(0, 2)].join(' '));
}

function buildThreadIdentity(theory: UserBehaviorTheory, seed: string, scope: string, index: number, participants: ThreadIdentityInput['participants'], rootMessageId: string): ThreadIdentityInput {
  const subject = phraseFromTheory(theory, seed, `${scope}-subject`, index);
  return {
    subject,
    participants,
    messageId: `<${hashText(seed, scope, 'message', String(index)).slice(0, 18)}@${hashText(seed, 'mail').slice(0, 12)}.local>`,
    rootMessageId,
    inReplyTo: rootMessageId,
    references: [rootMessageId],
    provider: hashText(seed, 'provider').slice(0, 8),
    mailbox: hashText(seed, 'mailbox').slice(0, 8),
  };
}

function buildParticipants(seed: string, theory: UserBehaviorTheory): ThreadIdentityInput['participants'] {
  const pools = theoryWords(theory);
  const names = pools.slice(0, 3).map((word, index) => ({
    email: `${word.replace(/[^a-z0-9]+/g, '.').replace(/\.+/g, '.')}.${index}.${hashText(seed, 'email', String(index)).slice(0, 8)}@${hashText(seed, 'domain').slice(0, 10)}.local`,
    name: cleanText(`${word} ${token(seed, 'name', index)}`),
    role: 'required',
  }));
  return names.length > 0 ? names : [{ email: `${token(seed, 'email', 0)}@${hashText(seed, 'domain').slice(0, 10)}.local`, name: token(seed, 'name', 0), role: 'required' }];
}

function node(role: string, label: string, name: string, attrs: Record<string, string> = {}, children: NodeSpec[] = []): NodeSpec {
  return { role, label, name, attrs, children };
}

function nodeText(spec: NodeSpec): string[] {
  return [spec.label, spec.name, ...Object.values(spec.attrs)].flatMap(words).concat(spec.children.flatMap(nodeText));
}

function renderNode(spec: NodeSpec): string {
  const attrs = [
    `role="${spec.role}"`,
    `data-name="${spec.name}"`,
    `aria-label="${spec.label}"`,
    ...Object.entries(spec.attrs).map(([key, value]) => `${key}="${value}"`),
  ].join(' ');
  return `<section ${attrs}>${spec.children.map(renderNode).join('')}</section>`;
}

function selectorsFor(spec: NodeSpec): string[] {
  return [...new Set([
    `[role="${spec.role}"]`,
    `[data-name="${spec.name}"]`,
    `[aria-label="${spec.label}"]`,
    ...Object.entries(spec.attrs).map(([key, value]) => `[${key}="${value}"]`),
    ...spec.children.flatMap(selectorsFor),
  ])];
}

function buildUiFrames(theory: UserBehaviorTheory, seed: string): VisionFrame[] {
  const modes = ['steady', 'drift', 'recover'];
  return modes.map((mode, index) => {
    const title = phraseFromTheory(theory, seed, `title-${mode}`, index);
    const body = phraseFromTheory(theory, seed, `body-${mode}`, index + 1);
    const overlay = mode === 'drift';
    const tree = node(
      'application',
      title,
      `root-${hashText(seed, mode).slice(0, 12)}`,
      { 'data-scenario': hashText(seed, 'scenario').slice(0, 12), 'data-mode': mode },
      [
        node('banner', phraseFromTheory(theory, seed, `banner-${mode}`, index + 2), `banner-${mode}`,
          { 'data-section': hashText(seed, 'banner').slice(0, 10) },
          [
            node('heading', title, `heading-${mode}`, { level: '1' }),
            node('status', overlay ? phraseFromTheory(theory, seed, 'status-drift', index + 3) : phraseFromTheory(theory, seed, 'status-steady', index + 3), `status-${mode}`, { 'aria-live': 'polite' }),
          ]),
        node('main', body, `main-${mode}`, { 'data-surface': hashText(seed, 'surface').slice(0, 10) }, [
          node('form', phraseFromTheory(theory, seed, `form-${mode}`, index + 4), `form-${mode}`, { action: `/${hashText(seed, 'draft').slice(0, 8)}` }, [
            node('textbox', phraseFromTheory(theory, seed, `search-${mode}`, index + 5), `search-${mode}`, { placeholder: phraseFromTheory(theory, seed, `placeholder-${mode}`, index + 6), 'aria-description': theory.summary }),
            node('textbox', phraseFromTheory(theory, seed, `bodybox-${mode}`, index + 7), `body-${mode}`, { placeholder: phraseFromTheory(theory, seed, `compose-${mode}`, index + 8) }),
            node('button', phraseFromTheory(theory, seed, `save-${mode}`, index + 9), `save-${mode}`, { type: 'submit', 'data-action': hashText(seed, 'save').slice(0, 10) }),
          ]),
        ]),
      ],
    );
    if (overlay) {
      tree.children.push(node('dialog', phraseFromTheory(theory, seed, 'overlay', index + 10), `overlay-${mode}`, { 'aria-modal': 'true', 'data-overlay': hashText(seed, 'overlay').slice(0, 10) }, [
        node('paragraph', phraseFromTheory(theory, seed, 'overlay-copy', index + 11), `overlay-copy-${mode}`),
        node('button', phraseFromTheory(theory, seed, 'overlay-return', index + 12), `overlay-return-${mode}`, { type: 'button', 'data-action': hashText(seed, 'return').slice(0, 10) }),
      ]));
    }
    return {
      id: hashText(seed, mode).slice(0, 20),
      ocr: cleanText([...nodeText(tree), theory.summary, ...theory.persistentGoals.map((goal) => goal.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)].join(' ')),
      dom: renderNode(tree),
      selectors: selectorsFor(tree),
      activeTabId: hashText(seed, 'tab', mode).slice(0, 18),
      activeWindowId: hashText(seed, 'window', mode).slice(0, 18),
      viewport: { width: 1280, height: overlay ? 790 : 816 },
    };
  });
}

function buildMemoryFacts(theory: UserBehaviorTheory, seed: string, now: number): MemoryFact[] {
  return theory.latentAxes.slice(0, 6).map((axis, index) => ({
    key: hashText(seed, 'fact', axis.axis, String(index)).slice(0, 20),
    value: cleanText(`${axis.axis} ${axis.direction} ${theory.persistentGoals[index % Math.max(1, theory.persistentGoals.length)]?.goal ?? theory.summary}`),
    confidence: Number(Math.min(0.99, 0.7 + axis.confidence * 0.2).toFixed(3)),
    source: hashText(seed, 'source', String(index)).slice(0, 12),
    updatedAt: now - index * 17_000,
  }));
}

function buildEpisodes(theory: UserBehaviorTheory, seed: string, now: number): EpisodicMemoryItem[] {
  return [...theory.persistentGoals, ...theory.crossContextGeneralizations].slice(0, 3).map((entry, index) => ({
    id: `ep-${hashText(seed, entry.goal ?? entry.generalization, String(index)).slice(0, 18)}`,
    taskId: `task-${hashText(seed, 'task', String(index)).slice(0, 18)}`,
    category: index === 0 ? 'decision' : index === 1 ? 'preference' : 'correction',
    summary: cleanText(`${index === 0 ? entry.goal : entry.generalization} ${phraseFromText(entry.goal ?? entry.generalization, seed, index)}`),
    signals: words(entry.goal ?? entry.generalization).slice(0, 5),
    score: Number((0.8 + index * 0.05).toFixed(3)),
    createdAt: now - index * 23_000,
  }));
}

function phraseFromText(text: string, seed: string, index: number): string {
  return cleanText([...words(text).slice(0, 5), ...((token(seed, 'phrase', index).match(/.{1,4}/g) ?? []).slice(0, 2))].join(' '));
}

function buildRecurrence(seed: string): RecurrenceSpec {
  const day = ['MO', 'TU', 'WE', 'TH', 'FR'][parseInt(token(seed, 'day').slice(0, 2), 16) % 5];
  const hour = 8 + (parseInt(token(seed, 'hour').slice(0, 2), 16) % 4);
  return { startLocal: `2026-03-09T${String(hour).padStart(2, '0')}:00:00`, timeZone: 'America/New_York', rule: `FREQ=WEEKLY;COUNT=3;BYDAY=${day}`, durationMinutes: 30 + (parseInt(token(seed, 'duration').slice(0, 2), 16) % 30) };
}

function buildTimezone(seed: string): { local: string; timeZone: string; expectedUtc: string } {
  const hour = 8 + (parseInt(token(seed, 'tz-hour').slice(0, 2), 16) % 3);
  const minute = [0, 15, 30, 45][parseInt(token(seed, 'tz-minute').slice(0, 2), 16) % 4];
  return { local: `2026-03-08T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`, timeZone: 'America/New_York', expectedUtc: `2026-03-08T${String(hour + 4).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z` };
}

function buildTaskHint(theory: UserBehaviorTheory, seed: string): string {
  return cleanText(phraseFromText(`${theory.summary} ${theory.persistentGoals.map((goal) => goal.goal).join(' ')} ${theory.crossContextGeneralizations.map((entry) => entry.generalization).join(' ')}`, seed, 0));
}

function buildLabel(seed: string, taskHint: string): string {
  return hashText(seed, taskHint).slice(0, 16);
}

function buildLearningLayer(seed: string): BehavioralLearningLayer {
  return new BehavioralLearningLayer({ storagePath: `.poke-core/generated/${seed}/behavioral-state.json` });
}

export function buildRaidingAiScenario(input: { seed?: string; taskHint?: string; now?: number } = {}): RaidingAiScenario {
  const seed = seedFromInput(input);
  const rng = createRng(seed);
  const now = input.now ?? Date.now();
  const initialObservations = buildBootstrapObservations(seed, rng);
  const initialFacts = buildBootstrapFacts(initialObservations, seed, now);
  const initialPatterns = buildBootstrapPatterns(initialObservations);
  const bootstrap = buildBehavioralModel({ now, observations: initialObservations, facts: initialFacts, patterns: initialPatterns, priorTheory: null });
  const learning = buildLearningLayer(seed);
  const learned = learning.learn({ now, workingFacts: initialFacts, episodicItems: synthesizeEpisodesFromTheory(bootstrap.theory, seed, now), sourceDocuments: [] });
  const theory = learned.theory ?? bootstrap.theory;
  const taskHint = cleanText(input.taskHint?.trim() || buildTaskHint(theory, seed));
  const label = buildLabel(seed, taskHint);
  const frames = buildUiFrames(theory, seed);
  const participants = buildParticipants(seed, theory);
  const threadRoot = `<${hashText(seed, 'root-message').slice(0, 18)}@${hashText(seed, 'mail').slice(0, 12)}.local>`;
  const threadA = buildThreadIdentity(theory, seed, 'thread-a', 0, participants, threadRoot);
  const threadB = buildThreadIdentity(theory, seed, 'thread-b', 1, participants, threadRoot);
  threadB.references = [threadRoot, threadA.messageId].filter(Boolean) as string[];
  threadB.inReplyTo = threadA.messageId;
  const facts = buildMemoryFacts(theory, seed, now);
  const episodes = buildEpisodes(theory, seed, now);
  const recurrence = buildRecurrence(seed);
  const timezone = buildTimezone(seed);
  const attendees = participants.map((participant, index) => ({
    email: participant.email,
    name: participant.name,
    timezone: index === 0 ? 'America/New_York' : 'Europe/London',
    role: 'required',
  }));

  return {
    seed,
    now,
    label,
    taskHint,
    theory,
    computerUse: {
      frames,
      keys: [hashText(seed, 'key-0').slice(0, 4), hashText(seed, 'key-1').slice(0, 4), hashText(seed, 'key-2').slice(0, 4)],
      fallbackSelectors: frames[0]?.selectors.slice(0, 2) ?? [],
    },
    deepPrimitives: { threadA, threadB, timezone, attendees, recurrence },
    memory: { facts, episodes },
    traces: [
      {
        id: `trace-${hashText(seed, 'computer-use').slice(0, 18)}`,
        kind: 'computer-use',
        description: cleanText(`${taskHint} ${phraseFromText(theory.summary, seed, 1)}`),
        frames,
        fallbackSelectors: frames[0]?.selectors.slice(0, 2) ?? [],
        expected: { driftRecoveries: 1, frameCount: 3, contextRich: true },
      },
      {
        id: `trace-${hashText(seed, 'thread-identity').slice(0, 18)}`,
        kind: 'thread-identity',
        description: cleanText(`${taskHint} ${phraseFromText(theory.crossContextGeneralizations[0]?.generalization ?? theory.summary, seed, 2)}`),
        threadInputs: [threadA, threadB],
        expected: { distinctThreads: true, headerAnchored: true },
      },
      {
        id: `trace-${hashText(seed, 'memory').slice(0, 18)}`,
        kind: 'memory',
        description: cleanText(`${taskHint} ${phraseFromText(theory.persistentGoals[0]?.goal ?? theory.summary, seed, 3)}`),
        workingFacts: facts,
        episodicItems: episodes,
        expected: { factsPersisted: true, episodesPersisted: true, theoryAligned: true },
      },
      {
        id: `trace-${hashText(seed, 'planner').slice(0, 18)}`,
        kind: 'planner',
        description: cleanText(`${taskHint} ${phraseFromText(theory.summary, seed, 4)}`),
        objective: cleanText(`${phraseFromText(theory.summary, seed, 5)} ${phraseFromText(theory.persistentGoals[0]?.goal ?? theory.summary, seed, 6)} ${phraseFromText(theory.crossContextGeneralizations[0]?.generalization ?? theory.summary, seed, 7)}`),
        expected: { recoveryAware: true, multiStep: true },
      },
    ],
  };
}

export const RAIDINGAI_CLOCK = createDriftingClock();
export const RAIDINGAI_FIXTURES = buildRaidingAiScenario();

function buildBootstrapObservations(seed: string, rng: Rng): BehavioralObservation[] {
  const categories = ['tone', 'channel', 'relationship', 'preference', 'signal', 'habit'] as const;
  return categories.map((category, index) => {
    const subject = token(seed, 'subject', index);
    const value = [token(seed, 'value', index), token(seed, 'value', index + 1), token(seed, 'value', index + 2)].join(' ');
    return {
      subject,
      value,
      category,
      source: `scenario-${token(seed, 'source', index)}`,
      confidence: Number((0.72 + rng() * 0.23).toFixed(3)),
      observedAt: Date.now() - (index + 1) * 17_000,
      evidence: [subject, value, token(seed, 'evidence', index)],
      context: { seed, index },
    };
  });
}

function buildBootstrapFacts(observations: BehavioralObservation[], seed: string, now: number): MemoryFact[] {
  return observations.map((observation, index) => ({
    key: hashText(seed, observation.subject, observation.category, String(index)).slice(0, 20),
    value: `${observation.subject} ${observation.value}`.trim(),
    confidence: observation.confidence,
    source: observation.source,
    updatedAt: now - index * 11_000,
  }));
}

function buildBootstrapPatterns(observations: BehavioralObservation[]): BehavioralPattern[] {
  return observations.map((observation, index) => ({
    key: hashText(observation.subject, observation.value, String(index)).slice(0, 24),
    category: observation.category,
    subject: observation.subject,
    value: observation.value,
    evidenceCount: observation.evidence?.length ?? 0,
    sourceCount: 1,
    confidence: observation.confidence,
    firstObservedAt: observation.observedAt - 42_000,
    lastObservedAt: observation.observedAt,
    sources: [observation.source],
    examples: observation.evidence?.slice(0, 3) ?? [],
    contradictionScore: Number((0.04 + (index % 3) * 0.03).toFixed(3)),
  }));
}

function synthesizeEpisodesFromTheory(theory: UserBehaviorTheory, seed: string, now: number): EpisodicMemoryItem[] {
  const source = [theory.summary, ...theory.persistentGoals.map((entry) => entry.goal), ...theory.crossContextGeneralizations.map((entry) => entry.generalization)];
  return source.slice(0, 3).map((text, index) => ({
    id: `ep-${hashText(seed, text, String(index)).slice(0, 18)}`,
    taskId: `task-${hashText(seed, 'task', String(index)).slice(0, 18)}`,
    category: index === 0 ? 'decision' : index === 1 ? 'preference' : 'correction',
    summary: phraseFromText(text, seed, index),
    signals: words(text).slice(0, 5),
    score: Number((0.78 + (index * 0.04)).toFixed(3)),
    createdAt: now - index * 19_000,
  }));
}

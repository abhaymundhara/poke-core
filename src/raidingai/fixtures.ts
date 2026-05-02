import { createHash, randomUUID } from 'node:crypto';
import { buildBehavioralModel, type BehavioralPattern, type UserBehaviorTheory } from '../memory/behavioral-theory';
import type { BehavioralObservation } from '../memory/behavioral-learning';
import { createDriftingClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { VisionFrame } from '../skills/computer-use';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';

type Rng = () => number;

type ScenarioContext = {
  seed: string;
  now: number;
  rng: Rng;
  theory: UserBehaviorTheory;
  label: string;
  taskHint: string;
  theme: string;
  primarySurface: string;
  secondarySurface: string;
  mailDomain: string;
  participantRoles: string[];
};

const SURFACES = ['inbox', 'compose pane', 'support thread', 'calendar sidebar', 'project board', 'document review'];
const TONES = ['brief', 'professional', 'direct', 'careful', 'polite', 'structured'];
const CHANNELS = ['email', 'whatsapp', 'discord', 'calendar', 'browser', 'chat'];
const ACTORS = ['placement manager', 'university coordinator', 'project collaborator', 'family contact', 'support desk'];
const STATUS = ['ready', 'drafting', 'reviewing', 'recovering', 'sent', 'queued'];
const PHASES = ['compose', 'resolve', 'confirm', 'recover', 'verify'];
const CONTEXT_VERBS = ['follow up', 'disambiguate', 'recover', 'confirm', 'summarize', 'route'];

function hashText(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function seedFromInput(input?: { seed?: string; taskHint?: string; now?: number }): string {
  const basis = [String(input?.seed ?? ''), String(input?.taskHint ?? ''), String(input?.now ?? Date.now()), randomUUID()].join('|');
  return hashText(basis).slice(0, 24);
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

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length) % values.length];
}

function pickMany<T>(rng: Rng, values: readonly T[], count: number): T[] {
  const pool = [...values];
  const out: T[] = [];
  while (pool.length > 0 && out.length < count) {
    const index = Math.floor(rng() * pool.length);
    const [value] = pool.splice(index, 1);
    out.push(value);
  }
  return out;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'scenario';
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ');
}

function buildObservations(seed: string, rng: Rng): BehavioralObservation[] {
  const base = Date.now();
  const surfaces = pickMany(rng, SURFACES, 3);
  const tone = pickMany(rng, TONES, 3);
  const channels = pickMany(rng, CHANNELS, 2);
  const actors = pickMany(rng, ACTORS, 2);
  const verbs = pickMany(rng, CONTEXT_VERBS, 3);
  const status = pickMany(rng, STATUS, 2);

  return [
    {
      subject: surfaces[0],
      value: tone[0] + ' replies with bullets and explicit next steps',
      category: 'tone',
      source: 'scenario-seed',
      confidence: 0.95,
      observedAt: base - 14_000,
      evidence: [tone[0], 'bullets', 'next steps', 'formal'],
      context: { seed, focus: surfaces[0] },
    },
    {
      subject: channels[0],
      value: 'ongoing coordination migrates to ' + channels[0] + ' while formal updates stay in email',
      category: 'channel',
      source: 'scenario-seed',
      confidence: 0.9,
      observedAt: base - 22_000,
      evidence: [channels[0], 'email', 'ongoing', 'formal'],
      context: { seed, focus: channels[0] },
    },
    {
      subject: actors[0],
      value: 'keeps a professional boundary with ' + actors[0] + ' contacts and notes hierarchy clearly',
      category: 'relationship',
      source: 'scenario-seed',
      confidence: 0.88,
      observedAt: base - 31_000,
      evidence: [actors[0], 'professional', 'hierarchy'],
      context: { seed, focus: actors[0] },
    },
    {
      subject: surfaces[1],
      value: 'uses ' + tone[1] + ' update style when the task requires a short procedural handoff',
      category: 'preference',
      source: 'scenario-seed',
      confidence: 0.86,
      observedAt: base - 39_000,
      evidence: [surfaces[1], 'procedural', 'handoff'],
      context: { seed, focus: surfaces[1] },
    },
    {
      subject: verbs[0],
      value: 'prefers to ' + verbs[0] + ' through a visible sequence of checks before marking completion',
      category: 'signal',
      source: 'scenario-seed',
      confidence: 0.83,
      observedAt: base - 46_000,
      evidence: [verbs[0], 'checks', 'completion'],
      context: { seed, focus: verbs[0] },
    },
    {
      subject: status[0],
      value: 'moves from ' + status[0] + ' to ' + status[1] + ' once the response path is stable',
      category: 'habit',
      source: 'scenario-seed',
      confidence: 0.79,
      observedAt: base - 55_000,
      evidence: [status[0], status[1], 'stable'],
      context: { seed, focus: status.join('/') },
    },
  ];
}

function buildPatterns(observations: BehavioralObservation[], rng: Rng): BehavioralPattern[] {
  return observations.map((observation, index) => ({
    key: hashText(observation.subject, observation.value, String(index)).slice(0, 24),
    category: observation.category,
    subject: observation.subject,
    value: observation.value,
    evidenceCount: Math.max(1, observation.evidence?.length ?? 1),
    sourceCount: 1 + (index % 2),
    confidence: Number(Math.min(0.99, observation.confidence + (rng() * 0.05)).toFixed(3)),
    firstObservedAt: observation.observedAt - 120_000,
    lastObservedAt: observation.observedAt,
    sources: [observation.source, 'scenario-generator'].slice(0, 2),
    examples: [...(observation.evidence ?? []).slice(0, 3), observation.value].filter(Boolean),
    contradictionScore: Number((0.02 + rng() * 0.18).toFixed(3)),
  }));
}

function buildTheory(seed: string, inputNow: number, rng: Rng): UserBehaviorTheory {
  const observations = buildObservations(seed, rng);
  const patterns = buildPatterns(observations, rng);
  const facts: MemoryFact[] = observations.map((observation, index) => ({
    key: slug([observation.category, observation.subject, String(index), seed.slice(0, 6)].join('-')),
    value: observation.value,
    confidence: observation.confidence,
    source: observation.source,
    updatedAt: inputNow - index * 13_000,
  }));
  const model = buildBehavioralModel({ now: inputNow, observations, facts, patterns, priorTheory: null });
  return model.theory;
}

function deriveScenarioContext(input?: { seed?: string; taskHint?: string; now?: number }): ScenarioContext {
  const seed = seedFromInput(input);
  const rng = createRng(seed);
  const now = input?.now ?? Date.now();
  const theory = buildTheory(seed, now, rng);
  const axes = theory.latentAxes.slice(0, 3).map((axis) => slug(axis.axis + '-' + axis.direction)).filter(Boolean);
  const primaryAxis = axes[0] ?? slug(pick(rng, TONES));
  const secondaryAxis = axes[1] ?? slug(pick(rng, CHANNELS));
  const taskHint = input?.taskHint && input.taskHint.trim().length > 0 ? input.taskHint.trim() : titleCase(primaryAxis + ' ' + secondaryAxis);
  const label = slug([taskHint, primaryAxis, seed.slice(0, 8)].join('-'));
  const theme = titleCase([pick(rng, TONES), pick(rng, ACTORS), pick(rng, PHASES)].join(' '));
  const primarySurface = pick(rng, SURFACES);
  const secondarySurface = pick(rng, SURFACES.filter((surface) => surface !== primarySurface));
  const participantRoles = pickMany(rng, ACTORS, 2);
  const mailDomain = slug(label + '.mail') + '.local';
  return { seed, now, rng, theory, label, taskHint, theme, primarySurface, secondarySurface, mailDomain, participantRoles };
}

function hashToId(...parts: string[]): string {
  return hashText(...parts).slice(0, 20);
}

function buildEmail(localPart: string, domain: string): string {
  return localPart.replace(/[^a-z0-9.-]+/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '') + '@' + domain;
}

function buildThreadIdentity(context: ScenarioContext, stage: string, participants: ThreadIdentityInput['participants'], baseSubject: string, rootChain?: string): ThreadIdentityInput {
  const messageId = '<' + hashToId(context.seed, context.label, stage, 'message') + '@' + context.mailDomain + '>';
  const rootMessageId = rootChain ?? '<' + hashToId(context.seed, context.label, 'root') + '@' + context.mailDomain + '>';
  return {
    subject: baseSubject,
    participants,
    messageId,
    rootMessageId,
    inReplyTo: rootMessageId,
    references: [rootMessageId],
    provider: 'gmail',
    mailbox: 'primary',
  };
}

function buildParticipants(context: ScenarioContext): ThreadIdentityInput['participants'] {
  return context.participantRoles.map((role, index) => ({
    email: buildEmail(role + '.' + index + '.' + context.label, context.mailDomain),
    name: titleCase(role),
    role: 'required',
  }));
}

type UiNode = {
  role: string;
  label: string;
  name: string;
  children: UiNode[];
  attrs: Record<string, string>;
  hidden?: boolean;
};

function createNode(role: string, label: string, name: string, attrs: Record<string, string> = {}, children: UiNode[] = [], hidden = false): UiNode {
  return { role, label, name, attrs, children, hidden };
}

function flattenText(node: UiNode): string[] {
  const current = [node.label, node.name, node.attrs['aria-description'], node.attrs['placeholder']].filter(Boolean) as string[];
  const childText = node.children.flatMap((child) => flattenText(child));
  return [...current, ...childText].filter(Boolean);
}

function serializeNode(node: UiNode): string {
  const attrs = [
    'role="' + node.role + '"',
    'data-name="' + node.name + '"',
    'aria-label="' + node.label + '"',
    ...Object.entries(node.attrs).map(([key, value]) => key + '="' + value + '"'),
    node.hidden ? 'hidden="true"' : '',
  ].filter(Boolean).join(' ');
  const childMarkup = node.children.map((child) => serializeNode(child)).join('');
  return '<section ' + attrs + '>' + childMarkup + '</section>';
}

function selectorsFromNode(node: UiNode): string[] {
  const base = [
    '[role="' + node.role + '"]',
    '[data-name="' + node.name + '"]',
    '[aria-label="' + node.label + '"]',
  ];
  return [...new Set([...base, ...Object.entries(node.attrs).flatMap(([key, value]) => ['[' + key + '="' + value + '"]'])])];
}

function buildUiTree(context: ScenarioContext, mode: 'ready' | 'drift' | 'recovered'): UiNode {
  const label = context.theme + ' · ' + titleCase(context.primarySurface);
  const detail = context.theory.crossContextGeneralizations.slice(0, 2).map((entry) => entry.generalization).join(' ');
  const statusLabel = mode === 'drift' ? 'overlay active' : mode === 'recovered' ? 'compose restored' : 'draft ready';
  const saveLabel = mode === 'drift' ? 'Resolve overlay' : 'Save draft';
  const root = createNode(
    'application',
    label,
    'root-' + mode,
    { 'data-scenario': context.label, 'data-mode': mode },
    [
      createNode('banner', context.taskHint, 'banner-' + mode, { 'data-section': 'header' }, [
        createNode('heading', context.theme, 'headline-' + mode, { level: '1' }),
        createNode('status', statusLabel, 'status-' + mode, { 'aria-live': 'polite' }),
      ]),
      createNode('main', detail || context.theory.summary, 'main-' + mode, { 'data-surface': context.primarySurface }, [
        createNode('form', 'Compose message', 'compose-form-' + mode, { action: '/drafts' }, [
          createNode('textbox', 'Search or route the message', 'search-' + mode, { placeholder: 'Search ' + context.secondarySurface, 'aria-description': context.theory.summary }),
          createNode('textbox', 'Draft body', 'body-' + mode, { placeholder: 'Write the update' }),
          createNode('button', saveLabel, 'save-' + mode, { type: 'submit', 'data-action': 'save' }),
          createNode('button', 'Skip' + ' ' + context.secondarySurface, 'skip-' + mode, { type: 'button', 'data-action': 'skip' }),
        ]),
        createNode('list', 'Activity feed', 'feed-' + mode, { 'data-section': 'feed' }, [
          createNode('listitem', 'Observed ' + context.theory.latentAxes.length + ' stable signals', 'signal-1-' + mode, { 'data-weight': 'high' }),
          createNode('listitem', 'Recovered from ' + context.theory.crossContextGeneralizations.length + ' context shifts', 'signal-2-' + mode, { 'data-weight': 'medium' }),
        ]),
      ]),
    ],
  );
  if (mode === 'drift') {
    root.children.push(
      createNode('dialog', 'Context overlay', 'overlay-' + mode, { 'aria-modal': 'true', 'data-overlay': 'help' }, [
        createNode('paragraph', 'Navigation drift detected', 'overlay-copy-' + mode, { 'data-state': 'stale' }),
        createNode('button', 'Return to compose', 'overlay-return-' + mode, { type: 'button', 'data-action': 'return' }),
      ])
    );
  }
  return root;
}

function buildFrameFromTree(context: ScenarioContext, mode: 'ready' | 'drift' | 'recovered'): VisionFrame {
  const tree = buildUiTree(context, mode);
  const visibleText = flattenText(tree).join(' ').replace(/\s+/g, ' ').trim();
  const noisyText = [
    visibleText,
    context.theory.summary,
    context.theory.persistentGoals.map((goal) => goal.goal).join(' '),
    context.theory.crossContextGeneralizations.map((entry) => entry.generalization).join(' '),
  ].join(' ').replace(/\s+/g, ' ').trim();
  return {
    id: hashToId(context.seed, mode, context.label),
    ocr: noisyText,
    dom: serializeNode(tree),
    selectors: [...new Set([tree, ...tree.children, ...tree.children.flatMap((child) => child.children)].flatMap((node) => selectorsFromNode(node)))],
    activeTabId: hashToId(context.seed, context.label, 'tab', mode),
    activeWindowId: hashToId(context.seed, context.label, 'window', mode),
    viewport: { width: 1280, height: mode === 'drift' ? 792 : 816 },
  };
}

function buildComputerUseFrames(context: ScenarioContext): VisionFrame[] {
  return [buildFrameFromTree(context, 'ready'), buildFrameFromTree(context, 'drift'), buildFrameFromTree(context, 'recovered')];
}

function synthesizeMemoryFacts(context: ScenarioContext): MemoryFact[] {
  const now = context.now;
  return context.theory.latentAxes.slice(0, 6).map((axis, index) => ({
    key: hashToId(context.seed, 'fact', axis.axis, axis.direction, String(index)),
    value: axis.axis + ' bias favors ' + axis.direction + ' communication across ' + context.primarySurface + ' and ' + context.secondarySurface,
    confidence: Number(Math.min(0.99, 0.72 + axis.confidence * 0.2).toFixed(3)),
    source: 'behavioral-theory',
    updatedAt: now - index * 17_000,
  }));
}

function synthesizeEpisodes(context: ScenarioContext, threadInputs: ThreadIdentityInput[]): EpisodicMemoryItem[] {
  const goals = context.theory.persistentGoals.length > 0 ? context.theory.persistentGoals : [{ goal: context.theory.summary, confidence: 0.5, evidence: [] }];
  return goals.slice(0, 3).map((goal, index) => ({
    id: 'ep-' + hashToId(context.seed, goal.goal, String(index)),
    taskId: 'task-' + hashToId(context.seed, context.label, 'task', String(index)),
    category: index === 0 ? 'decision' : index === 1 ? 'preference' : 'correction',
    summary: goal.goal + ' while preserving ' + context.theme.toLowerCase() + ' alignment through ' + context.primarySurface,
    signals: [context.label, context.primarySurface, context.secondarySurface, ...threadInputs.flatMap((thread) => thread.participants.map((participant) => participant.email))].slice(0, 5),
    score: Number(Math.min(0.99, 0.82 + goal.confidence * 0.1).toFixed(3)),
    createdAt: context.now - index * 26_000,
  }));
}

function synthesizeThreadInputs(context: ScenarioContext): { threadA: ThreadIdentityInput; threadB: ThreadIdentityInput } {
  const participants = buildParticipants(context);
  const topic = titleCase(context.theory.latentAxes.slice(0, 2).map((axis) => axis.axis).join(' '));
  const subjectBase = 'Re: ' + context.taskHint + ' - ' + topic.toLowerCase();
  const rootMessageId = '<' + hashToId(context.seed, context.label, 'root-message') + '@' + context.mailDomain + '>';
  const threadA = buildThreadIdentity(context, 'thread-a', participants, subjectBase, rootMessageId);
  const threadB = buildThreadIdentity(context, 'thread-b', participants, subjectBase, rootMessageId);
  threadB.references = [rootMessageId, threadA.messageId].filter(Boolean) as string[];
  threadB.inReplyTo = threadA.messageId;
  threadB.rootMessageId = rootMessageId;
  return { threadA, threadB };
}

function synthesizeRecurrence(context: ScenarioContext): RecurrenceSpec {
  const weekday = pick(context.rng, ['MO', 'TU', 'WE', 'TH', 'FR'] as const);
  const startHour = 8 + Math.floor(context.rng() * 4);
  return {
    startLocal: '2026-03-09T' + String(startHour).padStart(2, '0') + ':00:00',
    timeZone: 'America/New_York',
    rule: 'FREQ=WEEKLY;COUNT=3;BYDAY=' + weekday,
    durationMinutes: 30 + Math.floor(context.rng() * 30),
  };
}

function synthesizeAttendees(context: ScenarioContext): Attendee[] {
  const participants = buildParticipants(context);
  return participants.map((participant, index) => ({
    email: participant.email,
    name: participant.name,
    timezone: index === 0 ? 'America/New_York' : 'Europe/London',
    role: participant.role === 'required' ? 'required' : 'optional',
  }));
}

export type RaidingAiScenario = {
  seed: string;
  label: string;
  taskHint: string;
  theme: string;
  theory: UserBehaviorTheory;
  computerUse: {
    frames: VisionFrame[];
    keys: string[];
    fallbackSelectors: string[];
  };
  deepPrimitives: {
    threadA: ThreadIdentityInput;
    threadB: ThreadIdentityInput;
    timezone: { local: string; timeZone: string; expectedUtc: string };
    attendees: Attendee[];
    recurrence: RecurrenceSpec;
  };
  memory: {
    facts: MemoryFact[];
    episodes: EpisodicMemoryItem[];
  };
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

export function buildRaidingAiScenario(input: { seed?: string; taskHint?: string; now?: number } = {}): RaidingAiScenario {
  const seed = seedFromInput(input);
  const rng = createRng(seed);
  const now = input.now ?? Date.now();
  const context = deriveScenarioContext({ seed, taskHint: input.taskHint, now });
  const threadInputs = synthesizeThreadInputs(context);
  const frames = buildComputerUseFrames(context);
  const facts = synthesizeMemoryFacts(context);
  const episodes = synthesizeEpisodes(context, [threadInputs.threadA, threadInputs.threadB]);
  const recurrence = synthesizeRecurrence(context);
  const attendees = synthesizeAttendees(context);
  const timezoneHour = 8 + Math.floor(rng() * 3);
  const timezoneMinute = Math.floor(rng() * 4) * 15;

  return {
    seed: context.seed,
    label: context.label,
    taskHint: context.taskHint,
    theme: context.theme,
    theory: context.theory,
    computerUse: {
      frames,
      keys: pickMany(rng, ['tab', 'enter', 'ctrl+tab', 'shift+tab', 'esc'], 3),
      fallbackSelectors: frames[0]?.selectors.slice(0, 2) ?? [],
    },
    deepPrimitives: {
      threadA: threadInputs.threadA,
      threadB: threadInputs.threadB,
      timezone: {
        local: '2026-03-08T' + String(timezoneHour).padStart(2, '0') + ':' + String(timezoneMinute).padStart(2, '0') + ':00',
        timeZone: 'America/New_York',
        expectedUtc: '2026-03-08T' + String(timezoneHour + 4).padStart(2, '0') + ':' + String(timezoneMinute).padStart(2, '0') + ':00.000Z',
      },
      attendees,
      recurrence,
    },
    memory: {
      facts,
      episodes,
    },
    traces: [
      {
        id: 'trace-' + hashToId(seed, 'computer-use'),
        kind: 'computer-use',
        description: context.taskHint + ' | procedural UI synthesis with drift and recovery',
        frames,
        fallbackSelectors: frames[0]?.selectors.slice(0, 2) ?? [],
        expected: { driftRecoveries: 1, frameCount: 3, contextRich: true },
      },
      {
        id: 'trace-' + hashToId(seed, 'thread-identity'),
        kind: 'thread-identity',
        description: context.taskHint + ' | header-anchored thread hashing from real metadata',
        threadInputs: [threadInputs.threadA, threadInputs.threadB],
        expected: { distinctThreads: true, headerAnchored: true },
      },
      {
        id: 'trace-' + hashToId(seed, 'memory'),
        kind: 'memory',
        description: context.taskHint + ' | learned user context synthesized from behavior theory patterns',
        workingFacts: facts,
        episodicItems: episodes,
        expected: { factsPersisted: true, episodesPersisted: true, theoryAligned: true },
      },
      {
        id: 'trace-' + hashToId(seed, 'planner'),
        kind: 'planner',
        description: context.taskHint + ' | recovery-aware planning seeded from theory summary',
        objective: 'Follow the synthesized context, recover the UI if it drifts, disambiguate the thread, and preserve the learned communication style.',
        expected: { recoveryAware: true, multiStep: true },
      },
    ],
  };
}

export const RAIDINGAI_CLOCK = createDriftingClock();
export const RAIDINGAI_FIXTURES = buildRaidingAiScenario();

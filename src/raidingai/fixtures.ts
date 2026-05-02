import { createFixedClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { VisionFrame } from '../skills/computer-use';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';

const TRACE_BASE_NOW = Date.now() - (30 * 60 * 1000 + Math.floor(Math.random() * 90 * 60 * 1000));
const TRACE_JITTER = () => Math.floor(Math.random() * 45_000);

export const RAIDINGAI_CLOCK = createFixedClock(TRACE_BASE_NOW - TRACE_JITTER());

function traceAt(minutesAgo: number): number {
  return TRACE_BASE_NOW - minutesAgo * 60_000 - TRACE_JITTER();
}

function makeFrameState(input: {
  id: string;
  title: string;
  body: string;
  buttonLabel: string;
  inputName: string;
  activeTabId: string;
  activeWindowId: string;
  drift?: boolean;
}): VisionFrame {
  const frameText = input.drift
    ? input.body + ' A help overlay is visible and the compose surface is partially obscured.'
    : input.body + ' The save action is visible and the compose surface is stable.';

  return {
    id: input.id + '-' + Math.floor(TRACE_BASE_NOW / 1000) + '-' + Math.floor(Math.random() * 10000),
    ocr: frameText.repeat(18).trim(),
    dom: input.drift
      ? '<div role="dialog" aria-label="Help overlay"><button class="close">Close</button><p>' + input.title + '</p></div>'
      : '<main data-view="compose"><button class="save">' + input.buttonLabel + '</button><input name="' + input.inputName + '" aria-label="' + input.inputName + '" /><section>' + input.title + '</section></main>',
    selectors: input.drift ? ['div[role="dialog"]', 'button.close'] : ['button.save', 'input[name="' + input.inputName + '"]'],
    activeTabId: input.activeTabId,
    activeWindowId: input.activeWindowId,
    viewport: { width: 1280, height: input.drift ? 780 : 812 },
  };
}

function buildComputerUseFrames(): VisionFrame[] {
  return [
    makeFrameState({
      id: 'compose-ready',
      title: 'Draft reply for BT placement handoff',
      body: 'Inbox, compose modal, save draft button, search field, and inbox summary are visible.',
      buttonLabel: 'Save draft',
      inputName: 'query',
      activeTabId: 'tab-inbox',
      activeWindowId: 'window-compose',
    }),
    makeFrameState({
      id: 'compose-drifted',
      title: 'Help overlay opened while composing',
      body: 'The compose modal drifted behind a support overlay after navigation state changed.',
      buttonLabel: 'Save draft',
      inputName: 'query',
      activeTabId: 'tab-help',
      activeWindowId: 'window-support',
      drift: true,
    }),
    makeFrameState({
      id: 'compose-recovered',
      title: 'Compose modal restored after drift',
      body: 'Return to the compose modal, confirm the draft field and save action are back in focus.',
      buttonLabel: 'Save draft',
      inputName: 'query',
      activeTabId: 'tab-inbox',
      activeWindowId: 'window-compose',
    }),
  ];
}

function buildThreadInput(options: {
  subject: string;
  participants: ThreadIdentityInput['participants'];
  messageId: string;
  rootMessageId: string;
  inReplyTo: string;
  references: string[];
  mailbox: string;
}): ThreadIdentityInput {
  return {
    subject: options.subject,
    participants: options.participants,
    messageId: options.messageId,
    rootMessageId: options.rootMessageId,
    inReplyTo: options.inReplyTo,
    references: options.references,
    provider: 'gmail',
    mailbox: options.mailbox,
  };
}

const facts: MemoryFact[] = [
  { key: 'preference:tone:brief-professional', value: 'prefers brief, professional replies for BT Group and university admin threads', confidence: 0.96, source: 'behavioral-theory', updatedAt: traceAt(45) },
  { key: 'channel:ongoing-collaboration:whatsapp-discord', value: 'moves ongoing collaboration to WhatsApp and technical coordination to Discord when email gets slow', confidence: 0.91, source: 'behavioral-theory', updatedAt: traceAt(90) },
  { key: 'schedule:response-window:afternoon-evening', value: 'is most responsive to non-urgent follow-ups after settling in during the afternoon or early evening', confidence: 0.82, source: 'behavioral-theory', updatedAt: traceAt(120) },
  { key: 'relationship:bt-group:formal-hierarchy', value: 'keeps BT Group managers and HR contacts in a formal, concise business tone', confidence: 0.95, source: 'behavioral-theory', updatedAt: traceAt(150) },
  { key: 'structure:complex-updates:bullets-and-steps', value: 'uses short paragraphs, bullets, and explicit next steps for multi-part requests', confidence: 0.89, source: 'behavioral-theory', updatedAt: traceAt(180) },
  { key: 'curiosity:tooling-experiments', value: 'regularly tests new automation, AI, and browser workflows and shares concrete implementation details', confidence: 0.77, source: 'behavioral-theory', updatedAt: traceAt(210) },
  { key: 'stability:important-docs-forwarded', value: 'forwards important documents to family for transparency on visa, finance, and placement matters', confidence: 0.85, source: 'behavioral-theory', updatedAt: traceAt(260) },
];

const episodes: EpisodicMemoryItem[] = [
  { id: 'ep-placement-handoff', taskId: 'task-1', category: 'decision', summary: 'kept the BT placement handoff concise, formal, and focused on next actions', signals: ['bt', 'manager', 'handoff', 'concise'], score: 0.93, createdAt: traceAt(30) },
  { id: 'ep-thread-collision', taskId: 'task-2', category: 'signal', summary: 'disambiguated two similar project threads by anchoring on the message header chain', signals: ['thread', 'header', 'collision', 'reply'], score: 0.88, createdAt: traceAt(75) },
  { id: 'ep-document-forward', taskId: 'task-3', category: 'preference', summary: 'forwarded key documents to family after an immigration or finance update', signals: ['document', 'family', 'visa', 'finance'], score: 0.84, createdAt: traceAt(165) },
];

const threadA = buildThreadInput({
  subject: 'Re: BT placement handoff and report update',
  participants: [
    { email: 'stephen.razzell@bt.com', name: 'Stephen Razzell', role: 'required' },
    { email: 'abhay.mundhara@gmail.com', name: 'Abhay Mundhara', role: 'required' },
  ],
  messageId: '<20260502.094500.1@bt.com>',
  rootMessageId: '<20260502.083000.0@bt.com>',
  inReplyTo: '<20260502.083000.0@bt.com>',
  references: ['<20260502.083000.0@bt.com>'],
  mailbox: 'primary',
});

const threadB = buildThreadInput({
  subject: 'Re: BT placement handoff and report update',
  participants: [
    { email: 'stephen.razzell@bt.com', name: 'Stephen Razzell', role: 'required' },
    { email: 'abhay.mundhara@gmail.com', name: 'Abhay Mundhara', role: 'required' },
  ],
  messageId: '<20260502.111200.2@bt.com>',
  rootMessageId: '<20260502.103000.0@bt.com>',
  inReplyTo: '<20260502.103000.0@bt.com>',
  references: ['<20260502.083000.0@bt.com>', '<20260502.103000.0@bt.com>'],
  mailbox: 'primary',
});

export const RAIDINGAI_FIXTURES = {
  computerUse: {
    frames: buildComputerUseFrames(),
    keys: ['tab', 'enter', 'ctrl+tab'],
    fallbackSelectors: ['button.save', 'input[name="query"]'],
  },
  deepPrimitives: {
    threadA,
    threadB,
    timezone: { local: '2026-03-08T09:00:00', timeZone: 'America/New_York', expectedUtc: '2026-03-08T13:00:00.000Z' },
    attendees: [
      { email: 'abhay@example.com', name: 'Abhay Mundhara', timezone: 'America/New_York' },
      { email: 'jane@example.com', name: 'Jane Doe', role: 'required' },
    ] satisfies Attendee[],
    recurrence: { startLocal: '2026-03-09T09:00:00', timeZone: 'America/New_York', rule: 'FREQ=WEEKLY;COUNT=3;BYDAY=MO,WE', durationMinutes: 45 } satisfies RecurrenceSpec,
  },
  memory: {
    facts,
    episodes,
  },
  traces: [
    {
      id: 'ui-drift-recovery',
      kind: 'computer-use',
      description: 'compose modal drifted into help overlay, then recovered back to the save action',
      frames: buildComputerUseFrames(),
      fallbackSelectors: ['button.save', 'input[name="query"]'],
      expected: { driftRecoveries: 1, finalSelector: 'button.save', visibleTextCharsMin: 5000 },
    },
    {
      id: 'thread-collision',
      kind: 'thread-identity',
      description: 'same subject and participants but different message header chains should not collapse together',
      threadInputs: [threadA, threadB],
      expected: { distinctThreads: true, headerAnchored: true },
    },
    {
      id: 'memory-roundtrip',
      kind: 'memory',
      description: 'working and episodic memory should survive reloads and compact cleanly',
      workingFacts: facts,
      episodicItems: episodes,
      expected: { factsPersisted: true, episodesPersisted: true, compactionStable: true },
    },
    {
      id: 'planner-recovery',
      kind: 'planner',
      description: 'mixed objective with drift and collision should generate recovery-aware steps',
      objective: 'Inspect the messy support thread, disambiguate the collision, recover the UI if the compose pane drifts, then draft a concise reply and verify the send state.',
      expected: { recoveryAware: true, intent: 'multi-step recovery' },
    },
  ],
} as const;

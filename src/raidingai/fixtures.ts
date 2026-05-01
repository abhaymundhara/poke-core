import { createFixedClock } from '../runtime/clock';
import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { VisionFrame } from '../skills/computer-use';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';

export const RAIDINGAI_CLOCK = createFixedClock('2026-05-01T12:00:00.000Z');

const LONG_PAGE_TEXT = 'Inbox compose modal Save button Search field '.repeat(140).trim();
const DRIFTED_TEXT = 'View drifted to help overlay Close dialog '.repeat(45).trim();

const uiDriftFrames: VisionFrame[] = [
  { id: 'frame-1', ocr: LONG_PAGE_TEXT, dom: '<button class="save">Save</button><input name="query" />', selectors: ['button.save', 'input[name="query"]'], activeTabId: 'tab-a', activeWindowId: 'window-a', viewport: { width: 1280, height: 800 } },
  { id: 'frame-2', ocr: DRIFTED_TEXT, dom: '<div role="dialog"><button class="close">Close</button></div>', selectors: ['div[role="dialog"]', 'button.close'], activeTabId: 'tab-a', activeWindowId: 'window-a', viewport: { width: 1280, height: 800 } },
  { id: 'frame-3', ocr: LONG_PAGE_TEXT, dom: '<button class="save">Save</button><input name="query" />', selectors: ['button.save', 'input[name="query"]'], activeTabId: 'tab-a', activeWindowId: 'window-a', viewport: { width: 1280, height: 800 } },
];

const threadA: ThreadIdentityInput = { subject: 'Re: Project sync', participants: [{ email: 'Abhay@Example.com' }, { email: 'jane@example.com' }], messageId: '<abc@1>', references: '<root@0>', inReplyTo: '<root@0>', provider: 'gmail', mailbox: 'primary' };
const threadB: ThreadIdentityInput = { subject: 'project sync', participants: [{ email: 'jane@example.com' }, { email: 'abhay@example.com' }], messageId: '<def@2>', references: ['<root@0>', '<abc@1>'], inReplyTo: '<abc@1>', provider: 'gmail', mailbox: 'primary' };

const factBase = RAIDINGAI_CLOCK.now();
const facts: MemoryFact[] = [
  { key: 'relationship:stephen.razzell@bt.com', value: 'BT Group line manager', confidence: 0.96, source: 'email', updatedAt: factBase - 2 * 3_600_000 },
  { key: 'thread:project sync', value: 'confirmed follow-up needed with Jane and Abhay', confidence: 0.87, source: 'email', updatedAt: factBase - 4 * 3_600_000 },
  { key: 'preference:tone', value: 'brief and professional', confidence: 0.72, source: 'memory', updatedAt: factBase - 30 * 3_600_000 },
  { key: 'stale:transactional', value: 'old invoice note', confidence: 0.22, source: 'email', updatedAt: factBase - 120 * 3_600_000 },
];

const episodes: EpisodicMemoryItem[] = [
  { id: 'ep-1', taskId: 'task-1', category: 'decision', summary: 'keep the thread warm and reply after the status update', signals: ['thread', 'reply', 'relationship'], score: 0.91, createdAt: factBase - 1 * 3_600_000 },
  { id: 'ep-2', taskId: 'task-2', category: 'preference', summary: 'use concise professional tone for BT contacts', signals: ['preference', 'tone', 'professional'], score: 0.8, createdAt: factBase - 5 * 3_600_000 },
];

export const RAIDINGAI_FIXTURES = {
  computerUse: {
    frames: uiDriftFrames,
    keys: ['tab', 'enter', 'ctrl+tab'],
    fallbackSelectors: ['button.save', 'input[name="query"]'],
  },
  deepPrimitives: {
    threadA,
    threadB,
    timezone: { local: '2026-03-08T09:00:00', timeZone: 'America/New_York', expectedUtc: '2026-03-08T13:00:00.000Z' },
    attendees: [
      { email: 'abhay@example.com', name: 'Abhay Mundhara', timezone: 'America/New_York', locale: 'en-GB' },
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
      frames: uiDriftFrames,
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

import type { Attendee, RecurrenceSpec, ThreadIdentityInput } from '../deep-primitives';
import type { VisionFrame } from '../skills/computer-use';
import type { EpisodicMemoryItem } from '../memory/episodic-memory';
import type { MemoryFact } from '../memory/working-memory';

export const RAIDINGAI_FIXTURES = {
  computerUse: {
    frames: [
      { id: 'frame-1', ocr: 'Inbox compose modal Save button Search field', dom: '<button class="save">Save</button><input name="query" />', selectors: ['button.save', 'input[name="query"]'], activeTabId: 'tab-a', activeWindowId: 'window-a', viewport: { width: 1280, height: 800 } },
      { id: 'frame-2', ocr: 'View drifted to help overlay Close dialog', dom: '<div role="dialog"><button class="close">Close</button></div>', selectors: ['div[role="dialog"]', 'button.close'], activeTabId: 'tab-a', activeWindowId: 'window-a', viewport: { width: 1280, height: 800 } },
      { id: 'frame-3', ocr: 'Recovered Save button Search field', dom: '<button class="save">Save</button><input name="query" />', selectors: ['button.save', 'input[name="query"]'], activeTabId: 'tab-a', activeWindowId: 'window-a', viewport: { width: 1280, height: 800 } },
    ] satisfies VisionFrame[],
    keys: ['tab', 'enter', 'ctrl+tab'],
    fallbackSelectors: ['button.save', 'input[name="query"]'],
  },
  deepPrimitives: {
    threadA: { subject: 'Re: Project sync', participants: [{ email: 'Abhay@Example.com' }, { email: 'jane@example.com' }], rootMessageId: '<abc@1>', provider: 'gmail', mailbox: 'primary' } satisfies ThreadIdentityInput,
    threadB: { subject: 'project sync', participants: [{ email: 'jane@example.com' }, { email: 'abhay@example.com' }], rootMessageId: '<abc@1>', provider: 'gmail', mailbox: 'primary' } satisfies ThreadIdentityInput,
    timezone: { local: '2026-03-08T09:00:00', timeZone: 'America/New_York', expectedUtc: '2026-03-08T13:00:00.000Z' },
    attendees: [
      { email: 'abhay@example.com', name: 'Abhay Mundhara', timezone: 'America/New_York', locale: 'en-GB' },
      { email: 'jane@example.com', name: 'Jane Doe', role: 'required' },
    ] satisfies Attendee[],
    recurrence: { startLocal: '2026-03-09T09:00:00', timeZone: 'America/New_York', rule: 'FREQ=WEEKLY;COUNT=3;BYDAY=MO,WE', durationMinutes: 45 } satisfies RecurrenceSpec,
  },
  memory: {
    facts: [
      { key: 'relationship:stephen.razzell@bt.com', value: 'BT Group line manager', confidence: 0.96, source: 'email', updatedAt: Date.now() - 2 * 3_600_000 },
      { key: 'thread:project sync', value: 'confirmed follow-up needed with Jane and Abhay', confidence: 0.87, source: 'email', updatedAt: Date.now() - 4 * 3_600_000 },
      { key: 'preference:tone', value: 'brief and professional', confidence: 0.72, source: 'memory', updatedAt: Date.now() - 30 * 3_600_000 },
      { key: 'stale:transactional', value: 'old invoice note', confidence: 0.22, source: 'email', updatedAt: Date.now() - 120 * 3_600_000 },
    ] satisfies MemoryFact[],
    episodes: [
      { id: 'ep-1', taskId: 'task-1', category: 'decision', summary: 'keep the thread warm and reply after the status update', signals: ['thread', 'reply', 'relationship'], score: 0.91, createdAt: Date.now() - 1 * 3_600_000 },
      { id: 'ep-2', taskId: 'task-2', category: 'preference', summary: 'use concise professional tone for BT contacts', signals: ['preference', 'tone', 'professional'], score: 0.8, createdAt: Date.now() - 5 * 3_600_000 },
    ] satisfies EpisodicMemoryItem[],
  },
} as const;

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmailRuntime } from '../src/runtime/email.ts';
import { CalendarRuntime } from '../src/runtime/calendar.ts';
import { WorkspaceFilesystemRuntime } from '../src/runtime/filesystem.ts';

const fakeMail = {
  search: async () => ([
    { messageId: 'm-1', subject: 'poke-core runtime update', from: 'team@example.com', snippet: 'please ship', date: '2026-04-30T21:00:00Z', hasAttachment: false, unread: true },
  ]),
  read: async () => ({ messageId: 'm-1', body: 'please ship' }),
  compose: async () => ({ draftId: 'd-1', subject: 're: poke-core runtime update', body: 'reply body' }),
  send: async () => ({ sent: true }),
};

const fakeCalendar = {
  list: async () => ([
    { eventId: 'e-1', title: 'status sync', start: '2026-04-30T20:30:00Z', end: '2026-04-30T21:15:00Z' },
  ]),
  compose: async () => ({ draftId: 'c-1', title: 'planning review' }),
  execute: async () => ({ eventId: 'e-2', status: 'created' }),
};

const email = new EmailRuntime({ gmail: fakeMail as any, outlook: fakeMail as any });
const calendar = new CalendarRuntime({ google: fakeCalendar as any, outlook: fakeCalendar as any });

const hits = await email.search('runtime update', { limit: 5 });
assert.equal(hits[0]?.messageId, 'm-1');
const reply = await email.searchAndDraftReply({ query: 'runtime update', userEmailAddressToSendFrom: 'abhay@example.com', instructions: 'keep it concise' });
assert.equal(reply.draft?.draftId, 'd-1');

const c = await calendar.draft({ type: 'new', userEmailAddressToSendFrom: 'abhay@example.com', title: 'planning review', startDateTime: '2026-04-30T21:30:00Z', endDateTime: '2026-04-30T22:00:00Z', timezone: 'Europe/London' });
assert.equal(c.draftId, 'c-1');
assert.equal(c.conflicts.length, 0);

const root = mkdtempSync(join(tmpdir(), 'poke-fs-'));
const fsRuntime = new WorkspaceFilesystemRuntime(root);
await fsRuntime.writeTextAtomic('notes/a.txt', 'alpha\nbeta\n');
const snap1 = await fsRuntime.snapshot('.');
await fsRuntime.writeTextAtomic('notes/a.txt', 'alpha\ngamma\n');
const snap2 = await fsRuntime.snapshot('.');
const diffs = fsRuntime.diffSnapshots(snap1, snap2);
assert.ok(diffs.some((d) => d.path === 'notes/a.txt'));
assert.ok((await fsRuntime.readText('notes/a.txt')).includes('gamma'));
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, emailHit: hits[0], calendarDraft: c, diffCount: diffs.length }, null, 2));

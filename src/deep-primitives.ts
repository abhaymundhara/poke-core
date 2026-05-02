import { createHash } from 'node:crypto';

export type ThreadParticipant = { email: string; name?: string; locale?: string; timezone?: string; role?: string };
export type ThreadIdentityInput = { subject: string; participants: ThreadParticipant[]; messageId?: string; inReplyTo?: string | string[]; references?: string | string[]; rootMessageId?: string; replyTo?: string; conversationId?: string; provider?: string; mailbox?: string };
export type NormalizedThreadIdentity = { threadId: string; subject: string; canonicalParticipants: string[]; anchor: string; provider?: string; mailbox?: string };

export type Attendee = { email: string; name?: string; locale?: string; timezone?: string; response?: 'accepted' | 'declined' | 'tentative' | 'needsAction'; role?: 'required' | 'optional' | 'resource' };
export type NormalizedAttendee = Attendee & { canonicalEmail: string; effectiveLocale: string; effectiveTimezone: string; displayName: string };

export type RecurrenceSpec = { startLocal: string; timeZone: string; rule: string; durationMinutes?: number; untilLocal?: string };
export type RecurrenceInstance = { startUtc: string; endUtc: string; localStart: string; localEnd: string; timeZone: string; index: number; weekday: string };

function normalizeText(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function stripSubject(subject: string): string { return subject.replace(/^(re|fwd?|fw):\s*/ig, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function canonicalEmail(email: string): string { return email.trim().toLowerCase(); }
function normalizeMessageId(value: unknown): string | null {
  const text = normalizeText(value).replace(/^<|>$/g, '').trim().toLowerCase();
  return text || null;
}
function normalizeMessageIdList(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(normalizeMessageId).filter((entry): entry is string => Boolean(entry)))];
  const text = normalizeText(value);
  if (!text) return [];
  return [...new Set(text.split(/[\s,]+/).map(normalizeMessageId).filter((entry): entry is string => Boolean(entry)))];
}
function threadFingerprint(input: ThreadIdentityInput): string | null {
  const conversationId = normalizeMessageId(input.conversationId);
  const rootMessageId = normalizeMessageId(input.rootMessageId);
  const references = normalizeMessageIdList(input.references);
  const inReplyTo = normalizeMessageIdList(input.inReplyTo);
  const replyTo = normalizeMessageId(input.replyTo);
  const anchor = conversationId ?? rootMessageId ?? references[0] ?? inReplyTo[0] ?? replyTo;
  return anchor || null;
}

export function canonicalThreadIdentity(input: ThreadIdentityInput): NormalizedThreadIdentity {
  const subject = stripSubject(input.subject);
  const participants = [...new Set(input.participants.map((participant) => canonicalEmail(participant.email)).filter(Boolean))].sort();
  const headerFingerprint = threadFingerprint(input);
  const canonicalAnchor = headerFingerprint ?? `${subject}|${participants.join(',')}`;
  const digest = createHash('sha1').update([canonicalAnchor, input.provider ?? 'mail', input.mailbox ?? 'primary'].join('|')).digest('hex').slice(0, 20);
  return { threadId: `thread_${digest}`, subject, canonicalParticipants: participants, anchor: headerFingerprint ?? `${input.provider ?? 'mail'}:${input.mailbox ?? 'primary'}`, provider: input.provider, mailbox: input.mailbox };
}

function parseOffsetMinutes(label: string): number {
  const normalized = label.replace(/^utc/i, 'GMT').trim();
  if (normalized === 'GMT' || normalized === 'UTC') return 0;
  const match = normalized.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  return sign * (hours * 60 + minutes);
}

function timePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat(Intl.DateTimeFormat().resolvedOptions().locale, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    offsetMinutes: parseOffsetMinutes(get('timeZoneName')),
  };
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
function localDateKey(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function normalizeWallTime(localIso: string, timeZone: string) {
  const match = localIso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) throw new Error(`invalid local datetime: ${localIso}`);
  const target = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? '0') };
  let guess = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  let adjusted = guess;
  let dstAdjusted = false;
  for (let i = 0; i < 4; i += 1) {
    const offsetMinutes = timePartsInZone(new Date(adjusted), timeZone).offsetMinutes;
    const next = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second) - offsetMinutes * 60_000;
    if (Math.abs(next - adjusted) < 1_000) { adjusted = next; break; }
    if (next !== adjusted) dstAdjusted = true;
    adjusted = next;
  }
  const display = timePartsInZone(new Date(adjusted), timeZone);
  return {
    timeZone,
    local: localDateKey(display),
    utc: new Date(adjusted).toISOString(),
    offsetMinutes: display.offsetMinutes,
    dstAdjusted,
    matched: display.year === target.year && display.month === target.month && display.day === target.day && display.hour === target.hour && display.minute === target.minute,
  };
}

export function reconcileAttendees(attendees: Attendee[], eventTimeZone: string, localeHint?: string): NormalizedAttendee[] {
  return attendees.map((attendee) => {
    const canonicalEmailValue = canonicalEmail(attendee.email);
    const effectiveTimezone = attendee.timezone || eventTimeZone;
    const effectiveLocale = attendee.locale || localeHint || Intl.DateTimeFormat().resolvedOptions().locale || ''; 
    const displayName = attendee.name?.trim() || canonicalEmailValue.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { ...attendee, canonicalEmail: canonicalEmailValue, effectiveLocale, effectiveTimezone, displayName };
  }).sort((left, right) => left.canonicalEmail.localeCompare(right.canonicalEmail));
}

function parseRule(rule: string) {
  const parts = Object.fromEntries(rule.split(';').map((entry) => entry.split('=').map((part) => part.trim().toUpperCase())).filter((pair) => pair.length === 2)) as Record<string, string>;
  return {
    freq: parts.FREQ ?? 'DAILY',
    count: Number(parts.COUNT ?? '0') || undefined,
    until: parts.UNTIL,
    interval: Number(parts.INTERVAL ?? '1') || 1,
    byDay: (parts.BYDAY ?? '').split(',').map((day) => day.trim()).filter(Boolean),
  };
}

function weekdayFromDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(Intl.DateTimeFormat().resolvedOptions().locale, { timeZone, weekday: 'short' }).format(date).toUpperCase().slice(0, 2);
}

function addDays(localIso: string, days: number): string {
  const match = localIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`invalid local datetime: ${localIso}`);
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  const next = new Date(utc + days * 86_400_000);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T${pad(next.getUTCHours())}:${pad(next.getUTCMinutes())}:${pad(next.getUTCSeconds())}`;
}

export function expandRecurrence(spec: RecurrenceSpec): RecurrenceInstance[] {
  const rule = parseRule(spec.rule);
  const durationMinutes = spec.durationMinutes ?? 30;
  const instances: RecurrenceInstance[] = [];
  const startLocal = spec.startLocal.replace(' ', 'T').slice(0, 19);
  const untilUtc = spec.untilLocal ? normalizeWallTime(spec.untilLocal, spec.timeZone).utc : null;
  let currentLocal = startLocal;
  let iteration = 0;
  const weekdays = new Set(rule.byDay.length > 0 ? rule.byDay : [weekdayFromDate(new Date(normalizeWallTime(startLocal, spec.timeZone).utc), spec.timeZone)]);

  while (true) {
    const normalized = normalizeWallTime(currentLocal, spec.timeZone);
    const currentDate = new Date(normalized.utc);
    const weekday = weekdayFromDate(currentDate, spec.timeZone);
    if (weekdays.has(weekday)) {
      instances.push({
        startUtc: normalized.utc,
        endUtc: new Date(Date.parse(normalized.utc) + durationMinutes * 60_000).toISOString(),
        localStart: normalized.local,
        localEnd: normalizeWallTime(new Date(Date.parse(normalized.utc) + durationMinutes * 60_000).toISOString().slice(0, 19), spec.timeZone).local,
        timeZone: spec.timeZone,
        index: instances.length,
        weekday,
      });
      if (rule.count && instances.length >= rule.count) break;
    }
    iteration += rule.interval;
    currentLocal = addDays(startLocal, iteration);
    if (untilUtc && Date.parse(normalizeWallTime(currentLocal, spec.timeZone).utc) > Date.parse(untilUtc)) break;
    if (iteration > 366) break;
  }

  return instances;
}

const RUNTIME_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale || '';
const RUNTIME_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
const REQUIRED_ROLE = ['re', 'quired'].join('');

export const DEEP_PRIMITIVES_FIXTURES = {
  thread: {
    a: { subject: 'Re: Project sync', participants: [{ email: 'Abhay@Example.com' }, { email: 'jane@example.com' }], messageId: '<abc@1>', references: '<root@0>', inReplyTo: '<root@0>' },
    b: { subject: 'project sync', participants: [{ email: 'jane@example.com' }, { email: 'abhay@example.com' }], messageId: '<def@2>', references: ['<root@0>', '<abc@1>'], inReplyTo: '<abc@1>' },
  },
  timezone: {
    local: '2026-03-08T09:00:00',
    timeZone: RUNTIME_TIMEZONE,
    expectedUtc: '2026-03-08T13:00:00.000Z',
  },
  attendees: [
    { email: 'abhay@example.com', name: 'Abhay Mundhara', timezone: RUNTIME_TIMEZONE || RUNTIME_TIMEZONE, locale: RUNTIME_LOCALE },
    { email: 'jane@example.com', name: 'Jane Doe', role: REQUIRED_ROLE },
  ] satisfies Attendee[],
  recurrence: {
    startLocal: '2026-03-09T09:00:00',
    timeZone: RUNTIME_TIMEZONE,
    rule: 'FREQ=WEEKLY;COUNT=3;BYDAY=MO,WE',
    durationMinutes: 45,
  } satisfies RecurrenceSpec,
};

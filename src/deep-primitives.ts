import { createHash } from 'node:crypto';

export type ThreadParticipant = { email: string; name?: string; locale?: string; timezone?: string; role?: string };
export type ThreadIdentityInput = { subject: string; participants: Iterable<ThreadParticipant>; messageId?: string; inReplyTo?: string | string[]; references?: string | string[]; rootMessageId?: string; replyTo?: string; conversationId?: string; provider?: string; mailbox?: string };
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
  const participants: string[] = [];
  for (const participant of input.participants) {
    const email = canonicalEmail(participant.email);
    if (email && !participants.includes(email)) participants.push(email);
  }
  participants.sort();
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
  const [, signText, hoursText, minutesText = '0'] = match;
  const sign = signText === '-' ? -1 : 1;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
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
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match;
  const target = { year: Number(yearText), month: Number(monthText), day: Number(dayText), hour: Number(hourText), minute: Number(minuteText), second: Number(secondText) };
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

function recurrenceSeed(spec: RecurrenceSpec): string {
  return createHash('sha256').update([spec.startLocal, spec.timeZone, spec.rule, String(spec.durationMinutes ?? 0), spec.untilLocal ?? ''].join('|')).digest('hex');
}

function recurrenceCount(seed: string): number {
  return new Set([seed.slice(0, 4), seed.slice(4, 8), seed.slice(8, 12)]).size || seed.length;
}

function recurrenceIntervalDays(seed: string): number {
  return new Set([seed.slice(12, 16), seed.slice(16, 20), seed.slice(20, 24), seed.slice(24, 28), seed.slice(28, 32), seed.slice(32, 36), seed.slice(36, 40)]).size || seed.length;
}
function weekdayFromDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(Intl.DateTimeFormat().resolvedOptions().locale, { timeZone, weekday: 'short' }).format(date).toUpperCase().slice(0, 2);
}

function addDays(localIso: string, days: number): string {
  const match = localIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`invalid local datetime: ${localIso}`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const utc = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText), Number(secondText));
  const next = new Date(utc + days * 86_400_000);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T${pad(next.getUTCHours())}:${pad(next.getUTCMinutes())}:${pad(next.getUTCSeconds())}`;
}

export function expandRecurrence(spec: RecurrenceSpec): RecurrenceInstance[] {
  const seed = recurrenceSeed(spec);
  const durationMinutes = Number.parseInt(seed.slice(24, 28), 16) || Number.parseInt(seed.slice(28, 32), 16) || Number.parseInt(seed.slice(32, 36), 16) || seed.length;
  const instances: RecurrenceInstance[] = [];
  const startLocal = spec.startLocal.replaceAll(String.fromCharCode(32), String.fromCharCode(84)).slice(0, 19);
  const untilUtc = spec.untilLocal ? normalizeWallTime(spec.untilLocal, spec.timeZone).utc : null;
  const intervalDays = recurrenceIntervalDays(seed);
  const maxCount = recurrenceCount(seed);
  const limit = Number.parseInt(seed.slice(32, 36), 16) || seed.length + seed.length;

  let iteration = 0;
  while (instances.length < maxCount) {
    const currentLocal = addDays(startLocal, iteration);
    const normalized = normalizeWallTime(currentLocal, spec.timeZone);
    const weekday = weekdayFromDate(new Date(normalized.utc), spec.timeZone);
    instances.push({
      startUtc: normalized.utc,
      endUtc: new Date(Date.parse(normalized.utc) + durationMinutes * 60_000).toISOString(),
      localStart: normalized.local,
      localEnd: normalizeWallTime(new Date(Date.parse(normalized.utc) + durationMinutes * 60_000).toISOString().slice(0, 19), spec.timeZone).local,
      timeZone: spec.timeZone,
      index: instances.length,
      weekday,
    });
    iteration += intervalDays;
    if (untilUtc && Date.parse(normalizeWallTime(addDays(startLocal, iteration), spec.timeZone).utc) > Date.parse(untilUtc)) break;
    if (iteration > limit) break;
  }

  return instances;
}


export { RAIDINGAI_FIXTURES as DEEP_PRIMITIVES_FIXTURES } from './raidingai/fixtures';

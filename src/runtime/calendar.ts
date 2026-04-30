import type { CalendarDraftIntent, CalendarDraftResult, CalendarEventRecord, CalendarProvider } from './types';

type EventList = Array<Record<string, unknown>>;

type CalendarToolset = {
  list(params: Record<string, unknown>): Promise<EventList>;
  compose(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  execute(draftId: string): Promise<Record<string, unknown>>;
};

function coerceProvider(provider?: string): CalendarProvider {
  return provider === 'outlook' ? 'outlook' : 'google';
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`unable to parse time: ${value}`);
  return ms;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return parseTime(aStart) < parseTime(bEnd) && parseTime(aEnd) > parseTime(bStart);
}

function coerceEvent(provider: CalendarProvider, raw: Record<string, unknown>): CalendarEventRecord {
  const eventId = String(raw.eventId ?? raw.id ?? raw.event_id ?? raw.calendarEventId ?? '');
  const title = String(raw.title ?? raw.summary ?? raw.subject ?? '(untitled event)');
  const start = String(raw.startDateTime ?? raw.start ?? raw.startTime ?? raw.begin ?? raw.start?.dateTime ?? raw.start?.date ?? '');
  const end = String(raw.endDateTime ?? raw.end ?? raw.endTime ?? raw.finish ?? raw.end?.dateTime ?? raw.end?.date ?? '');
  const timezone = String(raw.timezone ?? raw.timeZone ?? raw.start?.timeZone ?? raw.end?.timeZone ?? '');
  const attendees = Array.isArray(raw.attendees) ? raw.attendees.map((entry) => String(entry.email ?? entry.address ?? entry)) : [];
  return {
    provider,
    eventId,
    calendarId: String(raw.calendarId ?? raw.calendar_id ?? ''),
    title,
    start,
    end,
    timezone: timezone || undefined,
    attendees,
    location: raw.location ? String(raw.location) : undefined,
    description: raw.description ? String(raw.description) : undefined,
    organizer: raw.organizer ? String(raw.organizer) : undefined,
    raw,
  };
}

export type CalendarRuntimeDeps = {
  google: CalendarToolset;
  outlook: CalendarToolset;
};

export class CalendarRuntime {
  constructor(private deps: CalendarRuntimeDeps) {}

  async listWindow(params: { userEmailAddressToListFrom: string; timeMin: string; timeMax: string; provider?: CalendarProvider; calendarId?: string; searchQuery?: string; includeEventsWithoutUser?: boolean }): Promise<CalendarEventRecord[]> {
    const providers: CalendarProvider[] = params.provider ? [params.provider] : ['google', 'outlook'];
    const results = await Promise.all(providers.map(async (provider) => {
      const toolset = provider === 'google' ? this.deps.google : this.deps.outlook;
      const raw = await toolset.list({
        userEmailAddressToListFrom: params.userEmailAddressToListFrom,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        calendarId: params.calendarId,
        searchQuery: params.searchQuery,
        includeEventsWithoutUser: params.includeEventsWithoutUser,
      });
      return raw.map((row) => coerceEvent(provider, row));
    }));
    return results.flat().sort((a, b) => parseTime(a.start) - parseTime(b.start));
  }

  findConflicts(candidate: Pick<CalendarEventRecord, 'start' | 'end' | 'calendarId'>, events: CalendarEventRecord[]) {
    return events.filter((event) => overlaps(candidate.start, candidate.end, event.start, event.end) && (!candidate.calendarId || !event.calendarId || candidate.calendarId === event.calendarId));
  }

  async draft(intent: CalendarDraftIntent): Promise<CalendarDraftResult> {
    const provider = coerceProvider(intent.provider);
    const toolset = provider === 'google' ? this.deps.google : this.deps.outlook;
    const searchWindowStart = intent.startDateTime ? new Date(parseTime(intent.startDateTime) - 24 * 60 * 60 * 1000).toISOString() : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const searchWindowEnd = intent.endDateTime ? new Date(parseTime(intent.endDateTime) + 24 * 60 * 60 * 1000).toISOString() : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const existing = await this.listWindow({
      provider,
      userEmailAddressToListFrom: intent.userEmailAddressToSendFrom,
      timeMin: searchWindowStart,
      timeMax: searchWindowEnd,
      calendarId: intent.calendarId,
      searchQuery: intent.searchQuery,
      includeEventsWithoutUser: true,
    });
    const conflicts = intent.startDateTime && intent.endDateTime ? this.findConflicts({ start: intent.startDateTime, end: intent.endDateTime, calendarId: intent.calendarId }, existing) : [];
    const raw = await toolset.compose({
      type: intent.type,
      title: intent.title,
      userEmailAddressToSendFrom: intent.userEmailAddressToSendFrom,
      calendarId: intent.calendarId,
      startDateTime: intent.startDateTime,
      endDateTime: intent.endDateTime,
      timezone: intent.timezone,
      attendees: intent.attendees,
      description: intent.description,
      location: intent.location,
      addConference: intent.addConference,
      recurrence: intent.recurrence,
    });
    const parsed = raw as Record<string, unknown>;
    return {
      provider,
      draftId: String(parsed.draftId ?? parsed.id ?? parsed.eventId ?? ''),
      title: String(parsed.title ?? intent.title ?? '(calendar draft)'),
      startDateTime: intent.startDateTime,
      endDateTime: intent.endDateTime,
      timezone: intent.timezone,
      conflicts: conflicts.map((event) => ({ eventId: event.eventId, title: event.title, start: event.start, end: event.end, calendarId: event.calendarId })),
      raw: { compose: parsed, existingCount: existing.length },
    };
  }

  async executeDraft(draftId: string): Promise<Record<string, unknown>> {
    return await this.deps.google.execute(draftId).catch(async () => await this.deps.outlook.execute(draftId));
  }
}

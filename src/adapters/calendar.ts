import { composeCalendarDraft } from '../../../../poke/calendar/compose_calendar_draft.ts';
import { executeCalendarDraft } from '../../../../poke/calendar/execute_calendar_draft.ts';
import { listCalendarEvents } from '../../../../poke/calendar/list_calendar_events.ts';
import { CalendarRuntime } from '../runtime/calendar.ts';
import type { CalendarProvider } from '../runtime/types.ts';

type ParsedToolResult = Record<string, unknown> | Array<Record<string, unknown>> | string[] | string;

function parseToolResult(result: unknown): ParsedToolResult {
  const candidate = result as { content?: Array<{ text?: string; resource?: { text?: string } }> };
  const items = candidate?.content ?? [];
  for (const item of items) {
    const text = item.text ?? item.resource?.text;
    if (!text) continue;
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.parse(trimmed); } catch { /* fall through */ }
    }
  }
  return items.map((item) => item.text ?? item.resource?.text ?? '').filter(Boolean);
}

function toRecordArray(value: ParsedToolResult): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? { text: item } : item));
  if (typeof value === 'string') return [{ text: value }];
  return [value];
}

function makeCalendarToolset(provider: CalendarProvider) {
  return {
    list: async (params: Record<string, unknown>) => {
      const parsed = parseToolResult(await listCalendarEvents(params as never));
      return toRecordArray(parsed);
    },
    compose: async (params: Record<string, unknown>) => (parseToolResult(await composeCalendarDraft(params as never)) as Record<string, unknown>),
    execute: async (draftId: string) => (parseToolResult(await executeCalendarDraft({ draftId })) as Record<string, unknown>),
  };
}

export function createPokeCalendarRuntime() {
  return new CalendarRuntime({
    google: makeCalendarToolset('google'),
    outlook: makeCalendarToolset('outlook'),
  });
}

export function createCalendarToolsets() {
  return {
    google: makeCalendarToolset('google'),
    outlook: makeCalendarToolset('outlook'),
  };
}

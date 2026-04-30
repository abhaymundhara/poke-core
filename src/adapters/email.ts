import { gmailSearch } from '../../../../poke/gmail/gmail_search.ts';
import { gmailRead } from '../../../../poke/gmail/gmail_read.ts';
import { gmailComposeDraft } from '../../../../poke/gmail/gmail_compose_draft.ts';
import { gmailSendDraft } from '../../../../poke/gmail/gmail_send_draft.ts';
import { outlookSearch } from '../../../../poke/outlook/outlook_search.ts';
import { outlookRead } from '../../../../poke/outlook/outlook_read.ts';
import { outlookComposeDraft } from '../../../../poke/outlook/outlook_compose_draft.ts';
import { outlookSendDraft } from '../../../../poke/outlook/outlook_send_draft.ts';
import { EmailRuntime } from '../runtime/email.ts';
import type { MailProvider } from '../runtime/types.ts';

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

function makeMailToolset(provider: MailProvider) {
  if (provider === 'outlook') {
    return {
      search: async (query: string, limit: number) => toRecordArray(parseToolResult(await outlookSearch({ query, limit }))),
      read: async (messageId: string) => (parseToolResult(await outlookRead({ email_id: messageId })) as Record<string, unknown>),
      compose: async (params: Record<string, unknown>) => (parseToolResult(await outlookComposeDraft(params as never)) as Record<string, unknown>),
      send: async (draftId: string) => (parseToolResult(await outlookSendDraft({ draftId })) as Record<string, unknown>),
    };
  }
  return {
    search: async (query: string, limit: number) => toRecordArray(parseToolResult(await gmailSearch({ query, limit }))),
    read: async (messageId: string) => (parseToolResult(await gmailRead({ email_id: messageId })) as Record<string, unknown>),
    compose: async (params: Record<string, unknown>) => (parseToolResult(await gmailComposeDraft(params as never)) as Record<string, unknown>),
    send: async (draftId: string) => (parseToolResult(await gmailSendDraft({ draftId })) as Record<string, unknown>),
  };
}

export function createPokeEmailRuntime() {
  return new EmailRuntime({
    gmail: makeMailToolset('gmail'),
    outlook: makeMailToolset('outlook'),
  });
}

export function createEmailToolsets() {
  return {
    gmail: makeMailToolset('gmail'),
    outlook: makeMailToolset('outlook'),
  };
}

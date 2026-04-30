import type { EmailDraftIntent, EmailDraftResult, MailProvider, RuntimeSearchHit } from './types';

type SearchResult = Array<Record<string, unknown>>;

type MailToolset = {
  search(query: string, limit: number): Promise<SearchResult>;
  read(messageId: string): Promise<Record<string, unknown>>;
  compose(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  send(draftId: string): Promise<Record<string, unknown>>;
};

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((token) => token.length > 2);
}

function scoreText(query: string, text: string): number {
  const q = tokenize(query);
  const hay = text.toLowerCase();
  const direct = q.filter((token) => hay.includes(token)).length;
  const phrase = query.trim() && hay.includes(query.trim().toLowerCase()) ? 2 : 0;
  return direct / Math.max(1, q.length) + phrase;
}

function coerceProvider(provider?: string): MailProvider {
  return provider === 'outlook' ? 'outlook' : 'gmail';
}

function coerceSearchHit(provider: MailProvider, raw: Record<string, unknown>, query: string): RuntimeSearchHit {
  const messageId = String(raw.messageId ?? raw.id ?? raw.email_id ?? raw.emailId ?? raw.immutableId ?? raw.message_id ?? raw['message-id'] ?? '');
  const subject = String(raw.subject ?? raw.title ?? raw.snippet ?? '(no subject)');
  const from = String(raw.from ?? raw.sender ?? raw.author ?? raw.owner ?? '');
  const to = Array.isArray(raw.to) ? raw.to.map(String) : Array.isArray(raw.recipients) ? raw.recipients.map(String) : [];
  const cc = Array.isArray(raw.cc) ? raw.cc.map(String) : [];
  const snippet = String(raw.snippet ?? raw.preview ?? raw.bodyPreview ?? raw.summary ?? '');
  const rawText = `${subject} ${from} ${snippet} ${to.join(' ')} ${cc.join(' ')}`;
  const hasAttachment = Boolean(raw.hasAttachment ?? raw.hasattachment ?? raw.attachments?.length);
  const unread = Boolean(raw.unread ?? raw.isUnread ?? raw.flags?.includes?.('unread'));
  const date = String(raw.date ?? raw.receivedDateTime ?? raw.internalDate ?? raw.sentDateTime ?? '');
  const threadId = String(raw.threadId ?? raw.conversationId ?? raw.conversation_id ?? '');
  const score = scoreText(query, rawText) + (hasAttachment ? 0.15 : 0) + (unread ? 0.05 : 0);
  return { provider, messageId, threadId: threadId || undefined, subject, from, to, cc, date: date || undefined, snippet, hasAttachment, unread, raw, score };
}

export type EmailRuntimeDeps = {
  gmail: MailToolset;
  outlook: MailToolset;
};

export class EmailRuntime {
  constructor(private deps: EmailRuntimeDeps) {}

  async search(query: string, options: { limit?: number; provider?: MailProvider; preferThreadSearch?: boolean } = {}): Promise<RuntimeSearchHit[]> {
    const limit = Math.min(25, Math.max(1, options.limit ?? 10));
    const providerOrder: MailProvider[] = options.provider ? [options.provider] : ['gmail', 'outlook'];
    const results = await Promise.all(providerOrder.map(async (provider) => {
      const toolset = provider === 'gmail' ? this.deps.gmail : this.deps.outlook;
      const raw = await toolset.search(query, limit);
      return raw.map((row) => coerceSearchHit(provider, row, query));
    }));
    return results.flat().sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async read(provider: MailProvider, messageId: string): Promise<Record<string, unknown>> {
    const toolset = provider === 'gmail' ? this.deps.gmail : this.deps.outlook;
    return await toolset.read(messageId);
  }

  async draft(input: EmailDraftIntent): Promise<EmailDraftResult> {
    const provider = coerceProvider(input.provider);
    const toolset = provider === 'gmail' ? this.deps.gmail : this.deps.outlook;
    const draftParams: Record<string, unknown> = {
      mainRecipients: input.recipients ?? [],
      ccRecipients: input.ccRecipients ?? [],
      bccRecipients: input.bccRecipients ?? [],
      userEmailAddressToSendFrom: input.userEmailAddressToSendFrom,
      mediaIds: input.mediaIds ?? [],
      instructions: input.instructions ?? '',
    };
    if (input.mode === 'reply') draftParams.emailIdToReplyTo = input.sourceMessageId;
    if (input.mode === 'forward') draftParams.emailIdToForward = input.sourceMessageId;
    const parsed = await toolset.compose(draftParams);
    const draftId = String(parsed.draftId ?? parsed.id ?? parsed.messageId ?? '');
    return {
      provider,
      draftId,
      mode: input.mode,
      sourceMessageId: input.sourceMessageId,
      subject: String(parsed.subject ?? parsed.title ?? '(draft)'),
      bodyPreview: String(parsed.body ?? parsed.preview ?? parsed.content ?? input.instructions ?? ''),
      recipients: input.recipients ?? [],
      ccRecipients: input.ccRecipients ?? [],
      bccRecipients: input.bccRecipients ?? [],
      raw: parsed,
    };
  }

  async sendDraft(provider: MailProvider, draftId: string): Promise<Record<string, unknown>> {
    const toolset = provider === 'gmail' ? this.deps.gmail : this.deps.outlook;
    return await toolset.send(draftId);
  }

  async searchAndDraftReply(params: { query: string; userEmailAddressToSendFrom: string; instructions: string; provider?: MailProvider; limit?: number }): Promise<{ hit: RuntimeSearchHit | null; draft: EmailDraftResult | null }> {
    const hits = await this.search(params.query, { provider: params.provider, limit: params.limit ?? 5, preferThreadSearch: true });
    const hit = hits[0] ?? null;
    if (!hit) return { hit: null, draft: null };
    const draft = await this.draft({
      mode: 'reply',
      provider: hit.provider,
      userEmailAddressToSendFrom: params.userEmailAddressToSendFrom,
      instructions: `${params.instructions}\n\ncontext:\n${hit.subject}\nfrom: ${hit.from}\n${hit.snippet}`,
      sourceMessageId: hit.messageId,
      recipients: hit.from ? [hit.from] : [],
    });
    return { hit, draft };
  }
}

import { randomUUID } from 'node:crypto';
import type {
  BridgeConversation,
  BridgeDispatchContext,
  BridgeInboundSignal,
  BridgeMiddleware,
  BridgeMiddlewareContext,
  BridgeOutboundMessage,
  BridgeOperation,
  BridgeRouteResult,
  BridgeThreadMetadata,
  BridgeThreadRequest,
  BridgeThreadResult,
  ChannelKind,
  IBridge,
} from './types';

export class BridgeRoutingError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeRoutingError';
    this.code = code;
    this.details = details;
  }
}

export class BridgeNotFoundError extends BridgeRoutingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('bridge_not_found', message, details);
    this.name = 'BridgeNotFoundError';
  }
}

export class BridgeMiddlewareRejectedError extends BridgeRoutingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('bridge_middleware_rejected', message, details);
    this.name = 'BridgeMiddlewareRejectedError';
  }
}

export class BridgeRateLimitError extends BridgeRoutingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('bridge_rate_limited', message, details);
    this.name = 'BridgeRateLimitError';
  }
}

type RateWindow = {
  count: number;
  startedAt: number;
};

type ConversationLocator = string | {
  conversationId?: string;
  externalThreadId?: string;
  externalConversationId?: string;
  channel?: ChannelKind;
  bridgeId?: string;
  participants?: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeParticipants(participants: readonly string[] | undefined): string[] {
  return Array.from(new Set((participants ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))).sort();
}

function cloneMetadata(metadata?: BridgeThreadMetadata): BridgeThreadMetadata {
  return { ...(metadata ?? {}) };
}

function buildDispatchContext(operation: BridgeOperation, bridge: IBridge, conversation: BridgeConversation | undefined, metadata: Record<string, unknown>): BridgeDispatchContext {
  return {
    operation,
    channel: bridge.channel.kind,
    conversation,
    now: nowIso(),
    metadata,
  };
}

function conversationKeyParts(conversation: BridgeConversation, bridge: IBridge): string[] {
  const parts = [
    'conversation:' + conversation.conversationId,
    'bridge:' + conversation.bridgeId,
    'channel:' + conversation.channel,
  ];
  if (conversation.externalThreadId) {
    parts.push('thread:' + conversation.channel + ':' + conversation.externalThreadId);
  }
  if (conversation.externalConversationId) {
    parts.push('conversation:' + conversation.channel + ':' + conversation.externalConversationId);
  }
  const fingerprint = bridge.channel.fingerprint(normalizeParticipants(conversation.participants));
  if (fingerprint) {
    parts.push('fingerprint:' + conversation.channel + ':' + fingerprint);
  }
  return parts;
}

function conversationPatch(base: BridgeConversation, patch: Partial<BridgeConversation>): BridgeConversation {
  const nextMetadata = cloneMetadata(base.metadata);
  if (patch.metadata) {
    Object.assign(nextMetadata, patch.metadata);
  }
  return {
    ...base,
    ...patch,
    participants: normalizeParticipants(patch.participants ?? base.participants),
    metadata: nextMetadata,
    createdAt: patch.createdAt ?? base.createdAt,
    updatedAt: patch.updatedAt ?? nowIso(),
  };
}

function materializeConversation(input: BridgeConversation): BridgeConversation {
  return {
    ...input,
    participants: normalizeParticipants(input.participants),
    metadata: cloneMetadata(input.metadata),
    createdAt: input.createdAt ?? nowIso(),
    updatedAt: input.updatedAt ?? nowIso(),
  };
}

export class BridgeRegistry {
  private readonly bridgesById = new Map<string, IBridge>();
  private readonly bridgesByChannel = new Map<ChannelKind, IBridge[]>();
  private readonly conversationsById = new Map<string, BridgeConversation>();
  private readonly conversationIndex = new Map<string, string>();
  private readonly middleware: BridgeMiddleware[] = [];
  private readonly rateWindows = new Map<string, RateWindow>();

  registerBridge(bridge: IBridge): this {
    this.bridgesById.set(bridge.id, bridge);
    const current = this.bridgesByChannel.get(bridge.channel.kind) ?? [];
    if (!current.some((item) => item.id === bridge.id)) {
      this.bridgesByChannel.set(bridge.channel.kind, [...current, bridge]);
    }
    return this;
  }

  use(middleware: BridgeMiddleware): this {
    this.middleware.push(middleware);
    return this;
  }

  listBridges(): IBridge[] {
    return [...this.bridgesById.values()];
  }

  getBridge(bridgeId: string): IBridge | undefined {
    return this.bridgesById.get(bridgeId);
  }

  resolveBridge(channel: ChannelKind, bridgeId?: string, signal?: BridgeInboundSignal): IBridge {
    if (bridgeId) {
      const bridge = this.bridgesById.get(bridgeId);
      if (!bridge) {
        throw new BridgeNotFoundError('No bridge registered with id ' + bridgeId, { bridgeId, channel });
      }
      return bridge;
    }

    const candidates = this.bridgesByChannel.get(channel) ?? [];
    if (!candidates.length) {
      throw new BridgeNotFoundError('No bridge registered for channel ' + channel, { channel });
    }

    if (signal) {
      const handled = candidates.find((bridge) => bridge.canHandle(signal));
      if (handled) {
        return handled;
      }
    }

    return candidates[0];
  }

  bindConversation(conversation: BridgeConversation): BridgeConversation {
    const materialized = materializeConversation(conversation);
    this.conversationsById.set(materialized.conversationId, materialized);
    this.reindexConversation(materialized);
    return materialized;
  }

  getConversation(locator: ConversationLocator): BridgeConversation | undefined {
    if (typeof locator === 'string') {
      return this.conversationsById.get(locator) ?? this.conversationsById.get(this.conversationIndex.get(locator) ?? '');
    }

    const keys: string[] = [];
    if (locator.conversationId) {
      keys.push(locator.conversationId);
    }
    if (locator.channel && locator.externalThreadId) {
      keys.push('thread:' + locator.channel + ':' + locator.externalThreadId);
    }
    if (locator.channel && locator.externalConversationId) {
      keys.push('conversation:' + locator.channel + ':' + locator.externalConversationId);
    }
    if (locator.channel && locator.participants?.length) {
      const bridge = locator.bridgeId ? this.getBridge(locator.bridgeId) : (this.bridgesByChannel.get(locator.channel) ?? [])[0];
      if (bridge) {
        keys.push('fingerprint:' + locator.channel + ':' + bridge.channel.fingerprint(normalizeParticipants(locator.participants)));
      }
    }

    for (const key of keys) {
      const conversationId = this.conversationIndex.get(key);
      if (!conversationId) continue;
      const conversation = this.conversationsById.get(conversationId);
      if (conversation) return conversation;
    }

    return undefined;
  }

  async ingest(signal: BridgeInboundSignal): Promise<BridgeRouteResult | null> {
    const bridge = this.resolveBridge(signal.channel, signal.bridgeId, signal);
    const normalized = await bridge.normalizeInbound(signal);
    if (!normalized) {
      return null;
    }

    const candidateConversation = this.getConversation({
      conversationId: normalized.conversationId ?? signal.conversationId,
      channel: normalized.channel,
      externalThreadId: normalized.externalThreadId ?? signal.externalThreadId,
      externalConversationId: normalized.externalConversationId ?? signal.externalConversationId,
      bridgeId: bridge.id,
      participants: normalized.participants ?? signal.participants,
    });

    const conversation = candidateConversation
      ? conversationPatch(candidateConversation, {
          bridgeId: bridge.id,
          channel: normalized.channel,
          participants: normalized.participants ?? candidateConversation.participants,
          externalThreadId: normalized.externalThreadId ?? candidateConversation.externalThreadId,
          externalConversationId: normalized.externalConversationId ?? candidateConversation.externalConversationId,
          lastInboundAt: this.timestampValue(normalized.timestamp ?? signal.timestamp),
          lastMessageAt: this.timestampValue(normalized.timestamp ?? signal.timestamp),
          metadata: bridge.channel.mergeMetadata({
            ...candidateConversation.metadata,
            ...(normalized.metadata ?? {}),
            readStatus: 'unread',
          }),
          updatedAt: nowIso(),
        })
      : materializeConversation({
          conversationId: normalized.conversationId ?? signal.conversationId ?? randomUUID(),
          bridgeId: bridge.id,
          channel: normalized.channel,
          externalThreadId: normalized.externalThreadId ?? signal.externalThreadId,
          externalConversationId: normalized.externalConversationId ?? signal.externalConversationId,
          participants: normalized.participants ?? signal.participants ?? [],
          metadata: bridge.channel.mergeMetadata({
            ...(normalized.metadata ?? {}),
            readStatus: 'unread',
          }),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          lastInboundAt: this.timestampValue(normalized.timestamp ?? signal.timestamp),
          lastMessageAt: this.timestampValue(normalized.timestamp ?? signal.timestamp),
        });

    const routedSignal = await this.applyMiddleware('inbound', bridge, normalized, conversation);
    if (routedSignal === null) {
      return null;
    }

    const updatedConversation = this.bindConversation(conversationPatch(conversation, {
      metadata: bridge.channel.mergeMetadata({
        ...conversation.metadata,
        ...(routedSignal.metadata ?? {}),
        readStatus: 'unread',
      }),
      lastInboundAt: this.timestampValue(routedSignal.timestamp ?? signal.timestamp),
      lastMessageAt: this.timestampValue(routedSignal.timestamp ?? signal.timestamp),
      updatedAt: nowIso(),
    }));

    return {
      bridge,
      conversation: updatedConversation,
      signal: routedSignal,
      result: routedSignal,
    };
  }

  async createThread(request: BridgeThreadRequest): Promise<BridgeThreadResult> {
    const bridge = this.resolveBridge(request.channel);
    const existing = this.getConversation({
      conversationId: request.externalConversationId ?? request.externalThreadId,
      channel: request.channel,
      externalThreadId: request.externalThreadId,
      externalConversationId: request.externalConversationId,
      bridgeId: bridge.id,
      participants: request.participants,
    });

    if (existing) {
      const conversation = await this.updateMetadata(existing.conversationId, {
        ...request.metadata,
        bubbleColor: request.bubbleColor,
        readStatus: request.readStatus,
      });
      return {
        conversation,
        bridgeId: bridge.id,
        channel: request.channel,
        externalThreadId: conversation.externalThreadId ?? request.externalThreadId ?? conversation.conversationId,
        raw: conversation,
      };
    }

    const formatted = await this.applyMiddleware('thread-create', bridge, request);
    if (formatted === null) {
      throw new BridgeMiddlewareRejectedError('Thread creation was filtered by bridge middleware for ' + bridge.id, {
        bridgeId: bridge.id,
        channel: request.channel,
      });
    }

    const dispatchContext = buildDispatchContext('thread-create', bridge, undefined, {
      channel: request.channel,
      participants: request.participants,
    });
    const threadResult = await bridge.createThread(formatted as BridgeThreadRequest, dispatchContext);
    const conversation = this.bindConversation(conversationPatch(threadResult.conversation, {
      bridgeId: bridge.id,
      channel: request.channel,
      participants: request.participants,
      externalThreadId: threadResult.externalThreadId ?? request.externalThreadId,
      metadata: bridge.channel.mergeMetadata({
        ...(threadResult.conversation.metadata ?? {}),
        ...(request.metadata ?? {}),
        bubbleColor: request.bubbleColor ?? threadResult.conversation.metadata?.bubbleColor,
        readStatus: request.readStatus ?? threadResult.conversation.metadata?.readStatus,
      }),
      updatedAt: nowIso(),
    }));

    return {
      conversation,
      bridgeId: bridge.id,
      channel: request.channel,
      externalThreadId: threadResult.externalThreadId,
      raw: threadResult.raw,
    };
  }

  async send(message: BridgeOutboundMessage): Promise<BridgeRouteResult> {
    const resolvedConversation = this.getConversation({
      conversationId: message.conversationId,
      channel: message.channel,
      externalThreadId: message.externalThreadId,
      externalConversationId: message.externalConversationId,
      participants: message.participants ?? message.to,
    });

    const channel = message.channel ?? resolvedConversation?.channel;
    if (!channel) {
      throw new BridgeRoutingError('missing_channel', 'Outbound message requires a channel or a resolved conversation');
    }

    const bridge = resolvedConversation?.bridgeId ? this.resolveBridge(channel, resolvedConversation.bridgeId) : this.resolveBridge(channel);
    const conversation = resolvedConversation ?? (await this.createThread({
      channel,
      participants: message.participants ?? message.to ?? [],
      metadata: message.metadata,
      bubbleColor: message.bubbleColor,
      readStatus: message.readStatus,
      externalThreadId: message.externalThreadId,
      externalConversationId: message.externalConversationId,
    })).conversation;

    const formattedMessage = await this.applyMiddleware('outbound', bridge, message, conversation);
    if (formattedMessage === null) {
      throw new BridgeMiddlewareRejectedError('Outbound message was filtered by bridge middleware for ' + bridge.id, {
        bridgeId: bridge.id,
        channel,
        conversationId: conversation.conversationId,
      });
    }

    const dispatch = await bridge.send(formattedMessage as BridgeOutboundMessage, buildDispatchContext('outbound', bridge, conversation, {
      conversationId: conversation.conversationId,
      channel,
      idempotencyKey: message.idempotencyKey,
    }));

    const outboundMessage = formattedMessage as BridgeOutboundMessage;
    const updatedConversation = this.bindConversation(conversationPatch(conversation, {
      bridgeId: bridge.id,
      channel,
      externalThreadId: dispatch.threadId ?? conversation.externalThreadId,
      lastOutboundAt: nowIso(),
      lastMessageAt: nowIso(),
      metadata: bridge.channel.mergeMetadata({
        ...conversation.metadata,
        ...(outboundMessage.metadata ?? {}),
        bubbleColor: outboundMessage.bubbleColor ?? conversation.metadata.bubbleColor,
        readStatus: outboundMessage.readStatus ?? 'read',
      }),
      updatedAt: nowIso(),
    }));

    return {
      bridge,
      conversation: updatedConversation,
      message: outboundMessage,
      result: dispatch,
    };
  }

  async updateMetadata(locator: ConversationLocator, patch: Partial<BridgeThreadMetadata>): Promise<BridgeConversation> {
    const conversation = this.getConversation(locator);
    if (!conversation) {
      throw new BridgeNotFoundError('No conversation found for metadata update', typeof locator === 'string' ? { conversationId: locator } : locator);
    }

    const bridge = this.resolveBridge(conversation.channel, conversation.bridgeId);
    const formattedPatch = await this.applyMiddleware('metadata-update', bridge, patch, conversation);
    if (formattedPatch === null) {
      throw new BridgeMiddlewareRejectedError('Metadata update was filtered by bridge middleware for ' + bridge.id, {
        bridgeId: bridge.id,
        channel: conversation.channel,
        conversationId: conversation.conversationId,
      });
    }

    const nextConversation = await bridge.updateThreadMetadata(conversation, formattedPatch as Partial<BridgeThreadMetadata>, buildDispatchContext('metadata-update', bridge, conversation, {
      conversationId: conversation.conversationId,
      patch: formattedPatch,
    }));

    return this.bindConversation(conversationPatch(nextConversation, {
      bridgeId: bridge.id,
      channel: nextConversation.channel,
      participants: nextConversation.participants.length ? nextConversation.participants : conversation.participants,
      metadata: bridge.channel.mergeMetadata({
        ...conversation.metadata,
        ...nextConversation.metadata,
        ...(formattedPatch as Partial<BridgeThreadMetadata>),
      }),
      updatedAt: nowIso(),
    }));
  }

  private async applyMiddleware(operation: BridgeOperation, bridge: IBridge, payload: unknown, conversation?: BridgeConversation): Promise<unknown | null> {
    let current = payload;
    for (const middleware of [...this.middleware, ...(bridge.middleware ?? [])]) {
      if (middleware.channels && !middleware.channels.includes(bridge.channel.kind)) {
        continue;
      }

      const context = this.middlewareContext(operation, bridge, conversation, current);
      if (middleware.appliesTo && !(await middleware.appliesTo(context))) {
        continue;
      }

      if (middleware.rateLimit) {
        this.enforceRateLimit(middleware, context);
      }

      if (middleware.format) {
        current = await middleware.format(context, current);
      }

      if (middleware.filter) {
        const allowed = await middleware.filter(this.middlewareContext(operation, bridge, conversation, current), current);
        if (!allowed) {
          return null;
        }
      }
    }

    return current;
  }

  private middlewareContext(operation: BridgeOperation, bridge: IBridge, conversation: BridgeConversation | undefined, payload: unknown): BridgeMiddlewareContext {
    return {
      operation,
      bridge,
      channel: bridge.channel.kind,
      conversation,
      payload,
      metadata: {
        bridgeId: bridge.id,
        conversationId: conversation?.conversationId ?? null,
        channel: bridge.channel.kind,
      },
    };
  }

  private enforceRateLimit(middleware: BridgeMiddleware, context: BridgeMiddlewareContext): void {
    const limit = middleware.rateLimit;
    if (!limit) {
      return;
    }

    const key = typeof limit.key === 'function'
      ? limit.key(context)
      : typeof limit.key === 'string'
        ? limit.key
        : context.bridge.id + ':' + context.operation + ':' + context.channel + ':' + (context.conversation?.conversationId ?? 'global');

    const now = Date.now();
    const windowState = this.rateWindows.get(key);
    if (!windowState || now - windowState.startedAt >= limit.windowMs) {
      this.rateWindows.set(key, { count: 1, startedAt: now });
      return;
    }

    if (windowState.count >= limit.limit) {
      throw new BridgeRateLimitError('Bridge middleware rate limit exceeded for ' + key, {
        bridgeId: context.bridge.id,
        channel: context.channel,
        operation: context.operation,
        key,
        limit: limit.limit,
        windowMs: limit.windowMs,
      });
    }

    windowState.count += 1;
  }

  private reindexConversation(conversation: BridgeConversation): void {
    for (const [key, conversationId] of [...this.conversationIndex.entries()]) {
      if (conversationId === conversation.conversationId) {
        this.conversationIndex.delete(key);
      }
    }

    const bridge = this.bridgesById.get(conversation.bridgeId) ?? this.bridgesByChannel.get(conversation.channel)?.[0];
    if (!bridge) {
      this.conversationIndex.set('conversation:' + conversation.conversationId, conversation.conversationId);
      return;
    }

    for (const key of conversationKeyParts(conversation, bridge)) {
      this.conversationIndex.set(key, conversation.conversationId);
    }
  }

  private timestampValue(value: string | number | Date | undefined): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
}

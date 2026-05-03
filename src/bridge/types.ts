export type ChannelKind = 'imessage' | 'whatsapp' | 'telegram' | 'sms';
export type ChannelReadStatus = 'read' | 'unread' | 'unknown';

export type BridgeOperation = 'inbound' | 'outbound' | 'thread-create' | 'metadata-update';

export type BridgeThreadMetadata = {
  bubbleColor?: string;
  readStatus?: ChannelReadStatus;
  archived?: boolean;
  muted?: boolean;
  pinned?: boolean;
  labels?: string[];
  lastReadAt?: string;
  [key: string]: unknown;
};

export type BridgeConversation = {
  conversationId: string;
  bridgeId: string;
  channel: ChannelKind;
  externalThreadId?: string;
  externalConversationId?: string;
  participants: string[];
  metadata: BridgeThreadMetadata;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
};

export type BridgeInboundSignal = {
  channel: ChannelKind;
  externalMessageId: string;
  externalThreadId?: string;
  externalConversationId?: string;
  sender?: string;
  participants?: string[];
  body?: string;
  text?: string;
  timestamp?: string | number | Date;
  metadata?: Record<string, unknown>;
  raw?: unknown;
  bridgeId?: string;
  conversationId?: string;
};

export type BridgeOutboundMessage = {
  conversationId?: string;
  externalThreadId?: string;
  externalConversationId?: string;
  channel?: ChannelKind;
  to?: string[];
  participants?: string[];
  body: string;
  subject?: string;
  metadata?: Record<string, unknown>;
  bubbleColor?: string;
  readStatus?: ChannelReadStatus;
  idempotencyKey?: string;
  replyToMessageId?: string;
  attachments?: Array<{
    name: string;
    mimeType?: string;
    url?: string;
    sizeBytes?: number;
  }>;
};

export type BridgeThreadRequest = {
  channel: ChannelKind;
  participants: string[];
  subject?: string;
  threadTitle?: string;
  metadata?: BridgeThreadMetadata;
  bubbleColor?: string;
  readStatus?: ChannelReadStatus;
  externalThreadId?: string;
  externalConversationId?: string;
};

export type BridgeDispatchResult = {
  messageId: string;
  threadId: string;
  conversationId: string;
  channel: ChannelKind;
  bridgeId: string;
  status: 'queued' | 'sent' | 'delivered';
  metadata: BridgeThreadMetadata;
  raw?: unknown;
};

export type BridgeThreadResult = {
  conversation: BridgeConversation;
  bridgeId: string;
  channel: ChannelKind;
  externalThreadId: string;
  raw?: unknown;
};

export type BridgeRouteResult = {
  bridge: IBridge;
  conversation: BridgeConversation;
  signal?: BridgeInboundSignal;
  message?: BridgeOutboundMessage;
  result: unknown;
};

export type BridgeDispatchContext = {
  operation: BridgeOperation;
  channel: ChannelKind;
  conversation?: BridgeConversation;
  now: string;
  metadata: Record<string, unknown>;
};

export interface IChannel {
  kind: ChannelKind;
  displayName: string;
  supportsThreads: boolean;
  supportsReadStatus: boolean;
  supportsBubbleColor: boolean;
  defaultBubbleColor?: string;
  normalizeAddress(value: string): string;
  fingerprint(participants: readonly string[]): string;
  mergeMetadata(metadata: BridgeThreadMetadata): BridgeThreadMetadata;
}

export type BridgeMiddlewareContext = {
  operation: BridgeOperation;
  bridge: IBridge;
  channel: ChannelKind;
  conversation?: BridgeConversation;
  payload: unknown;
  metadata: Record<string, unknown>;
};

export type BridgeMiddleware = {
  name: string;
  channels?: readonly ChannelKind[];
  appliesTo?(context: BridgeMiddlewareContext): boolean;
  format?(context: BridgeMiddlewareContext, payload: unknown): Promise<unknown> | unknown;
  filter?(context: BridgeMiddlewareContext, payload: unknown): Promise<boolean> | boolean;
  rateLimit?: {
    limit: number;
    windowMs: number;
    key?: string | ((context: BridgeMiddlewareContext) => string);
  };
};

export interface IBridge {
  id: string;
  channel: IChannel;
  middleware?: readonly BridgeMiddleware[];
  canHandle(signal: BridgeInboundSignal): boolean;
  normalizeInbound(signal: BridgeInboundSignal): Promise<BridgeInboundSignal | null> | BridgeInboundSignal | null;
  send(message: BridgeOutboundMessage, context: BridgeDispatchContext): Promise<BridgeDispatchResult>;
  createThread(request: BridgeThreadRequest, context: BridgeDispatchContext): Promise<BridgeThreadResult>;
  updateThreadMetadata(conversation: BridgeConversation, patch: Partial<BridgeThreadMetadata>, context: BridgeDispatchContext): Promise<BridgeConversation>;
}

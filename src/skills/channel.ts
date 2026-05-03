import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import { BridgeRegistry, type BridgeConversation, type BridgeOutboundMessage, type BridgeThreadMetadata, type ChannelKind } from '../bridge/index.ts';
import type { SkillAdapter } from './types';

export type ChannelSkillMode = 'send' | 'thread' | 'metadata';

export type ChannelSkillOptions = {
  registry?: BridgeRegistry;
  defaultChannel?: ChannelKind;
};

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeChannel(value: unknown): ChannelKind | undefined {
  const text = asText(value).toLowerCase();
  if (text === 'imessage' || text === 'whatsapp' || text === 'telegram' || text === 'sms') {
    return text;
  }
  return undefined;
}

function normalizeReadStatus(value: unknown): BridgeThreadMetadata['readStatus'] | undefined {
  const text = asText(value).toLowerCase();
  if (text === 'read' || text === 'unread' || text === 'unknown') {
    return text;
  }
  return undefined;
}

function modeFromStep(step: PlanStep, args: Record<string, unknown>): ChannelSkillMode {
  const raw = asText(args.mode || args.action || step.kind).toLowerCase();
  if (raw.includes('thread')) {
    return 'thread';
  }
  if (raw.includes('metadata') || raw.includes('status') || raw.includes('bubble')) {
    return 'metadata';
  }
  return 'send';
}

function channelConversationSnapshot(conversation: BridgeConversation) {
  return {
    conversationId: conversation.conversationId,
    bridgeId: conversation.bridgeId,
    channel: conversation.channel,
    externalThreadId: conversation.externalThreadId,
    externalConversationId: conversation.externalConversationId,
    participants: conversation.participants,
    metadata: conversation.metadata,
    lastMessageAt: conversation.lastMessageAt,
    lastInboundAt: conversation.lastInboundAt,
    lastOutboundAt: conversation.lastOutboundAt,
  };
}

export class ChannelSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'channel',
    domain: 'communication-routing',
    capabilities: ['send_message', 'create_thread', 'update_metadata', 'bubble_color', 'read_status', 'bridge_routing'],
    version: '1.0.0',
  };

  private readonly registry: BridgeRegistry;
  private readonly defaultChannel?: ChannelKind;

  constructor(options: ChannelSkillOptions = {}) {
    this.registry = options.registry ?? new BridgeRegistry();
    this.defaultChannel = options.defaultChannel;
  }

  canHandle(step: PlanStep): boolean {
    return step.skill === 'channel' || step.kind.startsWith('channel.');
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const args = asRecord(ctx.step.args);
    const mode = modeFromStep(ctx.step, args);
    const channel = normalizeChannel(args.channel) ?? this.defaultChannel;
    const conversationId = asText(args.conversationId) || asText(args.threadId) || asText(args.externalThreadId);
    const participants = asArray(args.participants).map((value) => String(value)).filter(Boolean);
    const to = asArray(args.to).map((value) => String(value)).filter(Boolean);
    const body = asText(args.body) || asText(args.message) || asText(args.text);
    const subject = asText(args.subject) || asText(args.threadTitle);
    const bubbleColor = asText(args.bubbleColor) || asText(args.color) || undefined;
    const readStatus = normalizeReadStatus(args.readStatus);
    const metadata = {
      ...asRecord(args.metadata),
      ...(bubbleColor ? { bubbleColor } : {}),
      ...(readStatus ? { readStatus } : {}),
    };

    try {
      let output: Record<string, unknown>;

      if (mode === 'thread') {
        if (!channel) {
          throw new Error('channel is required to create a thread');
        }

        const thread = await this.registry.createThread({
          channel,
          participants: participants.length > 0 ? participants : to,
          subject,
          threadTitle: subject || asText(args.title),
          metadata,
          bubbleColor,
          readStatus,
          externalThreadId: asText(args.externalThreadId) || undefined,
          externalConversationId: asText(args.externalConversationId) || undefined,
        });

        output = {
          mode,
          channel: thread.channel,
          bridgeId: thread.bridgeId,
          threadId: thread.externalThreadId,
          conversation: channelConversationSnapshot(thread.conversation),
          raw: thread.raw,
        };
      } else if (mode === 'metadata') {
        if (!conversationId) {
          throw new Error('conversationId or threadId is required to update metadata');
        }

        const conversation = await this.registry.updateMetadata(conversationId, {
          ...metadata,
          bubbleColor: bubbleColor || undefined,
          readStatus: readStatus || undefined,
        });

        output = {
          mode,
          conversation: channelConversationSnapshot(conversation),
        };
      } else {
        const message: BridgeOutboundMessage = {
          conversationId: conversationId || undefined,
          channel,
          externalThreadId: asText(args.externalThreadId) || undefined,
          externalConversationId: asText(args.externalConversationId) || undefined,
          participants: participants.length > 0 ? participants : to,
          to: to.length > 0 ? to : undefined,
          body,
          subject: subject || undefined,
          metadata,
          bubbleColor: bubbleColor || undefined,
          readStatus: readStatus || undefined,
          idempotencyKey: asText(args.idempotencyKey) || undefined,
          replyToMessageId: asText(args.replyToMessageId) || undefined,
          attachments: asArray(args.attachments).map((attachment) => attachment as { name: string; mimeType?: string; url?: string; sizeBytes?: number }),
        };

        if (!message.body) {
          throw new Error('body is required to send a channel message');
        }

        const routed = await this.registry.send(message);
        output = {
          mode,
          channel: routed.conversation.channel,
          bridgeId: routed.bridge.id,
          conversation: channelConversationSnapshot(routed.conversation),
          dispatch: routed.result,
        };
      }

      ctx.state.artifacts[ctx.step.id] = {
        mode,
        output,
      };
      ctx.state.outputs[ctx.step.id] = output;

      return {
        ok: true,
        output,
        retryable: false,
        note: mode === 'send' ? 'channel message routed' : mode === 'thread' ? 'channel thread created' : 'channel metadata updated',
        trace: {
          skill: 'channel',
          mode,
          channel,
          conversationId: conversationId || null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /rate limit|timeout|temporar|unavailable|retry/i.test(message.toLowerCase());
      const failure = {
        mode,
        channel,
        error: message,
      };
      ctx.state.artifacts[ctx.step.id] = failure;
      return {
        ok: false,
        output: failure,
        retryable,
        note: 'channel skill failed',
        trace: {
          skill: 'channel',
          mode,
          channel,
          error: message,
        },
      };
    }
  }
}

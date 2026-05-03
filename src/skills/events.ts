import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import { EventBus, type EventQuery, type EventRecord, type EventSource, type QueueJobInput, type QueueJobRecord, type QueueJobStatus, type QueueQuery } from '../events/index.ts';
import type { SkillAdapter } from './types';

export type EventSkillMode = 'history' | 'queue' | 'replay' | 'enqueue' | 'claim' | 'complete' | 'fail';
export type EventSkillOptions = { eventBus?: EventBus };

function asText(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function asRecord(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function asNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function toEventSource(value: unknown): EventSource | undefined { const text = asText(value).toLowerCase(); return text === 'orchestrator' || text === 'bridge' || text === 'queue' || text === 'skill' || text === 'system' ? text : undefined; }
function toQueueStatus(value: unknown): QueueJobStatus | undefined { const text = asText(value).toLowerCase(); return text === 'queued' || text === 'running' || text === 'retrying' || text === 'completed' || text === 'dead' || text === 'cancelled' ? text : undefined; }
function modeFromStep(step: PlanStep, args: Record<string, unknown>): EventSkillMode { const raw = asText(args.mode || args.action || step.kind).toLowerCase(); if (raw.includes('replay')) return 'replay'; if (raw.includes('enqueue') || raw.includes('publish')) return 'enqueue'; if (raw.includes('claim') || raw.includes('next')) return 'claim'; if (raw.includes('complete') || raw.includes('ack') || raw.includes('done')) return 'complete'; if (raw.includes('fail') || raw.includes('dead') || raw.includes('reject')) return 'fail'; if (raw.includes('queue')) return 'queue'; return 'history'; }
function summarizeEvent(event: EventRecord) { return { cursor: event.cursor, eventId: event.eventId, topic: event.topic, source: event.source, aggregateType: event.aggregateType, aggregateId: event.aggregateId, correlationId: event.correlationId, createdAt: event.createdAt, createdAtIso: event.createdAtIso, payload: event.payload }; }
function summarizeJob(job: QueueJobRecord) { return { jobId: job.jobId, queueName: job.queueName, topic: job.topic, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts, availableAt: job.availableAt, lockedAt: job.lockedAt, lockedBy: job.lockedBy, priority: job.priority, payload: job.payload, metadata: job.metadata, lastError: job.lastError, lastResult: job.lastResult }; }
function eventQueryFromArgs(args: Record<string, unknown>): EventQuery { const topics = asArray(args.topic ?? args.topics).map((value) => asText(value)).filter(Boolean); const sources = asArray(args.source ?? args.sources).map((value) => toEventSource(value)).filter(Boolean) as EventSource[]; return { cursor: asNumber(args.cursor ?? args.fromCursor ?? args.after), topic: topics.length > 1 ? topics : topics[0], source: sources.length > 1 ? sources : sources[0], aggregateType: asText(args.aggregateType) || undefined, aggregateId: asText(args.aggregateId) || undefined, limit: asNumber(args.limit) ?? 100 }; }
function queueQueryFromArgs(args: Record<string, unknown>): QueueQuery { const statuses = asArray(args.status ?? args.statuses).map((value) => toQueueStatus(value)).filter(Boolean) as QueueJobStatus[]; return { queueName: asText(args.queueName) || undefined, topic: asText(args.topic) || undefined, status: statuses.length > 1 ? statuses : statuses[0], limit: asNumber(args.limit) ?? 50 }; }

export class EventSkill implements SkillAdapter {
  descriptor: SkillDescriptor = { name: 'events', domain: 'durability-and-observability', capabilities: ['query_event_history', 'replay_events', 'enqueue_queue_jobs', 'claim_queue_jobs', 'complete_queue_jobs', 'fail_queue_jobs'], version: '1.0.0' };
  private readonly eventBus: EventBus;
  constructor(options: EventSkillOptions = {}) { this.eventBus = options.eventBus ?? new EventBus(); }
  canHandle(step: PlanStep): boolean { return step.skill === 'events' || step.kind.startsWith('events.'); }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const args = asRecord(ctx.step.args);
    const mode = modeFromStep(ctx.step, args);
    try {
      let output: Record<string, unknown>;
      if (mode === 'replay') {
        const fromCursor = asNumber(args.cursor ?? args.fromCursor ?? args.after) ?? 0;
        const replay = await this.eventBus.replay(fromCursor, { query: eventQueryFromArgs(args), limit: asNumber(args.limit) ?? 500, dispatch: args.dispatch !== false });
        output = { mode, fromCursor, nextCursor: replay.nextCursor, deliveredTo: replay.deliveredTo, failures: replay.failures, events: replay.events.map(summarizeEvent) };
      } else if (mode === 'enqueue') {
        const queueJob = await this.eventBus.enqueueJob({ queueName: asText(args.queueName) || undefined, topic: asText(args.topic) || asText(args.eventTopic) || 'events.job', payload: asRecord(args.payload ?? args.data ?? args.job ?? {}), metadata: asRecord(args.metadata ?? {}), priority: asNumber(args.priority), maxAttempts: asNumber(args.maxAttempts), availableAt: asNumber(args.availableAt), backoffBaseMs: asNumber(args.backoffBaseMs), backoffMultiplier: asNumber(args.backoffMultiplier), maxBackoffMs: asNumber(args.maxBackoffMs), correlationId: asText(args.correlationId) || undefined, causationId: asText(args.causationId) || undefined } as QueueJobInput);
        output = { mode, job: summarizeJob(queueJob) };
      } else if (mode === 'claim') {
        const claim = await this.eventBus.claimNextJob({ queueName: asText(args.queueName) || undefined, workerId: asText(args.workerId) || undefined });
        output = { mode, claim: claim ? { attemptNumber: claim.attemptNumber, job: summarizeJob(claim.job) } : null };
      } else if (mode === 'complete') {
        const jobId = asText(args.jobId); if (!jobId) throw new Error('jobId is required to complete a queue job');
        const completed = await this.eventBus.completeJob(jobId, args.result ?? args.output ?? null, asText(args.workerId) || undefined);
        output = { mode, job: completed ? summarizeJob(completed) : null };
      } else if (mode === 'fail') {
        const jobId = asText(args.jobId); if (!jobId) throw new Error('jobId is required to fail a queue job');
        const failed = await this.eventBus.failJob(jobId, args.error ?? (asText(args.message) || 'queue job failed'), { retryable: args.retryable === undefined ? undefined : Boolean(args.retryable), workerId: asText(args.workerId) || undefined });
        output = { mode, job: failed ? summarizeJob(failed) : null };
      } else if (mode === 'queue') {
        const stats = await this.eventBus.stats(asText(args.queueName) || undefined);
        const jobs = await this.eventBus.listJobs(queueQueryFromArgs(args));
        output = { mode, stats, jobs: jobs.map(summarizeJob) };
      } else {
        const query = eventQueryFromArgs(args);
        const events = await this.eventBus.listEvents(query);
        const stats = await this.eventBus.stats(asText(args.queueName) || undefined);
        output = { mode: 'history', cursor: query.cursor ?? 0, nextCursor: events.at(-1)?.cursor ?? query.cursor ?? 0, count: events.length, stats, events: events.map(summarizeEvent) };
      }
      ctx.state.artifacts[ctx.step.id] = { mode, output };
      ctx.state.outputs[ctx.step.id] = output;
      return { ok: true, output, retryable: false, note: mode === 'replay' ? 'event replay completed' : mode === 'enqueue' ? 'queue job enqueued' : mode === 'claim' ? 'queue job claimed' : mode === 'complete' ? 'queue job completed' : mode === 'fail' ? 'queue job failed' : 'event history queried', trace: { skill: 'events', mode } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /timeout|temporar|busy|locked|rate limit|unavailable/i.test(message.toLowerCase());
      const failure = { mode, error: message };
      ctx.state.artifacts[ctx.step.id] = failure;
      return { ok: false, output: failure, retryable, note: 'event skill failed', trace: { skill: 'events', mode, error: message } };
    }
  }
}

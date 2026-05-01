import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { SkillAdapter } from './types';

export type HarnessThreadMessage = {
  id: string;
  sender: string;
  text: string;
  timestamp: number;
  kind?: 'relationship' | 'thread' | 'transactional' | 'preference';
};

export type HarnessConflictWindow = {
  id: string;
  title: string;
  start: string;
  end: string;
  timezone?: string;
};

export type HarnessRelationship = {
  id: string;
  name: string;
  role?: string;
  weight?: number;
  lastContactAt?: number;
  notes?: string;
};

export type HarnessFileEntry = {
  path: string;
  updatedAt?: number;
  stale?: boolean;
  importance?: number;
};

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function rankMessage(message: HarnessThreadMessage, relationshipTerms: string[]): number {
  const lower = `${message.sender} ${message.text}`.toLowerCase();
  const recency = 1 / (1 + Math.log1p(Math.max(1, (Date.now() - message.timestamp) / 3_600_000)));
  const relationship = relationshipTerms.reduce((score, term) => score + (lower.includes(term.toLowerCase()) ? 0.16 : 0), 0);
  const transactionalPenalty = /\b(invoice|receipt|booking|confirmation|payment|deadline|ticket)\b/.test(lower) ? 0.18 : 0;
  const threadBoost = message.kind === 'thread' ? 0.12 : 0;
  const preferenceBoost = message.kind === 'preference' ? 0.22 : 0;
  return recency + relationship + threadBoost + preferenceBoost - transactionalPenalty;
}

function compactThread(messages: HarnessThreadMessage[], relationshipTerms: string[]) {
  const ranked = [...messages]
    .map((message) => ({ message, score: rankMessage(message, relationshipTerms) }))
    .sort((left, right) => right.score - left.score || right.message.timestamp - left.message.timestamp);
  const retained = ranked.slice(0, Math.min(8, ranked.length)).map((entry) => entry.message);
  const dropped = ranked.slice(retained.length).map((entry) => entry.message);
  return {
    retained,
    dropped,
    summary: `retained ${retained.length}/${messages.length} thread messages while preferring relationship context over stale transactional noise`,
  };
}

function rankRelationship(relationship: HarnessRelationship, query: string): number {
  const lower = query.toLowerCase();
  const recency = relationship.lastContactAt ? 1 / (1 + Math.log1p(Math.max(1, (Date.now() - relationship.lastContactAt) / 86_400_000))) : 0.35;
  const directMatch = [relationship.name, relationship.role, relationship.notes]
    .filter(Boolean)
    .some((value) => lower.includes(String(value).toLowerCase()));
  const roleBoost = relationship.role && /manager|lead|mentor|hr|recruiter|manager|owner|founder/i.test(relationship.role) ? 0.18 : 0;
  return (relationship.weight ?? 0.5) + recency + (directMatch ? 0.45 : 0) + roleBoost;
}

function detectConflicts(events: HarnessConflictWindow[]) {
  const sorted = [...events].sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
  const conflicts: Array<{ left: HarnessConflictWindow; right: HarnessConflictWindow; overlapMinutes: number }> = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const currentEnd = new Date(current.end).getTime();
    const nextStart = new Date(next.start).getTime();
    if (nextStart < currentEnd) conflicts.push({ left: current, right: next, overlapMinutes: Math.ceil((currentEnd - nextStart) / 60_000) });
  }
  return conflicts;
}

function recordArtifact(ctx: ExecutionContext, payload: unknown): void {
  ctx.state.artifacts[ctx.step.id] = payload;
}

function result(note: string, output: unknown, trace: Record<string, unknown>): SkillResult {
  return { ok: true, output, retryable: false, note, trace };
}

export class HarnessSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'harness',
    domain: 'domain-primitives',
    capabilities: ['readthread', 'draftreply', 'conflict_detection', 'relationship_recall', 'filesystem_scan'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'harness';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    if (ctx.step.kind === 'harness.readthread') {
      const messages = asArray<HarnessThreadMessage>(ctx.step.args.messages);
      const relationshipTerms = asArray<string>(ctx.step.args.relationshipTerms).map((term) => normalizeText(term)).filter(Boolean);
      const compaction = compactThread(messages, relationshipTerms);
      const output = {
        threadId: normalizeText(ctx.step.args.threadId) || ctx.task.taskId,
        summary: normalizeText(ctx.step.args.summary) || compaction.retained.map((message) => `${message.sender}: ${message.text}`).join('\n'),
        relationshipContext: relationshipTerms,
        retainedMessages: compaction.retained,
        droppedMessages: compaction.dropped,
        threadWeight: Math.min(1, 0.45 + relationshipTerms.length * 0.12 + compaction.retained.length * 0.05),
      };
      recordArtifact(ctx, output);
      return result('thread read through harness compaction', output, { compaction: compaction.summary });
    }

    if (ctx.step.kind === 'harness.draftreply') {
      const threadSummary = normalizeText(ctx.step.args.threadSummary) || normalizeText(ctx.state.outputs[ctx.plan.steps.find((step) => step.kind === 'harness.readthread')?.id ?? ''] as string);
      const tone = normalizeText(ctx.step.args.tone) || 'concise professional';
      const subject = normalizeText(ctx.step.args.subject) || `Re: ${normalizeText(ctx.step.args.threadSubject) || 'follow-up'}`;
      const relationshipWeight = Math.min(1, 0.55 + (threadSummary ? 0.1 : 0) + (tone.includes('professional') ? 0.12 : 0));
      const output = {
        subject,
        draft: [
          `Hi,`,
          ``,
          threadSummary ? `Thanks for the update — ${threadSummary.slice(0, 220)}` : 'Thanks for the update.',
          ``,
          normalizeText(ctx.step.args.intent) || 'Let me know if anything else is needed.',
          ``,
          'Best,',
          'Abhay',
        ].join('\n'),
        tone,
        relationshipWeight,
        nextAction: 'review and send only after confirmation',
      };
      recordArtifact(ctx, output);
      return result('reply drafted through harness primitive', output, { tone, relationshipWeight });
    }

    if (ctx.step.kind === 'harness.conflict_detection') {
      const events = asArray<HarnessConflictWindow>(ctx.step.args.events);
      const conflicts = detectConflicts(events);
      const output = {
        events,
        conflicts,
        conflictCount: conflicts.length,
        severity: conflicts.length > 0 ? 'needs_reschedule' : 'clear',
      };
      recordArtifact(ctx, output);
      return result('calendar conflicts detected through harness primitive', output, { conflictCount: conflicts.length });
    }

    if (ctx.step.kind === 'harness.relationship_recall') {
      const relationships = asArray<HarnessRelationship>(ctx.step.args.relationships);
      const query = normalizeText(ctx.step.args.query) || ctx.state.objective;
      const ranked = relationships
        .map((relationship) => ({ relationship, score: rankRelationship(relationship, query) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 8);
      const output = {
        query,
        rankedRelationships: ranked.map((entry) => ({ ...entry.relationship, score: Number(entry.score.toFixed(3)) })),
        nextAction: ranked[0] ? `start with ${ranked[0].relationship.name}` : 'ask for a better anchor',
      };
      recordArtifact(ctx, output);
      return result('relationship history recalled through harness primitive', output, { ranked: ranked.length });
    }

    if (ctx.step.kind === 'harness.filesystem_scan') {
      const files = asArray<HarnessFileEntry>(ctx.step.args.files);
      const ranked = [...files].sort((left, right) => {
        const leftScore = (left.importance ?? 0.5) + (left.stale ? -0.2 : 0) + (left.updatedAt ? 1 / (1 + Math.log1p(Math.max(1, (Date.now() - left.updatedAt) / 3_600_000))) : 0.3);
        const rightScore = (right.importance ?? 0.5) + (right.stale ? -0.2 : 0) + (right.updatedAt ? 1 / (1 + Math.log1p(Math.max(1, (Date.now() - right.updatedAt) / 3_600_000))) : 0.3);
        return rightScore - leftScore;
      });
      const output = {
        basePath: normalizeText(ctx.step.args.basePath) || '.',
        files: ranked,
        staleCandidates: ranked.filter((entry) => entry.stale).map((entry) => entry.path),
        nextAction: 'prefer the freshest high-importance paths first',
      };
      recordArtifact(ctx, output);
      return result('filesystem scan completed through harness primitive', output, { fileCount: ranked.length });
    }

    const output = { objective: ctx.state.objective, args: ctx.step.args };
    recordArtifact(ctx, output);
    return result('generic harness operation completed', output, {});
  }
}

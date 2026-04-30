export type SkillPlaybookStatus = 'live' | 'planned';

export type SkillPlaybook = {
  name: 'browser' | 'email' | 'calendar' | 'filesystem' | 'integration';
  status: SkillPlaybookStatus;
  instructionPath: string;
  summary: string;
  coreCapabilities: string[];
  boundaries: string[];
  inputSchema: string[];
  outputSchema: string[];
  failureModes: string[];
  recovery: string[];
  advancedNotes: string[];
};

export const SKILL_PLAYBOOKS: Record<SkillPlaybook['name'], SkillPlaybook> = {
  browser: {
    name: 'browser',
    status: 'live',
    instructionPath: 'src/skills/browser/skill.md',
    summary: 'stateful web navigation and evidence extraction',
    coreCapabilities: ['multi-step navigation', 'dom extraction', 'page-state capture', 'interaction planning'],
    boundaries: ['no passwords', 'no blind clicking', 'no hidden side effects'],
    inputSchema: ['objective', 'url', 'mode', 'selectors', 'interactionPlan', 'retryPolicy'],
    outputSchema: ['finalUrl', 'navigationTrail', 'artifacts', 'confidence', 'trace'],
    failureModes: ['redirect loops', 'stale selectors', 'lazy-loaded content', 'anti-bot responses'],
    recovery: ['refresh current url', 'fallback selectors', 'backoff retries', 'degrade to visible-text extraction'],
    advancedNotes: ['treat browsing as a graph', 'preserve provenance', 'capture digests to detect drift'],
  },
  email: {
    name: 'email',
    status: 'planned',
    instructionPath: 'src/skills/email/skill.md',
    summary: 'thread-aware inbox search and confirmation-safe drafting',
    coreCapabilities: ['search', 'thread reconstruction', 'drafting', 'reply composition', 'forward composition'],
    boundaries: ['no send without confirmation', 'no invented recipients', 'no attachment drift'],
    inputSchema: ['mode', 'query', 'threadId', 'recipients', 'attachments', 'confirmationState'],
    outputSchema: ['draftId', 'threadSummary', 'matches', 'riskFlags', 'nextAction'],
    failureModes: ['ambiguous recipient', 'missing thread', 'partial mailbox coverage', 'provider quirks'],
    recovery: ['search parallel sources', 'resolve aliases', 'show draft before send', 'reconstruct latest human intent'],
    advancedNotes: ['thread-first reasoning', 'idempotent send strategy', 'attachment provenance'],
  },
  calendar: {
    name: 'calendar',
    status: 'planned',
    instructionPath: 'src/skills/calendar/skill.md',
    summary: 'timezone-safe scheduling and event mutation',
    coreCapabilities: ['drafting', 'conflict detection', 'update', 'reschedule', 'cancel'],
    boundaries: ['never guess timezone', 'never mutate without snapshot', 'never drop attendees'],
    inputSchema: ['mode', 'title', 'start', 'end', 'timezone', 'attendees', 'changes'],
    outputSchema: ['draftId', 'eventId', 'normalizedStart', 'conflicts', 'nextAction'],
    failureModes: ['timezone ambiguity', 'conflicting events', 'recurrence edge cases', 'stale snapshots'],
    recovery: ['normalize times', 'dry-run conflict checks', 'present confirmation-safe drafts'],
    advancedNotes: ['treat calendars as constrained state machines', 'preserve series identity'],
  },
  filesystem: {
    name: 'filesystem',
    status: 'planned',
    instructionPath: 'src/skills/filesystem/skill.md',
    summary: 'safe workspace reads, writes, diffs, and exports',
    coreCapabilities: ['read', 'write', 'diff', 'scan', 'hash', 'export'],
    boundaries: ['stay inside workspace', 'respect symlinks', 'atomic writes only'],
    inputSchema: ['mode', 'path', 'content', 'recursive', 'atomicWrite', 'baselinePath'],
    outputSchema: ['path', 'hash', 'diff', 'entries', 'warnings', 'backupPath'],
    failureModes: ['path traversal', 'partial write', 'binary misread', 'permission denied'],
    recovery: ['backup before overwrite', 'atomic rename', 'verify hash', 'degrade to metadata-only inspection'],
    advancedNotes: ['transactional surface', 'stable diffs', 'content-addressed staging'],
  },
  integration: {
    name: 'integration',
    status: 'live',
    instructionPath: 'src/skills/integrations/skill.md',
    summary: 'provider routing for external systems',
    coreCapabilities: ['provider dispatch', 'dry-run', 'read/write normalization', 'idempotent execution'],
    boundaries: ['no silent provider switching', 'no destructive writes without intent', 'no hidden failures'],
    inputSchema: ['provider', 'action', 'mode', 'payload', 'idempotencyKey', 'confirmationState'],
    outputSchema: ['provider', 'action', 'externalIds', 'riskFlags', 'nextAction'],
    failureModes: ['unsupported provider', 'permission failure', 'rate limit', 'duplicate write'],
    recovery: ['validate provider/action', 'retry with idempotency key', 'compensate on partial success'],
    advancedNotes: ['capability routing from execution', 'normalize provider responses', 'parallel inspection when source is ambiguous'],
  },
};

export function listSkillPlaybooks(): SkillPlaybook[] {
  return Object.values(SKILL_PLAYBOOKS);
}

export function getSkillPlaybook(name: SkillPlaybook['name']): SkillPlaybook {
  return SKILL_PLAYBOOKS[name];
}

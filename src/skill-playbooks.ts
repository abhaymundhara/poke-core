export type SkillPlaybookStatus = 'live' | 'planned';

export type SkillPlaybook = {
  name: 'browser' | 'email' | 'calendar' | 'filesystem' | 'integration' | 'autopilot' | 'user-modeling' | 'grounding' | 'signal-observation' | 'computer-use' | 'harness' | 'channel';
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
    status: 'live',
    instructionPath: 'src/skills/email/skill.md',
    summary: 'thread-aware inbox search and confirmation-safe drafting',
    coreCapabilities: ['readthread', 'draftreply', 'relationship recall', 'thread compaction'],
    boundaries: ['no send without confirmation', 'no invented recipients', 'no attachment drift'],
    inputSchema: ['mode', 'threadId', 'relationships', 'messages', 'tone', 'intent'],
    outputSchema: ['draftId', 'threadSummary', 'relationshipWeight', 'compaction', 'nextAction'],
    failureModes: ['ambiguous recipient', 'missing thread', 'partial mailbox coverage', 'provider quirks'],
    recovery: ['compact stale transactional context', 'resolve aliases', 'show draft before send', 'reconstruct latest human intent'],
    advancedNotes: ['thread-first reasoning', 'idempotent send strategy', 'attachment provenance'],
  },
  calendar: {
    name: 'calendar',
    status: 'live',
    instructionPath: 'src/skills/calendar/skill.md',
    summary: 'timezone-safe scheduling and conflict detection',
    coreCapabilities: ['conflict_detection', 'drafting', 'update', 'reschedule', 'cancel'],
    boundaries: ['never guess timezone', 'never mutate without snapshot', 'never drop attendees'],
    inputSchema: ['mode', 'events', 'title', 'start', 'end', 'timezone', 'attendees'],
    outputSchema: ['draftId', 'eventId', 'normalizedStart', 'conflicts', 'nextAction'],
    failureModes: ['timezone ambiguity', 'conflicting events', 'recurrence edge cases', 'stale snapshots'],
    recovery: ['normalize times', 'dry-run conflict checks', 'present confirmation-safe drafts'],
    advancedNotes: ['treat calendars as constrained state machines', 'preserve series identity'],
  },
  filesystem: {
    name: 'filesystem',
    status: 'live',
    instructionPath: 'src/skills/filesystem/skill.md',
    summary: 'safe workspace reads, writes, diffs, and exports',
    coreCapabilities: ['filesystem_scan', 'read', 'write', 'diff', 'hash', 'export'],
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
  autopilot: {
    name: 'autopilot',
    status: 'live',
    instructionPath: 'src/skills/autopilot/skill.md',
    summary: 'self-directed execution planning with bounded checkpoints',
    coreCapabilities: ['task decomposition', 'step sequencing', 'checkpointing', 'handoff planning'],
    boundaries: ['does not execute side effects directly', 'keeps checkpoints explicit', 'preserves recovery history'],
    inputSchema: ['objective', 'context', 'constraints', 'mode'],
    outputSchema: ['executionPlan', 'checkpoints', 'risks', 'nextAction'],
    failureModes: ['over-broad objective', 'missing constraints', 'feedback loops'],
    recovery: ['tighten the objective', 'split into smaller tasks', 'fall back to a shorter plan'],
    advancedNotes: ['optimizes for orchestration before action', 'prefer narrow, validated steps'],
  },
  'user-modeling': {
    name: 'user-modeling',
    status: 'live',
    instructionPath: 'src/skills/user-modeling/skill.md',
    summary: 'preference and persona inference from task context',
    coreCapabilities: ['preference extraction', 'tone detection', 'constraint memory', 'profile shaping'],
    boundaries: ['does not invent user preferences', 'retains uncertainty', 'keeps evidence attached'],
    inputSchema: ['objective', 'context', 'knownPreferences', 'interactionHistory'],
    outputSchema: ['profile', 'confidence', 'signals', 'nextAction'],
    failureModes: ['sparse context', 'conflicting preferences', 'stale memory'],
    recovery: ['ask for clarification', 'prefer explicit hints', 'lower confidence when signals are weak'],
    advancedNotes: ['treat persona as soft state', 'prefer explicit evidence over inference'],
  },
  grounding: {
    name: 'grounding',
    status: 'live',
    instructionPath: 'src/skills/grounding/skill.md',
    summary: 'evidence-first fact alignment for task outputs',
    coreCapabilities: ['claim tracing', 'evidence pairing', 'assumption tagging', 'consistency checks'],
    boundaries: ['does not promote assumptions to facts', 'keeps provenance visible', 'separates inference from evidence'],
    inputSchema: ['objective', 'claims', 'evidence', 'context'],
    outputSchema: ['groundedFacts', 'assumptions', 'confidence', 'nextAction'],
    failureModes: ['missing evidence', 'overconfident inference', 'conflicting sources'],
    recovery: ['ask for stronger evidence', 'narrow the claim set', 'surface uncertainty explicitly'],
    advancedNotes: ['optimize for verifiable statements', 'attach supporting signals to each claim'],
  },
  'signal-observation': {
    name: 'signal-observation',
    status: 'live',
    instructionPath: 'src/skills/signal-observation/skill.md',
    summary: 'trend and anomaly scanning over task signals',
    coreCapabilities: ['trend detection', 'anomaly detection', 'signal summarization', 'monitoring focus'],
    boundaries: ['does not hallucinate telemetry', 'preserves the observation window', 'keeps raw signals intact'],
    inputSchema: ['objective', 'signals', 'window', 'thresholds'],
    outputSchema: ['observations', 'anomalies', 'trend', 'nextAction'],
    failureModes: ['thin signal set', 'noisy inputs', 'window mismatch'],
    recovery: ['expand the observation window', 'reduce thresholds', 'return the strongest signals only'],
    advancedNotes: ['favor compact signal summaries', 'track changes over time'],
  },
  channel: {
    name: 'channel',
    status: 'live',
    instructionPath: 'src/skills/channel.ts',
    summary: 'multi-channel bridge routing and conversation metadata management',
    coreCapabilities: ['inbound_routing', 'outbound_dispatch', 'thread_creation', 'metadata_updates', 'middleware'],
    boundaries: ['no silent provider fallback', 'no invented delivery semantics', 'preserve conversation provenance'],
    inputSchema: ['mode', 'channel', 'conversationId', 'threadId', 'participants', 'metadata', 'body', 'bubbleColor', 'readStatus'],
    outputSchema: ['conversation', 'bridgeId', 'threadId', 'dispatch', 'metadata', 'trace'],
    failureModes: ['missing bridge', 'ambiguous thread mapping', 'rate limiting', 'unsupported channel capability'],
    recovery: ['resolve the conversation key first', 'retry through the registered bridge', 'defer unsupported metadata to the platform layer'],
    advancedNotes: ['keep bridge routing idempotent', 'treat middleware as a first-class policy layer', 'prefer explicit channel selection when available'],
  },
  'computer-use': {
    name: 'computer-use',
    status: 'live',
    instructionPath: 'src/skills/computer-use/skill.md',
    summary: 'desktop and UI action planning for computer-use flows',
    coreCapabilities: ['ui action planning', 'surface selection', 'safety checks', 'fallback planning'],
    boundaries: ['no blind clicking', 'no credential capture', 'requires visible state before action'],
    inputSchema: ['objective', 'surface', 'actions', 'constraints'],
    outputSchema: ['interactionPlan', 'safetyChecks', 'fallback', 'nextAction'],
    failureModes: ['ambiguous interface', 'hidden destructive action', 'missing state'],
    recovery: ['switch back to browser extraction', 'reduce scope', 'ask for a confirmed target'],
    advancedNotes: ['treat UI work as stateful interaction', 'capture intent before execution'],
  },
  harness: {
    name: 'harness',
    status: 'live',
    instructionPath: 'src/skills/harness/skill.md',
    summary: 'first-class domain primitives for threads, conflicts, and relationship recall',
    coreCapabilities: ['readthread', 'draftreply', 'conflict_detection', 'relationship_recall', 'filesystem_scan'],
    boundaries: ['compact stale transactional data', 'keep relationship history', 'surface uncertainty explicitly'],
    inputSchema: ['mode', 'threadId', 'relationships', 'messages', 'events', 'files'],
    outputSchema: ['threadSummary', 'draft', 'conflicts', 'rankedRelationships', 'compaction'],
    failureModes: ['missing thread signal', 'stale transactional noise', 'over-compressed history'],
    recovery: ['re-run compaction with a narrower query', 'fall back to relationship-weighted recall', 'prefer the freshest high-value context'],
    advancedNotes: ['no harness, no moat', 'domain primitives beat generic tool calls', 'preserve provenance through compaction'],
  },
};

export function listSkillPlaybooks(): SkillPlaybook[] {
  return Object.values(SKILL_PLAYBOOKS);
}

export function getSkillPlaybook(name: SkillPlaybook['name']): SkillPlaybook {
  return SKILL_PLAYBOOKS[name];
}

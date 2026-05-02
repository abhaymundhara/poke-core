import { randomUUID } from 'node:crypto';
import type { PlanStep, PlannerIntentEdge, PlannerIntentGraph, PlannerIntentNode, PlannerRecoveryPolicy, PlannerRuntimeState, PlannerStrategy, PlannerToolAffordance, SkillDescriptor, TaskInput, TaskPlan, ExecutionProfile } from './types';
import { DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, understandSearchIntent, understandSearchIntentWithNlu, type SemanticNluProvider } from './search/nlu';
import type { SearchIntent, SearchSource } from './search/types';
import { clamp, normalize, stableHash, uniq, words } from './search/utils';

export type PlannerResolveContext = Record<string, unknown> & {
  semanticIntent?: SearchIntent;
  skillCatalog?: SkillDescriptor[];
  semanticProvider?: SemanticNluProvider;
  plannerProvider?: SemanticNluProvider;
};

type PlannerActionPlan = {
  stepKind: PlanStep['kind'];
  title: string;
  skill: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
  stateLabel: string;
  support?: boolean;
};

const DEFAULT_SKILL_CATALOG: SkillDescriptor[] = [
  { name: 'browser', domain: 'web-navigation', capabilities: ['navigate', 'extract', 'verify'], version: '1.0.0' },
  { name: 'integration', domain: 'external-integrations', capabilities: ['inspect', 'comment', 'update', 'append', 'post_message', 'deploy'], version: '1.0.0' },
  { name: 'harness', domain: 'domain-primitives', capabilities: ['readthread', 'draftreply', 'conflict_detection', 'relationship_recall', 'filesystem_scan'], version: '1.0.0' },
  { name: 'autopilot', domain: 'cognitive-orchestration', capabilities: ['planning', 'delegation', 'checkpointing', 'proactivity'], version: '1.0.0' },
  { name: 'user-modeling', domain: 'user-context', capabilities: ['preference extraction', 'tone detection', 'profile shaping'], version: '1.0.0' },
  { name: 'grounding', domain: 'evidence-management', capabilities: ['claim tracing', 'evidence pairing', 'assumption tagging'], version: '1.0.0' },
  { name: 'signal-observation', domain: 'telemetry-analysis', capabilities: ['trend detection', 'anomaly detection', 'signal summarization'], version: '1.0.0' },
  { name: 'computer-use', domain: 'desktop-interaction', capabilities: ['ui action planning', 'surface selection', 'vision snapshots', 'coordinate clicks'], version: '1.0.0' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSearchIntent(value: unknown): SearchIntent | null {
  if (!isRecord(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.semanticQuery !== 'string') return null;
  if (!Array.isArray(record.entities) || !Array.isArray(record.topics) || !Array.isArray(record.sourceHints) || !Array.isArray(record.sourcePriors) || !Array.isArray(record.decomposedQuestions) || !Array.isArray(record.ambiguities) || !Array.isArray(record.semanticFrames)) return null;
  if (!isRecord(record.nlu) || typeof record.nlu.provider !== 'string') return null;
  return record as SearchIntent;
}

function plannerTokens(objective: string, context: PlannerResolveContext, intent: SearchIntent): string[] {
  const contextText = Object.entries(context)
    .filter(([key, value]) => key !== 'semanticIntent' && key !== 'skillCatalog' && key !== 'semanticProvider' && value !== undefined && value !== null)
    .map(([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return uniq([
    ...words(objective),
    ...words(intent.semanticQuery),
    ...intent.entities.flatMap((entity) => words(entity)),
    ...intent.topics.flatMap((topic) => words(topic)),
    ...intent.decomposedQuestions.flatMap((question) => words(question)),
    ...words(contextText),
  ]);
}

function sourcePriorForSkill(intent: SearchIntent, skill: SkillDescriptor): number {
  const bucket = sourceBucketForSkill(skill.name, intent);
  const prior = intent.sourcePriors.find((entry) => entry.source === bucket || entry.source === skill.name) ?? null;
  return prior ? clamp(prior.weight, 0, 1) : 0;
}

function frameAffinityForSkill(intent: SearchIntent, skill: SkillDescriptor): number {
  const score = intent.semanticFrames.reduce((total, frame) => {
    const frameText = `${frame.name} ${frame.description}`.toLowerCase();
    const skillSignals = [skill.name, skill.domain, ...skill.capabilities].map((value) => value.toLowerCase());
    const matchesSkill = skillSignals.some((signal) => frameText.includes(signal));
    return total + (matchesSkill ? Math.max(0.05, frame.confidence * 0.12) : 0);
  }, 0);
  return clamp(score, 0, 0.25);
}

function normalizeSkills(skillCatalog?: SkillDescriptor[] | null): SkillDescriptor[] {
  const list = Array.isArray(skillCatalog) && skillCatalog.length > 0 ? skillCatalog : DEFAULT_SKILL_CATALOG;
  return uniq(list.map((skill) => skill.name)).map((name) => list.find((skill) => skill.name === name)!).filter(Boolean);
}

function sourceBucketForSkill(skill: string, intent?: SearchIntent, context: PlannerResolveContext = {}): string {
  const lowerSkill = skill.toLowerCase();
  if (lowerSkill === 'browser' || lowerSkill === 'computer-use') return 'browser';
  if (lowerSkill === 'integration') return 'integration';
  if (lowerSkill === 'autopilot') return 'integration';
  if (lowerSkill === 'user-modeling' || lowerSkill === 'grounding' || lowerSkill === 'signal-observation') return 'memory';
  if (lowerSkill === 'harness') {
    if (typeof context.provider === 'string') return String(context.provider);
    if (intent?.sourceHints.includes('email')) return 'email';
    if (intent?.sourceHints.includes('calendar')) return 'calendar';
    if (intent?.sourceHints.includes('filesystem')) return 'filesystem';
    if (intent?.sourceHints.includes('memory')) return 'memory';
    return 'integration';
  }
  return 'integration';
}

function scoreSkill(skill: SkillDescriptor, intent: SearchIntent, context: PlannerResolveContext, tokens: string[]): PlannerToolAffordance {
  const skillTokens = words([skill.name, skill.domain, ...skill.capabilities].join(' '));
  const base = 0.15 + overlap(tokens, skillTokens) * 0.5;
  const sourceHint = intent.sourceHints.some((source) => sourceBucketForSkill(skill.name, intent, context) === source || (source === 'realtime-web' && sourceBucketForSkill(skill.name, intent, context) === 'browser') || (source === 'web' && sourceBucketForSkill(skill.name, intent, context) === 'browser')) ? 0.18 : 0;
  const focusBoost = intent.focus === 'trust' && (skill.name === 'grounding' || skill.name === 'harness') ? 0.16
    : intent.focus === 'multi-hop' && (skill.name === 'browser' || skill.name === 'integration') ? 0.16
    : intent.focus === 'diagnostic' && skill.name === 'signal-observation' ? 0.18
    : intent.focus === 'semantic' && skill.name === 'user-modeling' ? 0.1
    : intent.focus === 'exploratory' && skill.name === 'browser' ? 0.12
    : 0;
  const freshnessBoost = intent.freshness === 'live' && skill.name === 'browser' ? 0.15 : intent.freshness === 'recent' && skill.name === 'signal-observation' ? 0.08 : 0;
  const contextBoost = typeof context.url === 'string' && skill.name === 'browser' ? 0.2
    : Array.isArray(context.messages) && skill.name === 'harness' ? 0.18
    : Array.isArray(context.events) && skill.name === 'harness' ? 0.18
    : Array.isArray(context.relationships) && skill.name === 'harness' ? 0.14
    : Array.isArray(context.files) && skill.name === 'harness' ? 0.14
    : typeof context.provider === 'string' && skill.name === 'integration' ? 0.22
    : typeof context.screenshot === 'string' && skill.name === 'computer-use' ? 0.16
    : typeof context.domSnapshot !== 'undefined' && skill.name === 'computer-use' ? 0.16
    : 0;
  const confidenceBoost = intent.confidence < 0.7 ? 0.08 : 0;
  const score = clamp(base + sourceHint + focusBoost + freshnessBoost + contextBoost + confidenceBoost, 0, 1);
  const selectedKind = selectedKindForSkill(skill.name, intent, context);
  return {
    skill: skill.name,
    domain: skill.domain,
    capabilities: [...skill.capabilities],
    score,
    reasons: [
      `overlap=${overlap(tokens, skillTokens).toFixed(2)}`,
      `source=${sourceBucketForSkill(skill.name, intent, context)}`,
      `focus=${intent.focus}`,
      `freshness=${intent.freshness}`,
    ],
    selectedKind,
    availableKinds: availableKindsForSkill(skill.name, intent, context),
  };
}

function availableKindsForSkill(skill: string, intent: SearchIntent, context: PlannerResolveContext): PlanStep['kind'][] {
  switch (skill) {
    case 'browser':
      return typeof context.url === 'string' || intent.sourceHints.includes('web') || intent.sourceHints.includes('realtime-web')
        ? ['browser.navigate', 'browser.extract']
        : ['verify'];
    case 'integration':
      return ['integration.call'];
    case 'harness':
      if (Array.isArray(context.messages) || typeof context.threadId === 'string' || typeof context.threadSubject === 'string') return ['harness.readthread', 'harness.draftreply'];
      if (Array.isArray(context.events) || typeof context.timezone === 'string' || typeof context.availability === 'object') return ['harness.conflict_detection'];
      if (Array.isArray(context.relationships)) return ['harness.relationship_recall'];
      if (Array.isArray(context.files) || typeof context.basePath === 'string') return ['harness.filesystem_scan'];
      return ['harness.readthread'];
    case 'autopilot':
      return ['autopilot.loop'];
    case 'user-modeling':
      return ['user-modeling'];
    case 'grounding':
      return ['grounding'];
    case 'signal-observation':
      return ['signal-observation'];
    case 'computer-use':
      return ['computer-use.vision'];
    default:
      return ['verify'];
  }
}

function selectedKindForSkill(skill: string, intent: SearchIntent, context: PlannerResolveContext): PlanStep['kind'] {
  return availableKindsForSkill(skill, intent, context)[0] ?? 'verify';
}

function chooseStrategy(intent: SearchIntent, affordances: PlannerToolAffordance[]): PlannerStrategy {
  if (intent.focus === 'trust' || intent.trustMode === 'official-first' || affordances.some((affordance) => affordance.skill === 'grounding' && affordance.score > 0.6)) return 'trust-first';
  if (intent.focus === 'multi-hop' || intent.hopBudget > 2) return 'multi-hop';
  if (intent.freshness === 'live' || affordances.some((affordance) => affordance.skill === 'browser' && affordance.score > 0.5)) return 'freshness-first';
  if (intent.focus === 'exploratory' || intent.focus === 'semantic') return 'semantic-first';
  return 'blend';
}

function deriveQuestions(intent: SearchIntent, context: PlannerResolveContext): string[] {
  const seedQuestions = [...intent.decomposedQuestions];
  if (seedQuestions.length === 0) {
    seedQuestions.push(intent.semanticQuery || intent.objective);
  }
  if (Array.isArray(context.questions)) {
    seedQuestions.push(...context.questions.map(String).filter(Boolean));
  }
  if (intent.semanticFrames.length > 0) {
    for (const frame of intent.semanticFrames.slice(0, 3)) {
      const entity = frame.slots.entities?.[0] ?? intent.entities[0] ?? intent.semanticQuery;
      seedQuestions.push(`${frame.name}: resolve ${entity}`);
    }
  }
  return uniq(seedQuestions).slice(0, Math.max(2, Math.min(6, intent.hopBudget + 1)));
}

function buildRecoveryPolicy(intent: SearchIntent, affordances: PlannerToolAffordance[], strategy: PlannerStrategy): PlannerRecoveryPolicy {
  const fallbackSkills = affordances
    .slice()
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((affordance) => affordance.skill);
  const mode: PlannerRecoveryPolicy['mode'] = intent.confidence < 0.58 ? 'replan' : intent.ambiguities.length > 0 ? 'retry' : strategy === 'multi-hop' ? 'compensate' : 'retry';
  const maxAttemptsPerStep = strategy === 'multi-hop' ? 3 : strategy === 'trust-first' ? 2 : 2;
  const maxReplans = intent.confidence < 0.7 ? 2 : 1;
  return {
    mode,
    maxReplans,
    maxAttemptsPerStep,
    blockedKinds: affordances.filter((affordance) => affordance.score < 0.2).map((affordance) => affordance.selectedKind),
    fallbackSkills: fallbackSkills.length > 0 ? fallbackSkills : ['verify'],
    recoveryNotes: uniq([
      ...intent.ambiguities.map((ambiguity) => ambiguity.resolutionHint),
      ...(intent.nlu.warnings ?? []),
      `strategy=${strategy}`,
      `hopBudget=${intent.hopBudget}`,
    ]),
  };
}

function hostnameOrFallback(url: string): string {
  try { return new URL(url).hostname || 'target page'; } catch { return 'target page'; }
}

function buildBrowserSequence(input: TaskInput, intent: SearchIntent, affordance: PlannerToolAffordance, context: PlannerResolveContext, index: number): PlannerActionPlan[] {
  const url = typeof context.url === 'string' ? context.url : typeof context.targetUrl === 'string' ? String(context.targetUrl) : null;
  if (!url) return [{ stepKind: 'verify', title: intent.semanticQuery || input.objective, skill: affordance.skill, args: { objective: input.objective, context, semanticIntent: intent, affordance }, stateLabel: 'browser-checkpoint' }];
  return [
    {
      stepKind: 'browser.navigate',
      title: `open ${hostnameOrFallback(url)}`,
      skill: affordance.skill,
      args: { objective: input.objective, context, url, semanticIntent: intent, affordance, mode: 'navigate' },
      stateLabel: `browser-navigate-${index}`,
    },
    {
      stepKind: 'browser.extract',
      title: `extract evidence from ${hostnameOrFallback(url)}`,
      skill: affordance.skill,
      args: { objective: input.objective, context, url, selector: 'body', semanticIntent: intent, affordance, mode: 'extract' },
      stateLabel: `browser-extract-${index}`,
    },
  ];
}

function buildHarnessSequence(input: TaskInput, intent: SearchIntent, affordance: PlannerToolAffordance, context: PlannerResolveContext): PlannerActionPlan[] {
  if (Array.isArray(context.messages) || typeof context.threadId === 'string' || typeof context.threadSubject === 'string') {
    const readArgs = { objective: input.objective, context, threadId: context.threadId ?? null, messages: context.messages ?? [], relationshipTerms: context.relationshipTerms ?? [], semanticIntent: intent, affordance, role: 'read-thread' };
    const draftArgs = { objective: input.objective, context, threadSubject: context.threadSubject ?? null, threadSummary: context.threadSummary ?? null, tone: context.tone ?? 'concise professional', intent: context.intent ?? intent.semanticQuery, semanticIntent: intent, affordance, role: 'draft-reply' };
    return [
      { stepKind: 'harness.readthread', title: 'read the thread through the harness', skill: affordance.skill, args: readArgs, stateLabel: 'thread-read' },
      { stepKind: 'harness.draftreply', title: 'draft the reply through the harness', skill: affordance.skill, args: draftArgs, dependsOn: ['read-thread'], stateLabel: 'thread-draft' },
    ];
  }
  if (Array.isArray(context.events) || typeof context.timezone === 'string' || typeof context.availability === 'object') {
    return [{ stepKind: 'harness.conflict_detection', title: 'detect calendar conflicts', skill: affordance.skill, args: { objective: input.objective, context, events: context.events ?? [], timezone: context.timezone ?? 'UTC', semanticIntent: intent, affordance }, stateLabel: 'calendar-conflicts' }];
  }
  if (Array.isArray(context.relationships)) {
    return [{ stepKind: 'harness.relationship_recall', title: 'recall the relationship context', skill: affordance.skill, args: { objective: input.objective, context, query: input.objective, relationships: context.relationships ?? [], semanticIntent: intent, affordance }, stateLabel: 'relationship-recall' }];
  }
  if (Array.isArray(context.files) || typeof context.basePath === 'string') {
    return [{ stepKind: 'harness.filesystem_scan', title: 'scan the workspace with the harness', skill: affordance.skill, args: { objective: input.objective, context, basePath: context.basePath ?? '.', files: context.files ?? [], semanticIntent: intent, affordance }, stateLabel: 'filesystem-scan' }];
  }
  return [{ stepKind: 'harness.readthread', title: intent.semanticQuery || input.objective, skill: affordance.skill, args: { objective: input.objective, context, semanticIntent: intent, affordance }, stateLabel: 'harness-fallback' }];
}

function buildIntegrationSequence(input: TaskInput, intent: SearchIntent, affordance: PlannerToolAffordance, context: PlannerResolveContext): PlannerActionPlan[] {
  const provider = typeof context.provider === 'string' ? context.provider : intent.sourceHints.find((source) => source !== 'web' && source !== 'realtime-web') ?? 'integration';
  const action = typeof context.action === 'string' ? context.action : typeof context.intentAction === 'string' ? String(context.intentAction) : 'inspect';
  return [{ stepKind: 'integration.call', title: `${provider} ${action}`, skill: affordance.skill, args: { objective: input.objective, context, provider, action, payload: { ...context, objective: input.objective, semanticQuery: intent.semanticQuery }, semanticIntent: intent, affordance }, stateLabel: 'integration-call' }];
}

function buildSkillSequence(input: TaskInput, intent: SearchIntent, affordance: PlannerToolAffordance, context: PlannerResolveContext, index: number): PlannerActionPlan[] {
  switch (affordance.skill) {
    case 'browser':
      return buildBrowserSequence(input, intent, affordance, context, index);
    case 'harness':
      return buildHarnessSequence(input, intent, affordance, context);
    case 'integration':
      return buildIntegrationSequence(input, intent, affordance, context);
    case 'autopilot':
      return [{ stepKind: 'autopilot.loop', title: 'run the autopilot loop', skill: affordance.skill, args: { objective: input.objective, context, mode: 'proactivity', desiredCadence: context.desiredCadence ?? 'daily', harnessState: context.harnessState ?? {}, semanticIntent: intent, affordance }, stateLabel: 'autopilot-loop' }];
    case 'user-modeling':
      return [{ stepKind: 'user-modeling', title: 'build a compact user model', skill: affordance.skill, args: { objective: input.objective, context, signals: ['preference', 'tone', 'profile', 'style'], semanticIntent: intent, affordance }, stateLabel: 'user-model' }];
    case 'grounding':
      return [{ stepKind: 'grounding', title: 'ground the claims in evidence', skill: affordance.skill, args: { objective: input.objective, context, claims: context.claims ?? [], evidence: context.evidence ?? [], semanticIntent: intent, affordance }, stateLabel: 'grounding' }];
    case 'signal-observation':
      return [{ stepKind: 'signal-observation', title: 'observe the relevant signals', skill: affordance.skill, args: { objective: input.objective, context, signals: context.signals ?? ['trend', 'signal', 'telemetry'], window: context.window ?? 'latest', semanticIntent: intent, affordance }, stateLabel: 'signal-observation' }];
    case 'computer-use':
      return [{ stepKind: 'computer-use.vision', title: 'prepare a vision-backed computer-use flow', skill: affordance.skill, args: { objective: input.objective, context, screenshot: context.screenshot ?? null, domSnapshot: context.domSnapshot ?? null, actions: context.actions ?? [], surface: context.surface ?? 'desktop', semanticIntent: intent, affordance }, stateLabel: 'computer-use' }];
    default:
      return [{ stepKind: affordance.selectedKind, title: intent.semanticQuery || input.objective, skill: affordance.skill, args: { objective: input.objective, context, semanticIntent: intent, affordance }, stateLabel: `skill-${affordance.skill}` }];
  }
}

function buildIntentGraph(input: TaskInput, intent: SearchIntent, affordances: PlannerToolAffordance[], strategy: PlannerStrategy, context: PlannerResolveContext, steps: PlanStep[], actionPlans: PlannerActionPlan[], recoveryPolicy: PlannerRecoveryPolicy): PlannerIntentGraph {
  const goalId = stableHash(`goal:${input.id}:${intent.semanticQuery}`);
  const nodes: PlannerIntentNode[] = [
    {
      id: goalId,
      kind: 'goal',
      label: 'goal',
      summary: input.objective,
      status: 'active',
      confidence: intent.confidence,
      metadata: { semanticQuery: intent.semanticQuery, strategy },
    },
  ];
  const edges: PlannerIntentEdge[] = [];
  const stateAnchorByStepId: Record<string, string> = {};
  const stepOrder = steps.map((step) => step.id);
  const frontier: string[] = [];

  const questionSeeds = deriveQuestions(intent, context);
  for (const [index, question] of questionSeeds.entries()) {
    const questionId = stableHash(`question:${input.id}:${index}:${question}`);
    nodes.push({
      id: questionId,
      kind: 'subgoal',
      label: `subgoal-${index + 1}`,
      summary: question,
      status: index === 0 ? 'active' : 'pending',
      confidence: clamp(intent.confidence + 0.05 - index * 0.02),
      dependsOn: [goalId],
      metadata: { question, index, semanticQuery: intent.semanticQuery },
    });
    edges.push({ from: goalId, to: questionId, relation: 'decomposes-into', weight: clamp(0.72 - index * 0.08) });
  }

  for (const [index, affordance] of affordances.slice(0, Math.max(2, steps.length)).entries()) {
    nodes.push({
      id: `tool:${affordance.skill}:${index}`,
      kind: 'tool',
      label: affordance.skill,
      summary: affordance.reasons.join('; '),
      status: 'pending',
      confidence: affordance.score,
      metadata: { skill: affordance.skill, selectedKind: affordance.selectedKind, capabilities: affordance.capabilities },
    });
  }

  for (const actionPlan of actionPlans) {
    const step = steps.find((candidate) => candidate.title === actionPlan.title && candidate.skill === actionPlan.skill && candidate.kind === actionPlan.stepKind) ?? null;
    if (!step) continue;
    const stateNodeId = stableHash(`state:${step.id}:${actionPlan.stateLabel}`);
    stateAnchorByStepId[step.id] = stateNodeId;
    nodes.push({
      id: step.id,
      kind: 'tool',
      label: `${step.skill}:${step.kind}`,
      summary: step.title,
      status: 'pending',
      stepId: step.id,
      dependsOn: step.dependsOn ?? [],
      confidence: 0.7,
      metadata: { args: step.args, actionPlan },
    });
    nodes.push({
      id: stateNodeId,
      kind: 'state',
      label: actionPlan.stateLabel,
      summary: `checkpoint after ${step.title}`,
      status: 'pending',
      dependsOn: [step.id],
      confidence: 0.62,
      metadata: { afterStepId: step.id, stepTitle: step.title },
    });
    edges.push({ from: step.dependsOn?.[0] ?? goalId, to: step.id, relation: step.dependsOn?.length ? 'depends-on' : 'routes-to', weight: 0.82 });
    edges.push({ from: step.id, to: stateNodeId, relation: 'tracks-state', weight: 0.78 });
    frontier.push(step.id);
  }

  if (intent.ambiguities.length > 0) {
    for (const [index, ambiguity] of intent.ambiguities.entries()) {
      const ambiguityId = stableHash(`ambiguity:${input.id}:${index}:${ambiguity.issue}`);
      nodes.push({
        id: ambiguityId,
        kind: 'ambiguity',
        label: ambiguity.issue,
        summary: ambiguity.resolutionHint,
        status: 'pending',
        confidence: ambiguity.confidence,
        dependsOn: [goalId],
        metadata: { candidates: ambiguity.candidates },
      });
      edges.push({ from: goalId, to: ambiguityId, relation: 'blocks', weight: clamp(0.4 + ambiguity.confidence * 0.3) });
    }
  }

  const recoveryNodeId = stableHash(`recovery:${input.id}:${strategy}`);
  nodes.push({
    id: recoveryNodeId,
    kind: 'recovery',
    label: 'recovery-policy',
    summary: recoveryPolicy.recoveryNotes.join(' | '),
    status: 'pending',
    confidence: clamp(0.6 + intent.confidence * 0.2),
    metadata: { policy: recoveryPolicy, strategy },
  });
  for (const stepId of stepOrder) {
    edges.push({ from: stepId, to: recoveryNodeId, relation: 'recovers', weight: 0.3 });
  }

  const lastStep = stepOrder.at(-1);
  if (lastStep) {
    edges.push({ from: lastStep, to: recoveryNodeId, relation: 'confirms', weight: 0.45 });
    frontier.push(lastStep);
  }

  return {
    id: stableHash(`planner-graph:${input.id}:${intent.semanticQuery}:${strategy}`),
    objective: input.objective,
    normalizedObjective: normalize(input.objective),
    semanticQuery: intent.semanticQuery,
    strategy,
    semanticProvider: intent.nlu.provider,
    confidence: intent.confidence,
    nodes,
    edges,
    frontier: uniq(frontier),
    stepOrder,
    stateAnchorByStepId,
    toolAffordances: affordances,
    recoveryPolicy,
    warnings: uniq(intent.nlu.warnings ?? []),
  };
}

function buildSupportStep(input: TaskInput, intent: SearchIntent, affordance: PlannerToolAffordance, context: PlannerResolveContext): PlannerActionPlan {
  return {
    stepKind: affordance.selectedKind,
    title: `stabilize plan with ${affordance.skill}`,
    skill: affordance.skill,
    args: { objective: input.objective, context, semanticIntent: intent, affordance, mode: 'support' },
    stateLabel: `support-${affordance.skill}`,
    support: true,
  };
}

function selectSupportAffordance(affordances: PlannerToolAffordance[], intent: SearchIntent, context: PlannerResolveContext): PlannerToolAffordance | null {
  const candidates = affordances
    .filter((affordance) => ['grounding', 'user-modeling', 'signal-observation', 'harness'].includes(affordance.skill))
    .sort((left, right) => right.score - left.score);
  if (candidates.length > 0 && (intent.confidence < 0.78 || intent.ambiguities.length > 0 || intent.focus === 'trust' || intent.focus === 'diagnostic')) return candidates[0];
  if (typeof context.provider === 'string' || Array.isArray(context.messages) || Array.isArray(context.events) || Array.isArray(context.files)) {
    return candidates[0] ?? null;
  }
  return null;
}

function shouldVerify(intent: SearchIntent, strategy: PlannerStrategy, affordances: PlannerToolAffordance[]): boolean {
  return intent.focus === 'trust' || strategy === 'multi-hop' || strategy === 'freshness-first' || intent.hopBudget > 2 || affordances.some((affordance) => affordance.skill === 'grounding' && affordance.score > 0.45);
}

function buildVerificationAffordance(affordances: PlannerToolAffordance[], intent: SearchIntent): PlannerToolAffordance {
  const sorted = affordances.slice().sort((left, right) => right.score - left.score);
  const grounding = sorted.find((affordance) => affordance.skill === 'grounding') ?? sorted[0] ?? {
    skill: 'verify',
    domain: 'plan-validation',
    capabilities: ['validation'],
    score: 0.5,
    reasons: ['verification fallback'],
    selectedKind: 'verify',
    availableKinds: ['verify'],
  };
  return { ...grounding, selectedKind: 'verify', reasons: [...grounding.reasons, `verify:${intent.focus}`] }; 
}

function selectedStepsFromPlans(actionPlans: PlannerActionPlan[], input: TaskInput, intent: SearchIntent, context: PlannerResolveContext): PlanStep[] {
  const steps: PlanStep[] = [];
  let dependencyChain: string[] | undefined;
  for (const [index, actionPlan] of actionPlans.entries()) {
    const stepId = randomUUID();
    const step: PlanStep = {
      id: stepId,
      position: index,
      kind: actionPlan.stepKind,
      title: actionPlan.title,
      skill: actionPlan.skill,
      args: {
        ...actionPlan.args,
        objective: input.objective,
        semanticIntent: intent,
        context,
      },
      dependsOn: dependencyChain,
      retryPolicy: { maxAttempts: ((context.recoveryPolicy as PlannerRecoveryPolicy | undefined)?.maxAttemptsPerStep ?? 2), retryableKinds: ['transient', 'temporary_unavailable', 'rate_limit'] },
    };
    steps.push(step);
    dependencyChain = [step.id];
  }
  return steps;
}

function buildPlanFromIntent(input: TaskInput, intent: SearchIntent, context: PlannerResolveContext): TaskPlan {
  const skills = normalizeSkills(context.skillCatalog);
  const affordances = skills.map((skill) => scoreSkill(skill, intent, context)).sort((left, right) => right.score - left.score);
  const strategy = chooseStrategy(intent, affordances);
  const recoveryPolicy = buildRecoveryPolicy(intent, affordances, strategy);
  context.recoveryPolicy = recoveryPolicy;

  const actionPlans: PlannerActionPlan[] = [];
  const supportAffordance = selectSupportAffordance(affordances, intent, context);
  if (supportAffordance) actionPlans.push(buildSupportStep(input, intent, supportAffordance, context));

  const questions = deriveQuestions(intent, context);
  const usedSkills = new Set<string>(actionPlans.map((plan) => plan.skill));
  for (const [index, question] of questions.entries()) {
    const preferred = affordances.find((affordance) => !usedSkills.has(affordance.skill) && affordance.availableKinds.length > 0) ?? affordances[0];
    if (!preferred) continue;
    const questionPlans = buildSkillSequence(input, intent, preferred, context, index);
    for (const plan of questionPlans) {
      if (plan.skill === 'browser' && !questionPlans.some((entry) => entry.stepKind === 'browser.extract')) {
        plan.title = question;
      }
      actionPlans.push({ ...plan, title: plan.title || question });
      usedSkills.add(plan.skill);
    }
  }

  if (shouldVerify(intent, strategy, affordances) && affordances.length > 0) {
    const verification = buildVerificationAffordance(affordances, intent);
    actionPlans.push({ stepKind: 'verify', title: 'verify the plan and recovery posture', skill: verification.skill, args: { objective: input.objective, context, semanticIntent: intent, affordance: verification, mode: 'verification' }, stateLabel: 'verification' });
  }

  const steps = selectedStepsFromPlans(actionPlans, input, intent, context);
  if (steps.length === 0) throw new Error('planner could not synthesize an LLM-backed plan');
  for (const [index, step] of steps.entries()) step.position = index;
  const graph = buildIntentGraph(input, intent, affordances, strategy, context, steps, actionPlans, recoveryPolicy);
  return {
    taskId: input.id,
    objective: input.objective,
    steps,
    semanticIntent: intent,
    intentGraph: graph,
    planner: {
      provider: intent.nlu.provider,
      fallbackUsed: intent.nlu.fallbackUsed,
      strategy,
      confidence: intent.nlu.confidence,
      warnings: uniq(intent.nlu.warnings ?? []),
      semanticQuery: intent.semanticQuery,
      decompositionCount: intent.decomposedQuestions.length,
    },
  };
}

export async function resolvePlannerIntent(objective: string, context: PlannerResolveContext = {}): Promise<SearchIntent> {
  const provider = context.plannerProvider ?? context.semanticProvider ?? DEFAULT_LLM_SEMANTIC_NLU_PROVIDER;
  try {
    return await understandSearchIntentWithNlu(objective, context, provider, false);
  } catch {
    try {
      return await understandSearchIntentWithNlu(objective, context, DEFAULT_LLM_SEMANTIC_NLU_PROVIDER, false);
    } catch {
      return understandSearchIntent(objective, context);
    }
  }
}

export function buildPlan(input: TaskInput): TaskPlan {
  const context = (input.context ?? {}) as PlannerResolveContext;
  const semanticIntent = asSearchIntent(context.semanticIntent) ?? understandSearchIntent(input.objective, context);
  const enrichedContext: PlannerResolveContext = { ...context, semanticIntent, skillCatalog: normalizeSkills(context.skillCatalog) };
  return buildPlanFromIntent(input, semanticIntent, enrichedContext);
}

export function createPlannerRuntimeState(plan: TaskPlan): PlannerRuntimeState {
  return {
    strategy: plan.planner?.strategy ?? 'blend',
    provider: plan.planner?.provider ?? plan.semanticIntent?.nlu.provider ?? 'semantic-fallback',
    fallbackUsed: plan.planner?.fallbackUsed ?? false,
    confidence: plan.planner?.confidence ?? plan.semanticIntent?.nlu.confidence ?? 0.5,
    currentNodeId: plan.steps[0]?.id ?? null,
    completedNodeIds: [],
    blockedNodeIds: [],
    notes: uniq([...(plan.planner?.warnings ?? []), ...(plan.intentGraph?.warnings ?? []), `objective=${plan.objective}`]),
  };
}

export function cloneIntentGraph(graph?: PlannerIntentGraph | null): PlannerIntentGraph | undefined {
  return graph ? JSON.parse(JSON.stringify(graph)) as PlannerIntentGraph : undefined;
}

export function markPlannerStepOutcome(graph: PlannerIntentGraph | undefined, stepId: string, status: PlannerIntentNode['status'], note?: string): PlannerIntentGraph | undefined {
  if (!graph) return graph;
  const next = cloneIntentGraph(graph)!;
  const node = next.nodes.find((candidate) => candidate.id === stepId);
  if (node) {
    node.status = status;
    if (note) node.metadata = { ...node.metadata, note };
  }
  const anchorId = next.stateAnchorByStepId[stepId];
  if (anchorId) {
    const anchor = next.nodes.find((candidate) => candidate.id === anchorId);
    if (anchor) {
      anchor.status = status === 'failed' ? 'blocked' : 'done';
      if (note) anchor.metadata = { ...anchor.metadata, note };
    }
  }
  const completed = new Set(next.nodes.filter((candidate) => candidate.status === 'done').map((candidate) => candidate.id));
  next.frontier = next.stepOrder.filter((candidate) => !completed.has(candidate));
  return next;
}

export function updatePlannerRuntimeState(state: PlannerRuntimeState | undefined, plan: TaskPlan, stepId: string, status: PlannerIntentNode['status'], note?: string): PlannerRuntimeState {
  const next: PlannerRuntimeState = state ? JSON.parse(JSON.stringify(state)) as PlannerRuntimeState : createPlannerRuntimeState(plan);
  next.currentNodeId = stepId;
  if (status === 'done') {
    if (!next.completedNodeIds.includes(stepId)) next.completedNodeIds.push(stepId);
  } else if (status === 'failed') {
    if (!next.blockedNodeIds.includes(stepId)) next.blockedNodeIds.push(stepId);
  }
  if (note) next.notes = uniq([...next.notes, note]);
  return next;
}

export function notePlannerRecovery(state: PlannerRuntimeState | undefined, stepId: string, reason: string): PlannerRuntimeState {
  const next: PlannerRuntimeState = state ? JSON.parse(JSON.stringify(state)) as PlannerRuntimeState : {
    strategy: 'blend',
    provider: 'semantic-fallback',
    fallbackUsed: true,
    confidence: 0.5,
    currentNodeId: stepId,
    completedNodeIds: [],
    blockedNodeIds: [],
    notes: [],
  };
  next.currentNodeId = stepId;
  if (!next.blockedNodeIds.includes(stepId)) next.blockedNodeIds.push(stepId);
  next.lastRecovery = { stepId, reason, at: Date.now() };
  next.notes = uniq([...next.notes, `recovery:${reason}`]);
  return next;
}

export function deriveExecutionProfile(plan: TaskPlan): ExecutionProfile {
  const intent = plan.semanticIntent;
  const scores = new Map<string, number>([
    ['email', 0],
    ['calendar', 0],
    ['browser', 0],
    ['filesystem', 0],
    ['integration', 0],
    ['memory', 0],
  ]);
  const bump = (key: string, amount: number) => scores.set(key, (scores.get(key) ?? 0) + amount);
  const sourceHintBucket = (source: SearchSource | string): string => {
    if (source === 'web' || source === 'realtime-web') return 'browser';
    if (source === 'github' || source === 'integration' || source === 'slack' || source === 'vercel' || source === 'todoist' || source === 'linear' || source === 'notion') return 'integration';
    if (source === 'calendar') return 'calendar';
    if (source === 'email') return 'email';
    if (source === 'filesystem') return 'filesystem';
    return 'memory';
  };
  if (intent) {
    for (const hint of intent.sourceHints) bump(sourceHintBucket(hint), 4);
    if (intent.freshness === 'live') bump('browser', 2.5);
    if (intent.freshness === 'recent') bump('integration', 1);
    if (intent.focus === 'trust' || intent.focus === 'diagnostic') bump('memory', 1.5);
    if (intent.hopBudget > 2) bump('integration', 1.5);
  }
  for (const affordance of plan.intentGraph?.toolAffordances ?? []) {
    bump(sourceBucketForSkill(affordance.skill, intent), 2 + affordance.score * 2.5);
  }
  for (const step of plan.steps) {
    bump(sourceBucketForSkill(step.skill, intent), 1.2);
  }
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [primarySource = 'integration'] = ordered.map(([name]) => name);
  const secondarySources = ordered.map(([name]) => name).filter((name) => name !== primarySource && (scores.get(name) ?? 0) > 0);
  const parallelizable = plan.steps.length > 1 && primarySource !== 'calendar' && (intent?.hopBudget ?? 1) > 1;
  const rationale = [
    `strategy=${plan.planner?.strategy ?? 'blend'}`,
    `semantic=${intent?.semanticQuery ?? plan.objective}`,
    ...(intent?.decomposedQuestions ?? []).slice(0, 3).map((question) => `question=${question}`),
    ...ordered.filter(([, score]) => score > 0).slice(0, 4).map(([source, score]) => `${source}:${score.toFixed(2)}`),
  ];
  return {
    primarySource,
    secondarySources,
    parallelizable,
    rationale,
    strategy: plan.planner?.strategy,
    affordanceSignals: (plan.intentGraph?.toolAffordances ?? []).slice(0, 5).map((affordance) => ({ skill: affordance.skill, score: affordance.score, bucket: sourceBucketForSkill(affordance.skill, intent), kind: affordance.selectedKind })),
  };
}

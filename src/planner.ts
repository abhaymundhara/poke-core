import { randomUUID } from 'node:crypto';
import type { PlanStep, TaskInput, TaskPlan } from './types';

type Cue = {
  skill: string;
  kind: PlanStep['kind'];
  title: string;
  patterns: RegExp[];
  buildArgs: (objective: string, context: Record<string, unknown>) => Record<string, unknown>;
};

const FLAGSHIP_CUES: Cue[] = [
  {
    skill: 'autopilot',
    kind: 'autopilot.loop',
    title: 'run the autopilot loop',
    patterns: [/\bautopilot\b/i, /\bself[- ]driving\b/i, /\bself[- ]direct(?:ed|ing)\b/i, /\bbackground trigger\b/i, /\bscheduled check[- ]in\b/i, /\bproactivity\b/i],
    buildArgs: (objective, context) => ({ objective, context, mode: 'proactivity', desiredCadence: context.cadence ?? 'daily', harnessState: context.harnessState ?? {} }),
  },
  {
    skill: 'user-modeling',
    kind: 'user-modeling',
    title: 'build a compact user model',
    patterns: [/\buser model(?:ing)?\b/i, /\bpersona\b/i, /\bpreference(?:s)?\b/i, /\bprofile\b/i, /\btone\b/i, /\bstyle\b/i],
    buildArgs: (objective, context) => ({ objective, context, signals: ['preference', 'tone', 'profile', 'style'] }),
  },
  {
    skill: 'grounding',
    kind: 'grounding',
    title: 'ground the claims in evidence',
    patterns: [/\bgrounding\b/i, /\bevidence\b/i, /\bsource\b/i, /\bcitation\b/i, /\bclaim\b/i, /\bfact\b/i],
    buildArgs: (objective, context) => ({ objective, context, claims: context.claims ?? [], evidence: context.evidence ?? [] }),
  },
  {
    skill: 'signal-observation',
    kind: 'signal-observation',
    title: 'observe the relevant signals',
    patterns: [/\bsignal(?:s)?\b/i, /\bobservation\b/i, /\bobserve\b/i, /\bmonitor\b/i, /\btelemetry\b/i, /\banomal(?:y|ies)\b/i, /\btrend\b/i],
    buildArgs: (objective, context) => ({ objective, context, signals: context.signals ?? ['trend', 'signal', 'telemetry'], window: context.window ?? 'latest' }),
  },
  {
    skill: 'computer-use',
    kind: 'computer-use.vision',
    title: 'prepare a vision-backed computer-use flow',
    patterns: [/\bcomputer use\b/i, /\bdesktop\b/i, /\bgui\b/i, /\bui\b/i, /\bclick\b/i, /\btype\b/i, /\bscroll\b/i, /\bdrag\b/i, /\bwindow\b/i, /\bscreenshot\b/i, /\bdom snapshot\b/i],
    buildArgs: (objective, context) => ({ objective, context, screenshot: context.screenshot ?? null, domSnapshot: context.domSnapshot ?? null, actions: context.actions ?? [], surface: context.surface ?? 'desktop' }),
  },
  {
    skill: 'harness',
    kind: 'harness.relationship_recall',
    title: 'recall the relationship context',
    patterns: [/\brelationship\b/i, /\bcontact\b/i, /\bwho should i\b/i, /\bfollow up\b/i, /\breach out\b/i, /\bwho do i\b/i],
    buildArgs: (objective, context) => ({ objective, context, query: objective, relationships: context.relationships ?? [] }),
  },
  {
    skill: 'harness',
    kind: 'harness.readthread',
    title: 'read the thread through the harness',
    patterns: [/\bthread\b/i, /\binbox\b/i, /\bemail\b/i, /\bmessage\b/i, /\bread the thread\b/i],
    buildArgs: (objective, context) => ({ objective, context, threadId: context.threadId ?? null, messages: context.messages ?? [], relationshipTerms: context.relationshipTerms ?? [] }),
  },
  {
    skill: 'harness',
    kind: 'harness.draftreply',
    title: 'draft the reply through the harness',
    patterns: [/\breply\b/i, /\bdraft\b/i, /\brespond\b/i, /\banswer\b/i, /\bfollow[- ]up\b/i],
    buildArgs: (objective, context) => ({ objective, context, threadSubject: context.threadSubject ?? null, threadSummary: context.threadSummary ?? null, intent: context.intent ?? 'reply concisely and professionally', tone: context.tone ?? 'concise professional' }),
  },
  {
    skill: 'harness',
    kind: 'harness.conflict_detection',
    title: 'detect the calendar conflicts',
    patterns: [/\bcalendar\b/i, /\bmeeting\b/i, /\bschedule\b/i, /\bavailability\b/i, /\bconflict\b/i, /\breschedule\b/i],
    buildArgs: (objective, context) => ({ objective, context, events: context.events ?? [], timezone: context.timezone ?? 'UTC' }),
  },
  {
    skill: 'harness',
    kind: 'harness.filesystem_scan',
    title: 'scan the workspace with the harness',
    patterns: [/\bfile\b/i, /\bfilesystem\b/i, /\bfolder\b/i, /\bpath\b/i, /\bdirectory\b/i, /\bscan\b/i, /\bdiff\b/i, /\bexport\b/i],
    buildArgs: (objective, context) => ({ objective, context, basePath: context.basePath ?? '.', files: context.files ?? [] }),
  },
];

function hasUrl(text: string): string | null {
  const match = text.match(/(?:https?|file):\/\/\S+/i);
  return match?.[0] ?? null;
}

function detectProvider(text: string): string | null {
  const providers = ['github', 'notion', 'linear', 'todoist', 'vercel', 'slack'];
  return providers.find((provider) => new RegExp(`\\b${provider}\\b`, 'i').test(text)) ?? null;
}

function detectAction(text: string): string | null {
  const actions: Array<[string, RegExp]> = [
    ['inspect', /\binspect\b/i],
    ['create', /\bcreate\b/i],
    ['update', /\bupdate\b/i],
    ['comment', /\bcomment\b/i],
    ['deploy', /\bdeploy\b/i],
    ['post_message', /\bpost[_-]?message\b/i],
    ['add_task', /\badd[_-]?task\b/i],
    ['complete_task', /\bcomplete[_-]?task\b/i],
    ['append', /\bappend\b/i],
  ];
  return actions.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function addCueStep(steps: PlanStep[], cue: Cue, objective: string, context: Record<string, unknown>) {
  const step: PlanStep = {
    id: randomUUID(),
    position: steps.length,
    kind: cue.kind,
    title: cue.title,
    skill: cue.skill,
    args: cue.buildArgs(objective, context),
    retryPolicy: { maxAttempts: 2, retryableKinds: ['transient', 'temporary_unavailable'] },
  };
  steps.push(step);
  return step;
}

export function buildPlan(input: TaskInput): TaskPlan {
  const objective = input.objective.trim();
  const context: Record<string, unknown> = input.context ?? {};
  const haystack = `${objective}\n${JSON.stringify(context)}`;
  const steps: PlanStep[] = [];

  for (const cue of FLAGSHIP_CUES) {
    if (!cue.patterns.some((pattern) => pattern.test(haystack))) continue;
    if (steps.some((step) => step.skill === cue.skill && step.kind === cue.kind)) continue;
    const added = addCueStep(steps, cue, objective, context);

    if (added.kind === 'harness.readthread' && /\breply\b|\bdraft\b|\brespond\b|\bfollow[- ]up\b/i.test(haystack)) {
      const replyCue = FLAGSHIP_CUES.find((entry) => entry.kind === 'harness.draftreply');
      if (replyCue) {
        const replyStep = addCueStep(steps, replyCue, objective, context);
        replyStep.dependsOn = [added.id];
      }
    }
  }

  const url = hasUrl(objective) ?? (typeof context.url === 'string' ? String(context.url) : null);
  if (url) {
    const navigateStep: PlanStep = {
      id: randomUUID(),
      position: steps.length,
      kind: 'browser.navigate',
      title: 'navigate to target url',
      skill: 'browser',
      args: { url, objective, context },
      retryPolicy: { maxAttempts: 2, retryableKinds: ['network', 'transient'] },
    };
    steps.push(navigateStep);
    steps.push({
      id: randomUUID(),
      position: steps.length,
      kind: 'browser.extract',
      title: 'extract readable page text',
      skill: 'browser',
      args: { url, selector: 'body', objective, context },
      dependsOn: [navigateStep.id],
      retryPolicy: { maxAttempts: 1, retryableKinds: [] },
    });
  }

  const provider = typeof context.provider === 'string' ? context.provider.trim() : detectProvider(haystack);
  const action = typeof context.action === 'string' ? context.action.trim() : null;
  if (provider) {
    steps.push({
      id: randomUUID(),
      position: steps.length,
      kind: 'integration.call',
      title: `${provider} ${action ?? 'inspect'}`,
      skill: 'integration',
      args: { provider, action: action ?? 'inspect', payload: { ...context, objective } },
      retryPolicy: { maxAttempts: 2, retryableKinds: ['rate_limit', 'temporary_unavailable'] },
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: randomUUID(),
      position: 0,
      kind: 'verify',
      title: 'validate objective shape',
      skill: 'browser',
      args: { objective, context },
      retryPolicy: { maxAttempts: 1, retryableKinds: [] },
    });
  }

  for (const [index, step] of steps.entries()) step.position = index;
  return { taskId: input.id, objective, steps };
}

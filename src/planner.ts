import { randomUUID } from 'node:crypto';
import type { PlanStep, TaskInput, TaskPlan } from './types';

type FlagshipCue = {
  skill: 'autopilot' | 'user-modeling' | 'grounding' | 'signal-observation' | 'computer-use';
  kind: 'autopilot' | 'user-modeling' | 'grounding' | 'signal-observation' | 'computer-use';
  title: string;
  patterns: RegExp[];
  signals: string[];
};

const FLAGSHIP_CUES: FlagshipCue[] = [
  {
    skill: 'autopilot',
    kind: 'autopilot',
    title: 'autopilot the objective',
    patterns: [/\bautopilot\b/i, /\bself[- ]driving\b/i, /\bend[- ]to[- ]end\b/i, /\borchestrat(?:e|ion)\b/i],
    signals: ['autopilot', 'plan', 'execute', 'orchestrate'],
  },
  {
    skill: 'user-modeling',
    kind: 'user-modeling',
    title: 'build a compact user model',
    patterns: [/\buser model(?:ing)?\b/i, /\bpersona\b/i, /\bpreference(?:s)?\b/i, /\bprofile\b/i, /\btone\b/i, /\bstyle\b/i],
    signals: ['user model', 'persona', 'preferences', 'profile'],
  },
  {
    skill: 'grounding',
    kind: 'grounding',
    title: 'ground the claims in evidence',
    patterns: [/\bgrounding\b/i, /\bevidence\b/i, /\bsource\b/i, /\bcitation\b/i, /\bclaim\b/i, /\bfact\b/i],
    signals: ['grounding', 'evidence', 'source', 'citation'],
  },
  {
    skill: 'signal-observation',
    kind: 'signal-observation',
    title: 'observe the relevant signals',
    patterns: [/\bsignal(?:s)?\b/i, /\bobservation\b/i, /\bobserve\b/i, /\bmonitor\b/i, /\btelemetry\b/i, /\banomal(?:y|ies)\b/i, /\btrend\b/i],
    signals: ['signal', 'observe', 'monitor', 'telemetry'],
  },
  {
    skill: 'computer-use',
    kind: 'computer-use',
    title: 'prepare a computer-use flow',
    patterns: [/\bcomputer use\b/i, /\bdesktop\b/i, /\bgui\b/i, /\bui\b/i, /\bclick\b/i, /\btype\b/i, /\bscroll\b/i, /\bdrag\b/i, /\bwindow\b/i],
    signals: ['computer use', 'ui', 'click', 'type'],
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

function createFlagshipStep(cue: FlagshipCue, objective: string, context: Record<string, unknown>): PlanStep {
  return {
    id: randomUUID(),
    position: 0,
    kind: cue.kind,
    title: cue.title,
    skill: cue.skill,
    args: {
      objective,
      context,
      matchedSignals: cue.signals,
    },
    retryPolicy: { maxAttempts: 2, retryableKinds: ['transient', 'temporary_unavailable'] },
  };
}

export function buildPlan(input: TaskInput): TaskPlan {
  const objective = input.objective.trim();
  const context: Record<string, unknown> = input.context ?? {};
  const haystack = `${objective}\n${JSON.stringify(context)}`;

  const steps: PlanStep[] = [];

  for (const cue of FLAGSHIP_CUES) {
    if (cue.patterns.some((pattern) => pattern.test(haystack))) {
      const step = createFlagshipStep(cue, objective, context);
      step.position = steps.length;
      steps.push(step);
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

  return { taskId: input.id, objective, steps };
}

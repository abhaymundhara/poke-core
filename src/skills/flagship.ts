import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { SkillAdapter } from './types';

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function readObjective(ctx: ExecutionContext): string {
  return normalizeText(ctx.step.args.objective) || ctx.state.objective;
}

function readContext(ctx: ExecutionContext): Record<string, unknown> {
  const context = ctx.step.args.context;
  return context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
}

function collectSignals(haystack: string, tokens: string[]): string[] {
  const lower = haystack.toLowerCase();
  return [...new Set(tokens.filter((token) => lower.includes(token.toLowerCase())))];
}

function recordArtifact(ctx: ExecutionContext, payload: unknown): void {
  ctx.state.artifacts[ctx.step.id] = payload;
}

function result(note: string, output: unknown, trace: Record<string, unknown>): SkillResult {
  return { ok: true, output, retryable: false, note, trace };
}

export class AutopilotSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'autopilot',
    domain: 'cognitive-orchestration',
    capabilities: ['planning', 'delegation', 'checkpointing'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'autopilot';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const signals = collectSignals(`${objective} ${JSON.stringify(context)}`, ['autopilot', 'plan', 'execute', 'delegate', 'orchestrate', 'sequence', 'guardrail']);
    const output = {
      objective,
      mode: 'autopilot',
      signals,
      phases: ['frame the objective', 'pick a bounded path', 'execute with checkpoints', 'capture recovery notes'],
      guardrails: ['keep side effects explicit', 'prefer deterministic steps', 'preserve recovery history'],
    };
    recordArtifact(ctx, output);
    return result('autopilot scaffold generated', output, { signals });
  }
}

export class UserModelingSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'user-modeling',
    domain: 'user-context',
    capabilities: ['preference extraction', 'tone detection', 'profile shaping'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'user-modeling';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const joinedContext = Object.entries(context)
      .map(([key, value]) => `${key}:${normalizeText(value)}`)
      .join(' ');
    const signals = collectSignals(`${objective} ${joinedContext}`, ['preference', 'preferences', 'tone', 'style', 'persona', 'profile', 'timezone', 'locale', 'channel', 'formal', 'casual', 'brief', 'detailed']);
    const output = {
      objective,
      profile: {
        contextKeys: Object.keys(context).slice(0, 8),
        preferenceHints: signals,
        preferredTone: signals.includes('formal') ? 'formal' : signals.includes('casual') ? 'casual' : 'unspecified',
      },
      confidence: signals.length ? 0.78 : 0.45,
      nextAction: 'use the profile to constrain downstream steps',
    };
    recordArtifact(ctx, output);
    return result('user model inferred from context', output, { signals });
  }
}

export class GroundingSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'grounding',
    domain: 'evidence-management',
    capabilities: ['claim tracing', 'evidence pairing', 'assumption tagging'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'grounding';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const claims = Array.isArray(ctx.step.args.claims)
      ? ctx.step.args.claims.map(normalizeText).filter(Boolean)
      : collectSignals(`${objective} ${JSON.stringify(context)}`, ['claim', 'fact', 'source', 'citation', 'evidence', 'assumption', 'grounding']);
    const evidence = Array.isArray(ctx.step.args.evidence)
      ? ctx.step.args.evidence.map(normalizeText).filter(Boolean)
      : Object.keys(ctx.state.outputs).slice(-5);
    const assumptions = collectSignals(`${objective} ${JSON.stringify(context)}`, ['assume', 'assumption', 'likely', 'maybe', 'probably', 'uncertain']);
    const confidence = Math.min(0.95, 0.45 + evidence.length * 0.12 + (claims.length > 0 ? 0.08 : 0));
    const output = {
      objective,
      groundedFacts: claims,
      evidence,
      assumptions,
      confidence,
    };
    recordArtifact(ctx, output);
    return result('grounding pass completed', output, { evidenceCount: evidence.length, claims });
  }
}

export class SignalObservationSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'signal-observation',
    domain: 'telemetry-analysis',
    capabilities: ['trend detection', 'anomaly detection', 'signal summarization'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'signal-observation';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const signals = Array.isArray(ctx.step.args.signals)
      ? ctx.step.args.signals.map(normalizeText).filter(Boolean)
      : collectSignals(`${objective} ${JSON.stringify(context)}`, ['signal', 'signals', 'observe', 'observation', 'monitor', 'telemetry', 'trend', 'anomaly', 'spike', 'drop', 'pattern']);
    const observationWindow = normalizeText(ctx.step.args.window) || 'latest task context';
    const output = {
      objective,
      observationWindow,
      signals,
      notableChanges: Object.keys(ctx.state.outputs).slice(-3),
      trend: signals.some((signal) => /anomal/i.test(signal)) ? 'watch anomalies' : signals.some((signal) => /trend|spike|drop/i.test(signal)) ? 'scan for movement' : 'steady scan',
    };
    recordArtifact(ctx, output);
    return result('signal observation completed', output, { observationWindow, signals });
  }
}

export class ComputerUseSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'computer-use',
    domain: 'desktop-interaction',
    capabilities: ['ui action planning', 'surface selection', 'fallback planning'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'computer-use';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const objective = readObjective(ctx);
    const context = readContext(ctx);
    const actions = Array.isArray(ctx.step.args.actions)
      ? ctx.step.args.actions.map(normalizeText).filter(Boolean)
      : collectSignals(`${objective} ${JSON.stringify(context)}`, ['click', 'type', 'scroll', 'drag', 'open', 'select', 'submit', 'focus', 'press']);
    const surface = normalizeText(ctx.step.args.surface) || 'desktop';
    const output = {
      objective,
      surface,
      interactionPlan: actions.length > 0 ? actions.map((action) => `perform ${action}`) : ['inspect the interface', 'identify the next target', 'advance only with visible state'],
      safetyChecks: ['confirm the target application', 'avoid hidden destructive actions', 'capture state before submission'],
      fallback: 'degrade to browser extraction if the interface cannot be represented deterministically',
    };
    recordArtifact(ctx, output);
    return result('computer-use interaction plan generated', output, { surface, actions });
  }
}

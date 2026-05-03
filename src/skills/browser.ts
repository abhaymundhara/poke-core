import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import { BrowserRuntime, type BrowserActionResult, type BrowserDomSnapshot, type BrowserInteractionStep, type BrowserRuntimeOptions } from '../runtime/browser';
import type { SkillAdapter } from './types';

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function modeFromStep(step: PlanStep): 'navigate' | 'extract' | 'interact' | 'audit' {
  const args = asRecord(step.args);
  const raw = asText(args.mode || args.action || step.kind.split('.')[1] || 'navigate').toLowerCase();
  if (raw === 'extract' || raw === 'interact' || raw === 'audit') return raw;
  return 'navigate';
}

function buildRuntimeOptions(args: Record<string, unknown>): BrowserRuntimeOptions {
  const viewport = typeof args.viewport === 'object' && args.viewport !== null && !Array.isArray(args.viewport)
    ? args.viewport as { width?: unknown; height?: unknown }
    : undefined;

  const browserName = asText(args.browserName);
  return {
    headless: asBoolean(args.headless, true),
    browserName: browserName === 'firefox' || browserName === 'webkit' ? browserName : 'chromium',
    timeoutMs: asNumber(args.timeoutMs) ?? asNumber(args.timeout) ?? 15_000,
    slowMoMs: asNumber(args.slowMoMs) ?? asNumber(args.slowMo) ?? 0,
    sessionRoot: asText(args.sessionRoot) || undefined,
    launchArgs: asArray(args.launchArgs).map((item) => String(item)),
    viewport: viewport && Number.isFinite(Number(viewport.width)) && Number.isFinite(Number(viewport.height))
      ? { width: Number(viewport.width), height: Number(viewport.height) }
      : undefined,
  };
}

function browserArtifacts(snapshot: BrowserDomSnapshot, actions: BrowserActionResult[]) {
  return [
    { kind: 'dom' as const, value: snapshot },
    ...actions.map((action) => ({
      kind: action.action === 'type' ? 'form-state' as const : action.action === 'click' ? 'link' as const : 'dom' as const,
      value: action,
    })),
  ];
}

function confidenceFromSnapshot(snapshot: BrowserDomSnapshot, actionCount: number): number {
  const base = snapshot.visibleText ? 0.65 : 0.45;
  const textBoost = Math.min(snapshot.visibleText.length / 10_000, 0.2);
  const actionBoost = Math.min(actionCount * 0.05, 0.15);
  return Math.min(0.98, base + textBoost + actionBoost);
}

function summarizeActions(actions: BrowserActionResult[]): string {
  if (!actions.length) return 'no browser actions executed';
  return 'executed ' + actions.length + ' browser action' + (actions.length === 1 ? '' : 's');
}

export class BrowserSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'browser',
    domain: 'web-automation',
    capabilities: ['navigate', 'click', 'type', 'wait', 'scroll', 'dom_snapshot', 'session-persistence'],
    version: '2.0.0',
  };

  private readonly runtime: BrowserRuntime;

  constructor(options: BrowserRuntimeOptions = {}) {
    this.runtime = new BrowserRuntime(options);
  }

  canHandle(step: PlanStep): boolean {
    return step.skill === 'browser' || step.kind === 'browser.navigate' || step.kind === 'browser.extract';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const args = asRecord(ctx.step.args);
    const mode = modeFromStep(ctx.step);
    const sessionKey = asText(args.sessionKey) || 'task:' + ctx.taskId;
    const runtimeOptions = buildRuntimeOptions(args);
    const url = asText(args.url) || asText(args.targetUrl) || asText(args.navigateTo);
    const interactionPlan = asArray(args.interactionPlan).map((step) => step as BrowserInteractionStep);
    const results: BrowserActionResult[] = [];

    try {
      if ((mode === 'navigate' || mode === 'interact' || mode === 'audit') && url) {
        results.push(await this.runtime.navigate({
          sessionKey,
          url,
          overrides: runtimeOptions,
          waitUntil: (asText(args.waitUntil) as 'load' | 'domcontentloaded' | 'networkidle') || 'domcontentloaded',
          retries: asNumber(args.retries) ?? 3,
          backoffMs: asNumber(args.backoffMs) ?? 250,
        }));
      }

      if (interactionPlan.length > 0) {
        const planResult = await this.runtime.runInteractionPlan({
          sessionKey,
          actions: interactionPlan,
          overrides: runtimeOptions,
          retries: asNumber(args.retries) ?? 3,
          backoffMs: asNumber(args.backoffMs) ?? 250,
        });
        results.push(...planResult.actions);
      }

      if (mode === 'extract' || mode === 'audit' || results.length === 0) {
        results.push(await this.runtime.domSnapshot({
          sessionKey,
          overrides: runtimeOptions,
          retries: asNumber(args.retries) ?? 3,
          backoffMs: asNumber(args.backoffMs) ?? 250,
        }));
      }

      const finalSnapshot = results[results.length - 1].snapshot;
      const output = {
        finalUrl: finalSnapshot.url,
        title: finalSnapshot.title,
        text: finalSnapshot.visibleText,
        htmlDigest: finalSnapshot.htmlDigest,
        artifacts: browserArtifacts(finalSnapshot, results),
        navigationTrail: results
          .filter((action) => action.beforeUrl !== action.afterUrl)
          .map((action) => ({ from: action.beforeUrl, to: action.afterUrl, reason: String(action.metadata.selector ?? action.metadata.url ?? action.action) })),
        confidence: confidenceFromSnapshot(finalSnapshot, results.length),
      };

      ctx.state.artifacts[ctx.step.id] = {
        sessionKey,
        mode,
        output,
      };
      ctx.state.outputs[ctx.step.id] = output;

      return {
        ok: true,
        output,
        retryable: false,
        note: summarizeActions(results),
        trace: {
          sessionKey,
          mode,
          headless: runtimeOptions.headless,
          browserName: runtimeOptions.browserName,
          actionCount: results.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /timeout|detached|not visible|not attached|stale|closed|target closed|navigation/i.test(message.toLowerCase());
      const failure = {
        sessionKey,
        mode,
        error: message,
      };
      ctx.state.artifacts[ctx.step.id] = failure;
      return {
        ok: false,
        output: failure,
        retryable,
        note: 'browser automation failed',
        trace: {
          sessionKey,
          mode,
          error: message,
        },
      };
    }
  }
}

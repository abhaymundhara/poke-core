import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ExecutionContext, SkillDescriptor, SkillResult } from '../types';
import type { PlanStep } from '../types';
import type { SkillAdapter } from './types';

function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadPage(url: string): Promise<string> {
  if (!url) throw new Error('browser requires a target url');
  if (url.startsWith('file://')) return await readFile(fileURLToPath(url), 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`browser fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

export class BrowserSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'browser',
    domain: 'web-automation',
    capabilities: ['navigate', 'extract'],
    version: '1.0.0',
  };

  canHandle(step: PlanStep): boolean {
    return step.skill === 'browser';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    if (ctx.step.kind === 'browser.navigate') {
      const url = String(ctx.step.args.url ?? '').trim();
      const html = await loadPage(url);
      const title = html.match(/<title>(.*?)<\/title>/i)?.[1] ?? null;
      ctx.state.artifacts.__currentUrl = url;
      ctx.state.artifacts[ctx.step.id] = { url, title, bytes: html.length };
      return { ok: true, output: { url, title, bytes: html.length }, retryable: false, note: 'navigation captured', trace: { url } };
    }

    if (ctx.step.kind === 'browser.extract') {
      const currentUrl = typeof ctx.state.artifacts.__currentUrl === 'string' ? String(ctx.state.artifacts.__currentUrl) : '';
      const previousNavigate = [...ctx.state.breadcrumbs].reverse().find((entry) => entry.kind === 'browser.navigate');
      const navigateStep = previousNavigate ? ctx.plan.steps.find((step) => step.id === previousNavigate.stepId) : null;
      const navigateArtifact = navigateStep ? ctx.state.artifacts[navigateStep.id] as { url?: string } | undefined : undefined;
      const url = currentUrl || (navigateArtifact?.url ? String(navigateArtifact.url) : '') || String(ctx.step.args.url ?? '').trim();
      const html = await loadPage(url);
      const text = extractVisibleText(html).slice(0, 4000);
      ctx.state.artifacts[ctx.step.id] = { url, textLength: text.length };
      return { ok: true, output: { url, text }, retryable: false, note: 'extracted readable text', trace: { url, length: text.length } };
    }

    return { ok: true, output: { objective: ctx.state.objective }, retryable: false, note: 'browser verification step' };
  }
}

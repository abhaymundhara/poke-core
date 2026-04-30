import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { SkillAdapter, SkillContext, SkillExecution } from './types';

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadUrl(url: string): Promise<string> {
  if (url.startsWith('file://')) {
    const path = fileURLToPath(url);
    return await readFile(path, 'utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`browser fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

export class BrowserSkill implements SkillAdapter {
  name = 'browser';
  private lastUrl: string | null = null;
  private lastHtml: string | null = null;

  canHandle(step: SkillContext['step']): boolean {
    return step.skill === 'browser';
  }

  async execute(ctx: SkillContext): Promise<SkillExecution> {
    if (ctx.step.kind === 'browser.navigate') {
      const url = String(ctx.step.args.url);
      const html = await loadUrl(url);
      this.lastUrl = url;
      this.lastHtml = html;
      return { output: { url, title: html.match(/<title>(.*?)<\/title>/i)?.[1] ?? null, bytes: html.length }, verified: true, note: 'navigation captured' };
    }

    if (ctx.step.kind === 'browser.extract') {
      if (!this.lastHtml || !this.lastUrl) throw new Error('no browser page loaded');
      const text = extractTextFromHtml(this.lastHtml).slice(0, 2000);
      return { output: { url: this.lastUrl, text }, verified: text.length > 0, note: 'extracted readable text' };
    }

    return { output: { objective: ctx.state.objective ?? null }, verified: true, note: 'verification passthrough' };
  }
}

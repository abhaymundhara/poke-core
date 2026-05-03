import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export type BrowserRuntimeOptions = {
  sessionRoot?: string;
  headless?: boolean;
  browserName?: BrowserName;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  slowMoMs?: number;
  launchArgs?: string[];
};

export type BrowserInteractionStep = {
  action: 'navigate' | 'click' | 'type' | 'wait' | 'scroll' | 'dom_snapshot';
  label?: string;
  url?: string;
  selector?: string;
  text?: string;
  ms?: number;
  amount?: number;
  direction?: 'up' | 'down' | 'top' | 'bottom';
  expectNavigation?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
};

export type BrowserDomSnapshot = {
  url: string;
  title: string;
  visibleText: string;
  htmlDigest: string;
  interactive: Array<{
    tag: string;
    text: string;
    ariaLabel?: string;
    name?: string;
    type?: string;
    href?: string;
    placeholder?: string;
    id?: string;
  }>;
  links: Array<{ text: string; href: string }>;
  forms: Array<{
    tag: string;
    name?: string;
    type?: string;
    placeholder?: string;
    value?: string;
    ariaLabel?: string;
    id?: string;
  }>;
  activeElement: {
    tag: string;
    text: string;
    name?: string;
    type?: string;
    placeholder?: string;
    ariaLabel?: string;
    id?: string;
  } | null;
};

export type BrowserActionResult = {
  action: BrowserInteractionStep['action'];
  beforeUrl: string;
  afterUrl: string;
  changedUrl: boolean;
  durationMs: number;
  snapshot: BrowserDomSnapshot;
  metadata: Record<string, unknown>;
};

type SessionState = {
  context: any;
  page: any;
  options: ResolvedOptions;
};

type ResolvedOptions = Required<Pick<BrowserRuntimeOptions, 'headless' | 'browserName' | 'timeoutMs' | 'slowMoMs'>> & {
  sessionRoot: string;
  viewport: { width: number; height: number };
  launchArgs: string[];
};

const DEFAULT_SESSION_ROOT = resolve(process.cwd(), '.poke-core', 'browser-sessions');
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'default';
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecoverableError(error: unknown): boolean {
  const message = stringifyError(error).toLowerCase();
  return /timeout|timed out|detached|not visible|not attached|stale|navigation|closed|target closed|execution context was destroyed|retry/.test(message);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeUrl(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new BrowserAutomationError('navigate requires a url', false);
  if (/^(about:|data:|file:|https?:)/i.test(raw)) return raw;
  try {
    return new URL(raw).toString();
  } catch {
    return 'https://' + raw.replace(/^\/+/, '');
  }
}

function mergeOptions(defaults: Partial<ResolvedOptions>, overrides?: BrowserRuntimeOptions): ResolvedOptions {
  return {
    sessionRoot: overrides?.sessionRoot ?? defaults.sessionRoot ?? DEFAULT_SESSION_ROOT,
    headless: overrides?.headless ?? defaults.headless ?? true,
    browserName: overrides?.browserName ?? defaults.browserName ?? 'chromium',
    viewport: overrides?.viewport ?? defaults.viewport ?? DEFAULT_VIEWPORT,
    timeoutMs: overrides?.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    slowMoMs: overrides?.slowMoMs ?? defaults.slowMoMs ?? 0,
    launchArgs: [...(defaults.launchArgs ?? []), ...(overrides?.launchArgs ?? [])],
  };
}

function truncate(value: string, limit = 12_000): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function snapshotFallback() {
  return {
    interactive: [] as Array<Record<string, unknown>>,
    links: [] as Array<Record<string, unknown>>,
    forms: [] as Array<Record<string, unknown>>,
    activeElement: null as null,
  };
}

export class BrowserAutomationError extends Error {
  constructor(message: string, public readonly recoverable = true, public readonly cause?: unknown) {
    super(message);
    this.name = 'BrowserAutomationError';
  }
}

export class BrowserRuntime {
  private readonly defaults: Partial<ResolvedOptions>;
  private readonly sessions = new Map<string, Promise<SessionState>>();

  constructor(options: BrowserRuntimeOptions = {}) {
    this.defaults = mergeOptions({}, options);
  }

  private async loadPlaywright(): Promise<Record<string, any>> {
    try {
      return (await import('playwright')) as unknown as Record<string, any>;
    } catch (error) {
      throw new BrowserAutomationError('Playwright is required for browser automation', false, error);
    }
  }

  private resolveSessionOptions(overrides?: BrowserRuntimeOptions): ResolvedOptions {
    return mergeOptions(this.defaults, overrides);
  }

  private sessionDir(sessionKey: string, options: ResolvedOptions): string {
    return resolve(options.sessionRoot, sanitizeSessionKey(sessionKey));
  }

  private async openSession(sessionKey: string, overrides?: BrowserRuntimeOptions): Promise<SessionState> {
    const options = this.resolveSessionOptions(overrides);
    const playwright = await this.loadPlaywright();
    const browserType = playwright[options.browserName];

    if (!browserType || typeof browserType.launchPersistentContext !== 'function') {
      throw new BrowserAutomationError('selected Playwright browser is unavailable: ' + options.browserName, false);
    }

    const userDataDir = this.sessionDir(sessionKey, options);
    mkdirSync(userDataDir, { recursive: true });

    const context = await browserType.launchPersistentContext(userDataDir, {
      headless: options.headless,
      viewport: options.viewport,
      slowMo: options.slowMoMs,
      args: options.launchArgs,
      ignoreHTTPSErrors: true,
    });

    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);
    page.setDefaultNavigationTimeout(options.timeoutMs);

    return { context, page, options };
  }

  private async ensureSession(sessionKey: string, overrides?: BrowserRuntimeOptions): Promise<SessionState> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return await existing;

    const created = this.openSession(sessionKey, overrides).catch((error) => {
      this.sessions.delete(sessionKey);
      throw error;
    });
    this.sessions.set(sessionKey, created);
    return await created;
  }

  private async withSession<T>(sessionKey: string, overrides: BrowserRuntimeOptions | undefined, fn: (session: SessionState) => Promise<T>): Promise<T> {
    const session = await this.ensureSession(sessionKey, overrides);
    try {
      return await fn(session);
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      throw new BrowserAutomationError(stringifyError(error), isRecoverableError(error), error);
    }
  }

  private async persistSessionState(sessionKey: string, session: SessionState): Promise<void> {
    try {
      const statePath = resolve(this.sessionDir(sessionKey, session.options), 'storage-state.json');
      await session.context.storageState({ path: statePath });
    } catch {
      // best-effort persistence
    }
  }

  private async retry<T>(label: string, fn: () => Promise<T>, attempts = 3, backoffMs = 250): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const recoverable = error instanceof BrowserAutomationError ? error.recoverable : isRecoverableError(error);
        if (!recoverable || attempt === attempts) {
          if (error instanceof BrowserAutomationError) throw error;
          throw new BrowserAutomationError(label + ' failed: ' + stringifyError(error), recoverable, error);
        }
        await sleep(backoffMs * attempt);
      }
    }
    throw new BrowserAutomationError(label + ' failed: ' + stringifyError(lastError), isRecoverableError(lastError), lastError);
  }

  private async collectSnapshot(session: SessionState): Promise<BrowserDomSnapshot> {
    const page = session.page;
    const [url, title, rawText, summary] = await Promise.all([
      Promise.resolve(page.url()),
      page.title().catch(() => ''),
      page.evaluate(() => document.body?.innerText ?? '').catch(() => ''),
      page.evaluate(() => {
        const clean = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
        const interactiveSelector = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="menuitem"]';
        const interactive = Array.from(document.querySelectorAll(interactiveSelector)).slice(0, 200).map((element: any) => ({
          tag: String(element.tagName ?? '').toLowerCase(),
          text: clean(element.innerText ?? element.value ?? element.getAttribute('aria-label') ?? element.getAttribute('title') ?? ''),
          ariaLabel: element.getAttribute('aria-label') || undefined,
          name: element.getAttribute('name') || undefined,
          type: element.getAttribute('type') || undefined,
          href: element.getAttribute('href') || undefined,
          placeholder: element.getAttribute('placeholder') || undefined,
          id: element.id || undefined,
        }));
        const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map((element: any) => ({
          text: clean(element.innerText ?? element.getAttribute('aria-label') ?? element.textContent ?? ''),
          href: String(element.href ?? element.getAttribute('href') ?? ''),
        }));
        const forms = Array.from(document.querySelectorAll('input,textarea,select,button')).slice(0, 100).map((element: any) => ({
          tag: String(element.tagName ?? '').toLowerCase(),
          name: element.getAttribute('name') || undefined,
          type: element.getAttribute('type') || undefined,
          placeholder: element.getAttribute('placeholder') || undefined,
          value: typeof element.value === 'string' ? element.value.slice(0, 120) : undefined,
          ariaLabel: element.getAttribute('aria-label') || undefined,
          id: element.id || undefined,
        }));
        const activeElement = document.activeElement as any;
        return {
          interactive,
          links,
          forms,
          activeElement: activeElement ? {
            tag: String(activeElement.tagName ?? '').toLowerCase(),
            text: clean(activeElement.innerText ?? activeElement.value ?? activeElement.getAttribute('aria-label') ?? activeElement.textContent ?? ''),
            name: activeElement.getAttribute('name') || undefined,
            type: activeElement.getAttribute('type') || undefined,
            placeholder: activeElement.getAttribute('placeholder') || undefined,
            ariaLabel: activeElement.getAttribute('aria-label') || undefined,
            id: activeElement.id || undefined,
          } : null,
        };
      }).catch(() => snapshotFallback()),
    ]);

    const visibleText = truncate(normalizeText(rawText), 12_000);
    const htmlDigest = sha256([url, title, visibleText].join('\n'));
    return {
      url,
      title,
      visibleText,
      htmlDigest,
      interactive: summary.interactive,
      links: summary.links,
      forms: summary.forms,
      activeElement: summary.activeElement,
    };
  }

  private async finishAction(sessionKey: string, session: SessionState, action: BrowserInteractionStep['action'], beforeUrl: string, metadata: Record<string, unknown>, startedAt: number): Promise<BrowserActionResult> {
    const snapshot = await this.collectSnapshot(session);
    await this.persistSessionState(sessionKey, session);
    return {
      action,
      beforeUrl,
      afterUrl: snapshot.url,
      changedUrl: beforeUrl !== snapshot.url,
      durationMs: Date.now() - startedAt,
      snapshot,
      metadata,
    };
  }

  async navigate(params: { sessionKey: string; url: string; overrides?: BrowserRuntimeOptions; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; retries?: number; backoffMs?: number }): Promise<BrowserActionResult> {
    const target = normalizeUrl(params.url);
    return await this.withSession(params.sessionKey, params.overrides, async (session) => {
      const beforeUrl = session.page.url();
      const startedAt = Date.now();
      await this.retry('navigate', async () => {
        await session.page.goto(target, {
          waitUntil: params.waitUntil ?? 'domcontentloaded',
          timeout: session.options.timeoutMs,
        });
      }, params.retries ?? 3, params.backoffMs ?? 250);
      return await this.finishAction(params.sessionKey, session, 'navigate', beforeUrl, { url: target, waitUntil: params.waitUntil ?? 'domcontentloaded' }, startedAt);
    });
  }

  async click(params: { sessionKey: string; selector: string; overrides?: BrowserRuntimeOptions; expectNavigation?: boolean; retries?: number; backoffMs?: number }): Promise<BrowserActionResult> {
    if (!String(params.selector ?? '').trim()) throw new BrowserAutomationError('click requires a selector', false);
    return await this.withSession(params.sessionKey, params.overrides, async (session) => {
      const beforeUrl = session.page.url();
      const startedAt = Date.now();
      await this.retry('click ' + params.selector, async () => {
        const locator = session.page.locator(params.selector).first();
        await locator.waitFor({ state: 'visible', timeout: session.options.timeoutMs });
        await locator.scrollIntoViewIfNeeded();
        if (params.expectNavigation) {
          await Promise.all([
            session.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: session.options.timeoutMs }).catch(() => undefined),
            locator.click({ timeout: session.options.timeoutMs }),
          ]);
        } else {
          await locator.click({ timeout: session.options.timeoutMs });
          await session.page.waitForTimeout(150);
        }
      }, params.retries ?? 3, params.backoffMs ?? 250);
      return await this.finishAction(params.sessionKey, session, 'click', beforeUrl, { selector: params.selector, expectNavigation: Boolean(params.expectNavigation) }, startedAt);
    });
  }

  async type(params: { sessionKey: string; selector: string; text: string; overrides?: BrowserRuntimeOptions; retries?: number; backoffMs?: number; clear?: boolean; pressEnter?: boolean }): Promise<BrowserActionResult> {
    if (!String(params.selector ?? '').trim()) throw new BrowserAutomationError('type requires a selector', false);
    return await this.withSession(params.sessionKey, params.overrides, async (session) => {
      const beforeUrl = session.page.url();
      const startedAt = Date.now();
      await this.retry('type ' + params.selector, async () => {
        const locator = session.page.locator(params.selector).first();
        await locator.waitFor({ state: 'visible', timeout: session.options.timeoutMs });
        await locator.scrollIntoViewIfNeeded();
        try {
          if (params.clear !== false) {
            await locator.fill(params.text, { timeout: session.options.timeoutMs });
          } else {
            await locator.type(params.text, { delay: 10, timeout: session.options.timeoutMs });
          }
        } catch {
          await locator.click({ timeout: session.options.timeoutMs });
          if (params.clear !== false) {
            await session.page.keyboard.press('Control+A').catch(() => undefined);
            await session.page.keyboard.press('Backspace').catch(() => undefined);
          }
          await session.page.keyboard.type(params.text, { delay: 10 });
        }
        if (params.pressEnter) await session.page.keyboard.press('Enter');
        await session.page.waitForTimeout(150);
      }, params.retries ?? 3, params.backoffMs ?? 250);
      return await this.finishAction(params.sessionKey, session, 'type', beforeUrl, { selector: params.selector, textLength: String(params.text ?? '').length, pressEnter: Boolean(params.pressEnter) }, startedAt);
    });
  }

  async wait(params: { sessionKey: string; selector?: string; ms?: number; overrides?: BrowserRuntimeOptions; state?: 'attached' | 'detached' | 'visible' | 'hidden'; retries?: number; backoffMs?: number }): Promise<BrowserActionResult> {
    return await this.withSession(params.sessionKey, params.overrides, async (session) => {
      const beforeUrl = session.page.url();
      const startedAt = Date.now();
      await this.retry('wait', async () => {
        if (String(params.selector ?? '').trim()) {
          await session.page.locator(params.selector).first().waitFor({ state: params.state ?? 'visible', timeout: session.options.timeoutMs });
        } else {
          await session.page.waitForTimeout(Math.max(0, params.ms ?? 0));
        }
      }, params.retries ?? 3, params.backoffMs ?? 250);
      return await this.finishAction(params.sessionKey, session, 'wait', beforeUrl, { selector: params.selector, ms: params.ms, state: params.state }, startedAt);
    });
  }

  async scroll(params: { sessionKey: string; selector?: string; direction?: 'up' | 'down' | 'top' | 'bottom'; amount?: number; overrides?: BrowserRuntimeOptions; retries?: number; backoffMs?: number }): Promise<BrowserActionResult> {
    return await this.withSession(params.sessionKey, params.overrides, async (session) => {
      const beforeUrl = session.page.url();
      const startedAt = Date.now();
      await this.retry('scroll', async () => {
        const selector = String(params.selector ?? '').trim();
        if (selector) {
          await session.page.locator(selector).first().scrollIntoViewIfNeeded();
          return;
        }
        const amount = Math.max(0, params.amount ?? Math.round(session.options.viewport.height * 0.8));
        await session.page.evaluate(({ direction, amount }) => {
          const distance = Math.abs(amount);
          if (direction === 'top') {
            window.scrollTo(0, 0);
            return;
          }
          if (direction === 'bottom') {
            window.scrollTo(0, document.body ? document.body.scrollHeight : document.documentElement.scrollHeight);
            return;
          }
          window.scrollBy(0, direction === 'up' ? -distance : distance);
        }, { direction: params.direction ?? 'down', amount });
      }, params.retries ?? 3, params.backoffMs ?? 250);
      return await this.finishAction(params.sessionKey, session, 'scroll', beforeUrl, { selector: params.selector, direction: params.direction ?? 'down', amount: params.amount }, startedAt);
    });
  }

  async domSnapshot(params: { sessionKey: string; overrides?: BrowserRuntimeOptions; retries?: number; backoffMs?: number }): Promise<BrowserActionResult> {
    return await this.withSession(params.sessionKey, params.overrides, async (session) => {
      const beforeUrl = session.page.url();
      const startedAt = Date.now();
      await this.retry('dom_snapshot', async () => undefined, params.retries ?? 3, params.backoffMs ?? 250);
      return await this.finishAction(params.sessionKey, session, 'dom_snapshot', beforeUrl, { snapshot: true }, startedAt);
    });
  }

  async runInteractionPlan(params: { sessionKey: string; actions: BrowserInteractionStep[]; overrides?: BrowserRuntimeOptions; retries?: number; backoffMs?: number }): Promise<{ actions: BrowserActionResult[]; finalSnapshot: BrowserDomSnapshot; navigationTrail: Array<{ from: string; to: string; reason: string }> }> {
    const session = await this.ensureSession(params.sessionKey, params.overrides);
    const results: BrowserActionResult[] = [];
    const trail: Array<{ from: string; to: string; reason: string }> = [];

    for (const step of params.actions) {
      const before = session.page.url();
      let result: BrowserActionResult;
      if (step.action === 'navigate') {
        result = await this.navigate({ sessionKey: params.sessionKey, url: String(step.url ?? ''), overrides: params.overrides, waitUntil: step.waitUntil, retries: params.retries, backoffMs: params.backoffMs });
      } else if (step.action === 'click') {
        result = await this.click({ sessionKey: params.sessionKey, selector: String(step.selector ?? ''), overrides: params.overrides, expectNavigation: step.expectNavigation, retries: params.retries, backoffMs: params.backoffMs });
      } else if (step.action === 'type') {
        result = await this.type({ sessionKey: params.sessionKey, selector: String(step.selector ?? ''), text: String(step.text ?? ''), overrides: params.overrides, retries: params.retries, backoffMs: params.backoffMs });
      } else if (step.action === 'wait') {
        result = await this.wait({ sessionKey: params.sessionKey, selector: step.selector, ms: step.ms, overrides: params.overrides, state: 'visible', retries: params.retries, backoffMs: params.backoffMs });
      } else if (step.action === 'scroll') {
        result = await this.scroll({ sessionKey: params.sessionKey, selector: step.selector, direction: step.direction, amount: step.amount, overrides: params.overrides, retries: params.retries, backoffMs: params.backoffMs });
      } else {
        result = await this.domSnapshot({ sessionKey: params.sessionKey, overrides: params.overrides, retries: params.retries, backoffMs: params.backoffMs });
      }
      results.push(result);
      if (before !== result.afterUrl) trail.push({ from: before, to: result.afterUrl, reason: step.label ?? step.action });
    }

    const finalSnapshot = results.length > 0 ? results[results.length - 1].snapshot : await this.collectSnapshot(session);
    return { actions: results, finalSnapshot, navigationTrail: trail };
  }

  async closeSession(sessionKey: string): Promise<void> {
    const existing = this.sessions.get(sessionKey);
    if (!existing) return;
    this.sessions.delete(sessionKey);
    const session = await existing.catch(() => null);
    if (!session) return;
    await session.context.close().catch(() => undefined);
  }
}

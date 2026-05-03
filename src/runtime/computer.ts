import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ComputerPoint = { x: number; y: number };
export type ComputerButton = 'left' | 'right' | 'middle';
export type ComputerPress = { keys: string[]; delayMs?: number };
export type ComputerScreenMetrics = { width: number; height: number; scaleFactor?: number; devicePixelRatio?: number };
export type ComputerViewport = { width: number; height: number };
export type ComputerScreenshot = {
  data: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  timestamp: number;
  label?: string;
  artifactPath?: string;
  hash: string;
};

export type ComputerInteractionStep =
  | { action: 'mouse_move'; x: number; y: number; durationMs?: number; label?: string }
  | { action: 'mouse_click'; x: number; y: number; button?: ComputerButton; clicks?: number; doubleClick?: boolean; label?: string }
  | { action: 'keyboard_type'; text: string; delayMs?: number; pressEnter?: boolean; label?: string }
  | { action: 'keyboard_press'; keys: string[] | string; label?: string }
  | { action: 'screenshot'; label?: string };

export type ComputerActionResult = {
  action: ComputerInteractionStep['action'];
  label?: string;
  before?: ComputerPoint;
  after?: ComputerPoint;
  screenshot?: ComputerScreenshot;
  durationMs: number;
  metadata: Record<string, unknown>;
};

export type ComputerRuntimeOptions = {
  sessionKey?: string;
  viewport?: ComputerViewport;
  screen?: ComputerScreenMetrics;
  pointerOffset?: ComputerPoint;
  scaleFactor?: number;
  screenshotRoot?: string;
  focusStrategy?: 'best-effort' | 'require-focus';
  retryCount?: number;
  backoffMs?: number;
  driver?: ComputerDriver;
  driverCommand?: string;
  driverArgs?: string[];
};

export type ComputerDriverInvocation = {
  sessionKey?: string;
  viewport?: ComputerViewport;
  screen?: ComputerScreenMetrics;
  point?: ComputerPoint;
  button?: ComputerButton;
  clicks?: number;
  delayMs?: number;
  text?: string;
  keys?: string[];
  label?: string;
};

export type ComputerDriver = {
  describe(): string;
  getScreenMetrics(): Promise<ComputerScreenMetrics>;
  ensureFocus(): Promise<void>;
  moveMouse(point: ComputerPoint, invocation: ComputerDriverInvocation): Promise<void>;
  clickMouse(point: ComputerPoint, invocation: ComputerDriverInvocation): Promise<void>;
  typeText(text: string, invocation: ComputerDriverInvocation): Promise<void>;
  pressKeys(keys: string[], invocation: ComputerDriverInvocation): Promise<void>;
  captureScreenshot(invocation: ComputerDriverInvocation): Promise<ComputerScreenshot | Buffer | string | { data: string | Buffer; mimeType?: string; width?: number; height?: number; label?: string }>;
};

export class ComputerRuntimeError extends Error {
  constructor(message: string, public readonly recoverable = true, public readonly cause?: unknown) {
    super(message);
    this.name = 'ComputerRuntimeError';
  }
}

const DEFAULT_SCREEN: ComputerScreenMetrics = { width: 1280, height: 900, scaleFactor: 1 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeKeys(keys: string[] | string): string[] {
  if (Array.isArray(keys)) return keys.map(text).filter(Boolean);
  const single = text(keys);
  return single ? single.split(/[+,\s]+/).map(text).filter(Boolean) : [];
}

function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function bufferFromScreenshot(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  const raw = text(value);
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  return Buffer.from(base64, 'base64');
}

function screenshotFromDriver(value: ComputerScreenshot | Buffer | string | { data: string | Buffer; mimeType?: string; width?: number; height?: number; label?: string } | undefined | null, fallback: { width: number; height: number; label?: string }): ComputerScreenshot {
  if (value === undefined || value === null) {
    throw new ComputerRuntimeError('screenshot driver returned no data', false);
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = bufferFromScreenshot(value);
    return {
      data: bytes.toString('base64'),
      mimeType: 'image/png',
      width: fallback.width,
      height: fallback.height,
      timestamp: Date.now(),
      label: fallback.label,
      hash: hashBytes(bytes),
    };
  }

  if ('hash' in value && typeof value.hash === 'string' && 'data' in value && typeof value.data === 'string') {
    return {
      data: value.data,
      mimeType: value.mimeType === 'image/png' ? 'image/png' : 'image/png',
      width: value.width ?? fallback.width,
      height: value.height ?? fallback.height,
      timestamp: value.timestamp ?? Date.now(),
      label: value.label ?? fallback.label,
      artifactPath: value.artifactPath,
      hash: value.hash,
    };
  }

  const bytes = bufferFromScreenshot(value.data);
  return {
    data: bytes.toString('base64'),
    mimeType: value.mimeType === 'image/png' ? 'image/png' : 'image/png',
    width: value.width ?? fallback.width,
    height: value.height ?? fallback.height,
    timestamp: Date.now(),
    label: value.label ?? fallback.label,
    hash: hashBytes(bytes),
  };
}

function sanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'default';
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableError(error: unknown): boolean {
  const message = stringifyError(error).toLowerCase();
  return /timeout|timed out|closed|not visible|not attached|stale|focus|permission|unavailable|busy|blocked|retry/.test(message);
}

function validatePoint(point: ComputerPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new ComputerRuntimeError(`${label} requires finite coordinates`, false);
  }
}

function resolveScreenMetrics(options: ComputerRuntimeOptions, fallback: ComputerScreenMetrics = DEFAULT_SCREEN): ComputerScreenMetrics {
  const screen = options.screen ?? fallback;
  const width = Math.max(1, Math.floor(screen.width || fallback.width));
  const height = Math.max(1, Math.floor(screen.height || fallback.height));
  const rawScaleFactor = options.scaleFactor ?? screen.scaleFactor ?? 1;
  const scaleFactor = Number.isFinite(rawScaleFactor) && rawScaleFactor > 0 ? rawScaleFactor : 1;
  const rawDevicePixelRatio = screen.devicePixelRatio ?? 1;
  const devicePixelRatio = Number.isFinite(rawDevicePixelRatio) && rawDevicePixelRatio > 0 ? rawDevicePixelRatio : 1;
  return { width, height, scaleFactor, devicePixelRatio };
}

function mapPoint(point: ComputerPoint, options: ComputerRuntimeOptions, metrics: ComputerScreenMetrics): ComputerPoint {
  validatePoint(point, 'mouse action');
  const viewport = options.viewport ?? { width: metrics.width, height: metrics.height };
  if (!(viewport.width > 0 && viewport.height > 0)) throw new ComputerRuntimeError('viewport dimensions must be positive', false);

  const explicitScale = typeof options.scaleFactor === 'number' && Number.isFinite(options.scaleFactor) && options.scaleFactor > 0 ? options.scaleFactor : undefined;
  const scaleX = explicitScale ?? (typeof metrics.scaleFactor === 'number' && metrics.scaleFactor > 0 ? metrics.scaleFactor : metrics.width / viewport.width);
  const scaleY = explicitScale ?? (typeof metrics.scaleFactor === 'number' && metrics.scaleFactor > 0 ? metrics.scaleFactor : metrics.height / viewport.height);
  const offsetX = options.pointerOffset?.x ?? 0;
  const offsetY = options.pointerOffset?.y ?? 0;
  const x = Math.round(point.x * scaleX + offsetX);
  const y = Math.round(point.y * scaleY + offsetY);

  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ComputerRuntimeError('computed screen coordinates are not finite', false);
  const clampedX = clamp(x, 0, metrics.width - 1);
  const clampedY = clamp(y, 0, metrics.height - 1);
  if (Math.abs(clampedX - x) > 2 || Math.abs(clampedY - y) > 2) {
    throw new ComputerRuntimeError(`mapped coordinates (${x}, ${y}) fall outside the screen bounds ${metrics.width}x${metrics.height}`, false);
  }
  return { x: clampedX, y: clampedY };
}

class BridgeCommandComputerDriver implements ComputerDriver {
  constructor(private readonly command: string, private readonly args: string[] = []) {}

  describe(): string {
    return `bridge:${this.command}`;
  }

  async getScreenMetrics(): Promise<ComputerScreenMetrics> {
    const result = await this.invoke('screen_metrics', {});
    if (isObject(result) && number(result.width) && number(result.height)) {
      return {
        width: number(result.width) ?? DEFAULT_SCREEN.width,
        height: number(result.height) ?? DEFAULT_SCREEN.height,
        scaleFactor: number(result.scaleFactor) ?? 1,
        devicePixelRatio: number(result.devicePixelRatio) ?? 1,
      };
    }
    return DEFAULT_SCREEN;
  }

  async ensureFocus(): Promise<void> {
    await this.invoke('focus', {});
  }

  async moveMouse(point: ComputerPoint, invocation: ComputerDriverInvocation): Promise<void> {
    await this.invoke('mouse_move', { ...invocation, point });
  }

  async clickMouse(point: ComputerPoint, invocation: ComputerDriverInvocation): Promise<void> {
    await this.invoke('mouse_click', { ...invocation, point });
  }

  async typeText(text: string, invocation: ComputerDriverInvocation): Promise<void> {
    await this.invoke('keyboard_type', { ...invocation, text });
  }

  async pressKeys(keys: string[], invocation: ComputerDriverInvocation): Promise<void> {
    await this.invoke('keyboard_press', { ...invocation, keys });
  }

  async captureScreenshot(invocation: ComputerDriverInvocation): Promise<ComputerScreenshot | Buffer | string | { data: string | Buffer; mimeType?: string; width?: number; height?: number; label?: string }> {
    return await this.invoke('screenshot', invocation);
  }

  private async invoke(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const { stdout, stderr } = await execFileAsync(this.command, [...this.args, action, JSON.stringify(payload)], { maxBuffer: 10 * 1024 * 1024 });
    const output = text(stdout) ? parseJsonMaybe(stdout) ?? stdout : undefined;
    if (stderr && text(stderr)) {
      const maybe = text(stderr);
      if (!output) throw new ComputerRuntimeError(`${this.describe()} failed: ${maybe}`, isRecoverableError(maybe));
    }
    return output;
  }
}

export function createBridgeComputerDriver(command: string, args: string[] = []): ComputerDriver {
  if (!text(command)) throw new ComputerRuntimeError('bridge command is required', false);
  return new BridgeCommandComputerDriver(command, args);
}

export async function createDefaultComputerDriver(options: Pick<ComputerRuntimeOptions, 'driver' | 'driverCommand' | 'driverArgs'> = {}): Promise<ComputerDriver> {
  if (options.driver) return options.driver;
  const command = text(options.driverCommand ?? process.env.POKE_COMPUTER_BRIDGE_COMMAND);
  if (command) return createBridgeComputerDriver(command, options.driverArgs ?? process.env.POKE_COMPUTER_BRIDGE_ARGS?.split(/\s+/).filter(Boolean) ?? []);

  const bridgeUrl = text(process.env.POKE_COMPUTER_BRIDGE_URL);
  if (bridgeUrl) {
    return {
      describe: () => `bridge-url:${bridgeUrl}`,
      async getScreenMetrics() {
        const response = await fetch(new URL('/screen-metrics', bridgeUrl), { method: 'GET' });
        if (!response.ok) throw new ComputerRuntimeError(`bridge metrics request failed with status ${response.status}`, response.status >= 500);
        const json = await response.json();
        return {
          width: Number(json.width) || DEFAULT_SCREEN.width,
          height: Number(json.height) || DEFAULT_SCREEN.height,
          scaleFactor: Number(json.scaleFactor) || 1,
          devicePixelRatio: Number(json.devicePixelRatio) || 1,
        };
      },
      async ensureFocus() {
        const response = await fetch(new URL('/focus', bridgeUrl), { method: 'POST' });
        if (!response.ok) throw new ComputerRuntimeError(`bridge focus request failed with status ${response.status}`, response.status >= 500);
      },
      async moveMouse(point, invocation) {
        await bridgePost(bridgeUrl, 'mouse_move', { ...invocation, point });
      },
      async clickMouse(point, invocation) {
        await bridgePost(bridgeUrl, 'mouse_click', { ...invocation, point });
      },
      async typeText(textValue, invocation) {
        await bridgePost(bridgeUrl, 'keyboard_type', { ...invocation, text: textValue });
      },
      async pressKeys(keys, invocation) {
        await bridgePost(bridgeUrl, 'keyboard_press', { ...invocation, keys });
      },
      async captureScreenshot(invocation) {
        const response = await bridgePost(bridgeUrl, 'screenshot', invocation, true);
        return response;
      },
    };
  }

  throw new ComputerRuntimeError('no computer driver configured; set POKE_COMPUTER_BRIDGE_COMMAND or provide a driver', false);
}

async function bridgePost(bridgeUrl: string, action: string, payload: Record<string, unknown>, expectJson = false): Promise<unknown> {
  const response = await fetch(new URL(`/actions/${action}`, bridgeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new ComputerRuntimeError(`bridge ${action} request failed with status ${response.status}`, response.status >= 500);
  if (!expectJson) return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return await response.json();
  return await response.text();
}

export class ComputerRuntime {
  private readonly options: ComputerRuntimeOptions;
  private readonly driverPromise: Promise<ComputerDriver>;
  private lastMetrics: ComputerScreenMetrics | null = null;
  private lastPointer: ComputerPoint | null = null;
  private lastFocusAt = 0;

  constructor(options: ComputerRuntimeOptions = {}) {
    this.options = { focusStrategy: 'best-effort', retryCount: 3, backoffMs: 150, ...options };
    this.driverPromise = Promise.resolve(this.options.driver ?? createDefaultComputerDriver(this.options));
  }

  private async driver(): Promise<ComputerDriver> {
    return await this.driverPromise;
  }

  private async metrics(): Promise<ComputerScreenMetrics> {
    if (this.lastMetrics) return this.lastMetrics;
    const driver = await this.driver();
    const reported = await driver.getScreenMetrics().catch(() => undefined);
    this.lastMetrics = resolveScreenMetrics(this.options, reported ?? DEFAULT_SCREEN);
    return this.lastMetrics;
  }

  private async retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const attempts = Math.max(1, this.options.retryCount ?? 3);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const recoverable = error instanceof ComputerRuntimeError ? error.recoverable : isRecoverableError(error);
        if (!recoverable || attempt === attempts) {
          if (error instanceof ComputerRuntimeError) throw error;
          throw new ComputerRuntimeError(`${label} failed: ${stringifyError(error)}`, recoverable, error);
        }
        await sleep((this.options.backoffMs ?? 150) * attempt);
      }
    }
    throw new ComputerRuntimeError(`${label} failed: ${stringifyError(lastError)}`, isRecoverableError(lastError), lastError);
  }

  private async ensureFocus(action: string): Promise<void> {
    const driver = await this.driver();
    if (driver.ensureFocus) {
      await this.retry(`${action}:focus`, async () => await driver.ensureFocus());
      this.lastFocusAt = Date.now();
      return;
    }

    if (this.options.focusStrategy === 'require-focus') {
      throw new ComputerRuntimeError(`${action} requires an active application focus, but the configured driver does not expose focus control`, false);
    }

    if (this.lastPointer) {
      const metrics = await this.metrics();
      await this.retry(`${action}:focus-click`, async () => {
        const screenPoint = mapPoint(this.lastPointer!, this.options, metrics);
        await driver.clickMouse(screenPoint, { ...this.baseInvocation(), point: screenPoint, label: 'implicit-focus' });
      });
      this.lastFocusAt = Date.now();
    }
  }

  private baseInvocation(sessionKey?: string): ComputerDriverInvocation {
    return { sessionKey: sessionKey ?? this.options.sessionKey, viewport: this.options.viewport, screen: this.lastMetrics ?? this.options.screen, label: undefined };
  }

  private async persistScreenshot(screenshot: ComputerScreenshot): Promise<ComputerScreenshot> {
    const root = text(this.options.screenshotRoot ?? resolve(process.cwd(), '.poke-core', 'computer-screenshots'));
    if (!root) return screenshot;
    const dir = resolve(root, sanitizeSessionKey(this.options.sessionKey ?? 'default'));
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, `${screenshot.timestamp}-${screenshot.hash.slice(0, 12)}.png`);
    writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
    return { ...screenshot, artifactPath: filePath };
  }

  async moveMouse(point: ComputerPoint, label?: string): Promise<ComputerActionResult> {
    const startedAt = Date.now();
    const metrics = await this.metrics();
    const driver = await this.driver();
    const screenPoint = mapPoint(point, this.options, metrics);
    await this.retry('mouse_move', async () => {
      await driver.moveMouse(screenPoint, { ...this.baseInvocation(), point: screenPoint, label });
    });
    this.lastPointer = point;
    return { action: 'mouse_move', label, before: point, after: screenPoint, durationMs: Date.now() - startedAt, metadata: { screenPoint, metrics } };
  }

  async clickMouse(point: ComputerPoint, input: { button?: ComputerButton; clicks?: number; doubleClick?: boolean; label?: string } = {}): Promise<ComputerActionResult> {
    const startedAt = Date.now();
    const metrics = await this.metrics();
    const driver = await this.driver();
    const screenPoint = mapPoint(point, this.options, metrics);
    await this.retry('mouse_click', async () => {
      await driver.clickMouse(screenPoint, { ...this.baseInvocation(), point: screenPoint, button: input.button ?? 'left', clicks: input.doubleClick ? 2 : (input.clicks ?? 1), label: input.label });
    });
    this.lastPointer = point;
    this.lastFocusAt = Date.now();
    return { action: 'mouse_click', label: input.label, before: point, after: screenPoint, durationMs: Date.now() - startedAt, metadata: { screenPoint, button: input.button ?? 'left', clicks: input.doubleClick ? 2 : (input.clicks ?? 1), metrics } };
  }

  async typeText(textValue: string, input: { delayMs?: number; pressEnter?: boolean; label?: string } = {}): Promise<ComputerActionResult> {
    const startedAt = Date.now();
    const driver = await this.driver();
    await this.ensureFocus('keyboard_type');
    await this.retry('keyboard_type', async () => {
      await driver.typeText(textValue, { ...this.baseInvocation(), text: textValue, delayMs: input.delayMs, label: input.label });
      if (input.pressEnter) {
        await driver.pressKeys(['Enter'], { ...this.baseInvocation(), keys: ['Enter'], label: `${input.label ?? 'keyboard_type'}:enter` });
      }
    });
    return { action: 'keyboard_type', label: input.label, durationMs: Date.now() - startedAt, metadata: { textLength: textValue.length, delayMs: input.delayMs ?? 0, pressEnter: Boolean(input.pressEnter) } };
  }

  async pressKeys(keys: string[] | string, input: { label?: string } = {}): Promise<ComputerActionResult> {
    const startedAt = Date.now();
    const normalizedKeys = normalizeKeys(keys);
    if (normalizedKeys.length === 0) throw new ComputerRuntimeError('keyboard_press requires at least one key', false);
    const driver = await this.driver();
    await this.ensureFocus('keyboard_press');
    await this.retry('keyboard_press', async () => {
      await driver.pressKeys(normalizedKeys, { ...this.baseInvocation(), keys: normalizedKeys, label: input.label });
    });
    return { action: 'keyboard_press', label: input.label, durationMs: Date.now() - startedAt, metadata: { keys: normalizedKeys } };
  }

  async captureScreenshot(input: { label?: string } = {}): Promise<ComputerActionResult> {
    const startedAt = Date.now();
    const metrics = await this.metrics();
    const driver = await this.driver();
    const raw = await this.retry('screenshot', async () => await driver.captureScreenshot({ ...this.baseInvocation(), label: input.label }));
    const screenshot = await this.persistScreenshot(screenshotFromDriver(raw as any, { width: metrics.width, height: metrics.height, label: input.label }));
    return { action: 'screenshot', label: input.label, screenshot, durationMs: Date.now() - startedAt, metadata: { artifactPath: screenshot.artifactPath, hash: screenshot.hash, width: screenshot.width, height: screenshot.height } };
  }

  async runInteractionPlan(actions: ComputerInteractionStep[]): Promise<{ actions: ComputerActionResult[]; screenshots: ComputerScreenshot[]; finalScreenshot: ComputerScreenshot | null; metrics: ComputerScreenMetrics; driver: string }> {
    const driver = await this.driver();
    const results: ComputerActionResult[] = [];
    const screenshots: ComputerScreenshot[] = [];
    for (const step of actions) {
      if (step.action === 'mouse_move') {
        results.push(await this.moveMouse({ x: step.x, y: step.y }, step.label));
      } else if (step.action === 'mouse_click') {
        results.push(await this.clickMouse({ x: step.x, y: step.y }, { button: step.button, clicks: step.clicks, doubleClick: step.doubleClick, label: step.label }));
      } else if (step.action === 'keyboard_type') {
        results.push(await this.typeText(step.text, { delayMs: step.delayMs, pressEnter: step.pressEnter, label: step.label }));
      } else if (step.action === 'keyboard_press') {
        results.push(await this.pressKeys(step.keys, { label: step.label }));
      } else if (step.action === 'screenshot') {
        const result = await this.captureScreenshot({ label: step.label });
        results.push(result);
        if (result.screenshot) screenshots.push(result.screenshot);
      }
    }

    const metrics = await this.metrics();
    const finalScreenshot = screenshots.at(-1) ?? null;
    return { actions: results, screenshots, finalScreenshot, metrics, driver: driver.describe() };
  }
}

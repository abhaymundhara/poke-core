import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { SkillAdapter } from './types';

export type VisionFrame = {
  id: string;
  screenshot?: string;
  ocr?: string;
  dom?: string;
  selectors?: Iterable<string>;
  activeTabId?: string;
  activeWindowId?: string;
  viewport?: { width: number; height: number };
};

export type UiPerception = {
  frameId: string;
  visibleText: string;
  detectedSelector: string | null;
  activeTabId: string;
  activeWindowId: string;
  driftDetected: boolean;
  focusedSelector: string | null;
  keyboardHint: string | null;
  tabCount: number;
  windowCount: number;
};

export type ComputerUseState = {
  activeWindowId: string;
  activeTabId: string;
  focusedSelector: string | null;
  driftRecoveries: number;
  frameCount: number;
  lastAction: string | null;
  windowCount: number;
  tabCount: number;
};

export type ComputerUseRunResult = {
  state: ComputerUseState;
  perceptionCount: number;
  driftRecoveries: number;
  finalSelector: string | null;
  lastAction: string | null;
  lastPerception: UiPerception | null;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalSelector(selector: string): string {
  return selector.trim().toLowerCase().replace(/\s+/g, ' ').replace(/#([a-z0-9_-]+)/gi, '#$1').replace(/\.([a-z0-9_-]+)/gi, '.$1');
}

function visibleText(frame: VisionFrame): string {
  const screenshot = text(frame.screenshot);
  const ocr = text(frame.ocr);
  const dom = text(frame.dom);
  let result = '';
  if (ocr) result = ocr;
  if (dom) result = result ? `${result} ${dom}` : dom;
  if (screenshot) result = result ? `${result} ${screenshot}` : screenshot;
  return result.replace(/\s+/g, ' ').trim();
}

function firstSelector(selectors: Iterable<string> | undefined): string | null {
  if (!selectors) return null;
  for (const selector of selectors) {
    const normalized = canonicalSelector(text(selector));
    if (normalized) return normalized;
  }
  return null;
}

function selectorKey(selector: string | null): string {
  return selector ? selector.replace(/[#.\[\]()>:+~*,]/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function hintFromFrame(frame: VisionFrame): string | null {
  const source = `${visibleText(frame)} ${firstSelector(frame.selectors) ?? ''}`.toLowerCase();
  if (/button/.test(source)) return 'button';
  if (/input/.test(source)) return 'input';
  if (/textarea/.test(source)) return 'textarea';
  if (/dialog/.test(source)) return 'dialog';
  if (/menu/.test(source)) return 'menu';
  if (/tab/.test(source)) return 'tab';
  return null;
}

function determineFocusedSelector(state: ComputerUseState, frame: VisionFrame, detectedSelector: string | null): string | null {
  if (!detectedSelector) return state.focusedSelector;
  if (!state.focusedSelector) return detectedSelector;
  if (state.focusedSelector === detectedSelector) return state.focusedSelector;
  const haystack = `${visibleText(frame)} ${detectedSelector}`.toLowerCase();
  const currentKey = selectorKey(state.focusedSelector);
  if (currentKey && haystack.includes(currentKey)) return state.focusedSelector;
  return detectedSelector;
}

function ensureState(frame: VisionFrame, state: ComputerUseState): void {
  if (!state.activeWindowId) state.activeWindowId = frame.activeWindowId ?? 'window-1';
  if (!state.activeTabId) state.activeTabId = frame.activeTabId ?? 'tab-1';
  if (!state.windowCount) state.windowCount = 1;
  if (!state.tabCount) state.tabCount = 1;
}

export function captureFrame(frame: VisionFrame, state: ComputerUseState): UiPerception {
  ensureState(frame, state);
  const detectedSelector = firstSelector(frame.selectors);
  const focusedSelector = determineFocusedSelector(state, frame, detectedSelector);
  const driftDetected = state.focusedSelector !== null && focusedSelector !== state.focusedSelector;
  const perception: UiPerception = {
    frameId: frame.id,
    visibleText: visibleText(frame).slice(0, 4_000),
    detectedSelector,
    activeTabId: frame.activeTabId ?? state.activeTabId,
    activeWindowId: frame.activeWindowId ?? state.activeWindowId,
    driftDetected,
    focusedSelector,
    keyboardHint: hintFromFrame(frame),
    tabCount: state.tabCount,
    windowCount: state.windowCount,
  };
  state.activeWindowId = perception.activeWindowId;
  state.activeTabId = perception.activeTabId;
  state.focusedSelector = focusedSelector;
  state.frameCount += 1;
  return perception;
}

function applyKey(state: ComputerUseState, key: string): string {
  const normalized = text(key).toLowerCase();
  if (!normalized) return '';
  state.lastAction = normalized;
  if (normalized === 'ctrl+l') return 'focus-address-bar';
  if (normalized === 'ctrl+tab') return 'advance-tab';
  if (normalized === 'ctrl+shift+tab') return 'reverse-tab';
  if (normalized === 'alt+left') return 'navigate-back';
  if (normalized === 'tab') return 'tab';
  if (normalized === 'enter') return 'enter';
  return normalized;
}

export function recoverFromUiDrift(
  state: ComputerUseState,
  perception: UiPerception,
  fallbackSelectors: Iterable<string> | undefined = undefined,
): { recovered: boolean; selector: string | null; reason: string } {
  if (!perception.driftDetected && perception.focusedSelector) {
    return { recovered: false, selector: perception.focusedSelector, reason: 'no drift' };
  }
  let candidate: string | null = null;
  if (fallbackSelectors) {
    for (const fallback of fallbackSelectors) {
      candidate = canonicalSelector(text(fallback));
      if (candidate) break;
    }
  }
  if (!candidate && perception.detectedSelector) candidate = perception.detectedSelector;
  if (!candidate && state.focusedSelector) candidate = state.focusedSelector;
  if (candidate) {
    state.focusedSelector = candidate;
    state.driftRecoveries += 1;
    state.lastAction = `recover:${candidate}`;
    return { recovered: true, selector: candidate, reason: 'selector fallback after drift' };
  }
  return { recovered: false, selector: null, reason: 'no recoverable selector' };
}

type IterableSource<T> = Iterable<T> | (() => Iterable<T>);

function* asIterable<T>(value: Iterable<T> | (() => Iterable<T>) | undefined): IterableIterator<T> {
  if (!value) return;
  const source = typeof value === 'function' ? value() : value;
  for (const item of source) yield item;
}

function* singleFrame(frame: VisionFrame): IterableIterator<VisionFrame> {
  yield frame;
}

function seedState(frame: VisionFrame): ComputerUseState {
  return {
    activeWindowId: frame.activeWindowId ?? 'window-1',
    activeTabId: frame.activeTabId ?? 'tab-1',
    focusedSelector: firstSelector(frame.selectors),
    driftRecoveries: 0,
    frameCount: 0,
    lastAction: null,
    windowCount: 1,
    tabCount: 1,
  };
}

export function runVisionLoop(
  frames: IterableSource<VisionFrame>,
  instructions: { keys?: IterableSource<string>; fallbackSelectors?: IterableSource<string> } = {},
): ComputerUseRunResult {
  let state: ComputerUseState | null = null;
  let perceptionCount = 0;
  let lastPerception: UiPerception | null = null;
  let lastAction: string | null = null;

  const frameSource = typeof frames === "function" ? frames() : frames;
  for (const frame of frameSource) {
    if (!state) state = seedState(frame);
    const perception = captureFrame(frame, state);
    lastPerception = perception;
    perceptionCount += 1;
    if (perception.driftDetected) {
      const recovery = recoverFromUiDrift(state, perception, instructions.fallbackSelectors ? asIterable(instructions.fallbackSelectors) : undefined);
      if (recovery.recovered) lastAction = state.lastAction;
    }
    if (instructions.keys) {
      for (const key of asIterable(instructions.keys)) lastAction = applyKey(state, key) || lastAction;
    }
    if (state.lastAction) lastAction = state.lastAction;
  }

  const finalState = state ?? seedState({ id: 'frame-0' });
  return {
    state: finalState,
    perceptionCount,
    driftRecoveries: finalState.driftRecoveries,
    finalSelector: finalState.focusedSelector,
    lastAction,
    lastPerception,
  };
}

export class ComputerUseSkill implements SkillAdapter {
  descriptor: SkillDescriptor = { name: 'computer-use', domain: 'ui-automation', capabilities: ['vision', 'selectors', 'drift-recovery'], version: '2.0.0' };

  canHandle(step: PlanStep): boolean {
    return step.kind === 'computer-use.vision' || step.skill === 'computer-use';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const frameFromArgs: VisionFrame = {
      id: `${ctx.step.id}-frame`,
      ocr: text(ctx.step.args.ocr),
      dom: text(ctx.step.args.dom),
      screenshot: text(ctx.step.args.screenshot),
      selectors: Array.isArray(ctx.step.args.selectors) ? (ctx.step.args.selectors as Iterable<string>) : undefined,
      activeTabId: text(ctx.step.args.activeTabId) || undefined,
      activeWindowId: text(ctx.step.args.activeWindowId) || undefined,
      viewport: typeof ctx.step.args.viewport === 'object' && ctx.step.args.viewport !== null ? (ctx.step.args.viewport as { width: number; height: number }) : undefined,
    };
    const frameInput = Array.isArray(ctx.step.args.frames) ? (ctx.step.args.frames as Iterable<VisionFrame>) : singleFrame(frameFromArgs);
    function* defaultKeys() { yield 'tab'; yield 'enter'; }
    const result = runVisionLoop(frameInput, {
      keys: Array.isArray(ctx.step.args.keys) ? (ctx.step.args.keys as Iterable<string>) : defaultKeys,
      fallbackSelectors: Array.isArray(ctx.step.args.fallbackSelectors) ? (ctx.step.args.fallbackSelectors as Iterable<string>) : undefined,
    });
    ctx.state.artifacts[ctx.step.id] = result.state;
    return {
      ok: true,
      output: {
        uiState: result.state,
        perceptionCount: result.perceptionCount,
        driftRecoveries: result.driftRecoveries,
        finalSelector: result.finalSelector,
        lastAction: result.lastAction,
        lastPerception: result.lastPerception,
      },
      retryable: false,
      note: 'latent vision loop completed',
      trace: { captures: result.perceptionCount, driftRecoveries: result.driftRecoveries },
    };
  }
}

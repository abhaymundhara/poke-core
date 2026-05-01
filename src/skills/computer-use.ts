import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { SkillAdapter } from './types';

export type UiWindowState = { id: string; title: string; focused: boolean; width: number; height: number };
export type UiTabState = { id: string; title: string; url: string; active: boolean; history: string[]; selectors: string[] };
export type VisionFrame = { id: string; screenshot?: string; ocr?: string; dom?: string; selectors?: string[]; activeTabId?: string; activeWindowId?: string; viewport?: { width: number; height: number } };
export type UiPerception = { frameId: string; visibleText: string; detectedSelectors: string[]; activeTabId: string; activeWindowId: string; driftDetected: boolean; focusedSelector: string | null; keyboardHints: string[]; tabCount: number; windowCount: number };
export type ComputerUseSession = { windows: UiWindowState[]; tabs: UiTabState[]; focus: { windowId: string; tabId: string; selector: string | null }; cursorHistory: string[]; driftRecoveries: number; captures: UiPerception[] };

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function canonicalSelector(selector: string): string { return selector.trim().toLowerCase().replace(/\s+/g, ' ').replace(/#([a-z0-9_-]+)/gi, '#$1').replace(/\.([a-z0-9_-]+)/gi, '.$1'); }
function normalizeSelectors(selectors: unknown): string[] { return Array.isArray(selectors) ? [...new Set(selectors.map(text).filter(Boolean).map(canonicalSelector))] : []; }
function makeSession(frame: VisionFrame): ComputerUseSession {
  const windowId = frame.activeWindowId ?? 'window-1';
  const tabId = frame.activeTabId ?? 'tab-1';
  return { windows: [{ id: windowId, title: 'Primary window', focused: true, width: frame.viewport?.width ?? 1280, height: frame.viewport?.height ?? 800 }], tabs: [{ id: tabId, title: 'Primary tab', url: 'about:blank', active: true, history: ['about:blank'], selectors: normalizeSelectors(frame.selectors) }], focus: { windowId, tabId, selector: null }, cursorHistory: [], driftRecoveries: 0, captures: [] };
}
function visibleText(frame: VisionFrame): string { return [frame.ocr, frame.dom, frame.screenshot].map(text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); }
function detectSelectors(frame: VisionFrame): string[] {
  const haystack = visibleText(frame).toLowerCase();
  const selectors = normalizeSelectors(frame.selectors);
  const fromText = [...haystack.matchAll(/(?:button|input|textarea|a|select|dialog|menu|tab|window|sheet|pane|modal|tooltip)(?:\[[^\]]+\])?/g)].map((match) => canonicalSelector(match[0]));
  return [...new Set([...selectors, ...fromText])];
}
function detectFocusedSelector(session: ComputerUseSession, frame: VisionFrame, selectors: string[]): string | null {
  const haystack = visibleText(frame).toLowerCase();
  const target = session.focus.selector ? canonicalSelector(session.focus.selector) : null;
  if (target && selectors.includes(target)) return target;
  if (target && haystack.includes(target.replace(/[#.\[\]]/g, ''))) return target;
  const strongest = selectors.find((selector) => /button|input|textarea|tab|dialog|modal|menu/.test(selector)) ?? null;
  return strongest;
}
function ensureFocus(session: ComputerUseSession, windowId: string, tabId: string, selector: string | null) { session.focus = { windowId, tabId, selector }; if (selector) session.cursorHistory.push(selector); }

export function captureFrame(frame: VisionFrame, session: ComputerUseSession): UiPerception {
  const selectors = detectSelectors(frame);
  const activeWindowId = frame.activeWindowId ?? session.focus.windowId;
  const activeTabId = frame.activeTabId ?? session.focus.tabId;
  const focusedSelector = detectFocusedSelector(session, frame, selectors);
  const driftDetected = session.focus.selector !== null && focusedSelector !== session.focus.selector;
  const perception: UiPerception = { frameId: frame.id, visibleText: visibleText(frame).slice(0, 4000), detectedSelectors: selectors, activeTabId, activeWindowId, driftDetected, focusedSelector, keyboardHints: selectors.filter((selector) => /button|input|textarea|tab|dialog|menu/.test(selector)).slice(0, 6), tabCount: session.tabs.length, windowCount: session.windows.length };
  session.captures.push(perception);
  const tab = session.tabs.find((entry) => entry.id === activeTabId) ?? session.tabs[0];
  if (tab) tab.selectors = selectors;
  session.focus.windowId = activeWindowId;
  session.focus.tabId = activeTabId;
  session.focus.selector = focusedSelector;
  return perception;
}

export function keyboardNavigate(session: ComputerUseSession, key: string): string {
  const normalized = key.trim().toLowerCase();
  session.cursorHistory.push(normalized);
  if (normalized === 'ctrl+l') return 'address-bar';
  if (normalized === 'ctrl+tab') {
    const index = session.tabs.findIndex((tab) => tab.id === session.focus.tabId);
    const next = session.tabs[(index + 1) % session.tabs.length];
    if (next) ensureFocus(session, session.focus.windowId, next.id, next.selectors[0] ?? null);
    return `tab:${session.focus.tabId}`;
  }
  if (normalized === 'ctrl+shift+tab') {
    const index = session.tabs.findIndex((tab) => tab.id === session.focus.tabId);
    const next = session.tabs[(index - 1 + session.tabs.length) % session.tabs.length];
    if (next) ensureFocus(session, session.focus.windowId, next.id, next.selectors[0] ?? null);
    return `tab:${session.focus.tabId}`;
  }
  if (normalized === 'alt+left') {
    const tab = session.tabs.find((entry) => entry.id === session.focus.tabId);
    const prev = tab?.history.at(-2) ?? tab?.history[0] ?? 'about:blank';
    if (tab) tab.url = prev;
    return prev;
  }
  if (normalized === 'tab') {
    const tab = session.tabs.find((entry) => entry.id === session.focus.tabId);
    const selectors = tab?.selectors ?? [];
    const nextSelector = selectors.find((selector) => selector !== session.focus.selector) ?? selectors[0] ?? null;
    ensureFocus(session, session.focus.windowId, session.focus.tabId, nextSelector);
    return nextSelector ?? 'tab-cycle';
  }
  if (normalized === 'enter') {
    const tab = session.tabs.find((entry) => entry.id === session.focus.tabId);
    if (tab && session.focus.selector) tab.history.push(`${tab.url}#${session.focus.selector}`);
    return 'enter';
  }
  return normalized;
}

export function recoverFromUiDrift(session: ComputerUseSession, perception: UiPerception, fallbackSelectors: string[] = []): { recovered: boolean; selector: string | null; reason: string } {
  if (!perception.driftDetected && perception.focusedSelector) return { recovered: false, selector: perception.focusedSelector, reason: 'no drift' };
  const candidate = [...fallbackSelectors, ...perception.detectedSelectors, 'body', 'main', 'button', 'input'].map(canonicalSelector).find(Boolean) ?? null;
  if (candidate) {
    session.driftRecoveries += 1;
    ensureFocus(session, perception.activeWindowId, perception.activeTabId, candidate);
    return { recovered: true, selector: candidate, reason: 'selector fallback after drift' };
  }
  return { recovered: false, selector: null, reason: 'no recoverable selector' };
}

export function runVisionLoop(frames: VisionFrame[], instructions: { keys?: string[]; fallbackSelectors?: string[] } = {}): { session: ComputerUseSession; perceptions: UiPerception[]; actions: string[]; driftRecoveries: number } {
  const session = makeSession(frames[0] ?? { id: 'frame-0' });
  const perceptions: UiPerception[] = [];
  const actions: string[] = [];
  for (const frame of frames) {
    const perception = captureFrame(frame, session);
    perceptions.push(perception);
    if (perception.driftDetected) {
      const recovery = recoverFromUiDrift(session, perception, instructions.fallbackSelectors ?? []);
      actions.push(`recover:${recovery.recovered}:${recovery.selector ?? 'none'}`);
    }
    for (const key of instructions.keys ?? []) actions.push(keyboardNavigate(session, key));
  }
  return { session, perceptions, actions, driftRecoveries: session.driftRecoveries };
}

export class ComputerUseSkill implements SkillAdapter {
  descriptor: SkillDescriptor = { name: 'computer-use', domain: 'ui-automation', capabilities: ['vision', 'ocr', 'selectors', 'keyboard-navigation', 'window-management', 'drift-recovery'], version: '1.0.0' };
  canHandle(step: PlanStep): boolean { return step.kind === 'computer-use.vision' || step.skill === 'computer-use'; }
  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const frames = Array.isArray(ctx.step.args.frames) ? (ctx.step.args.frames as VisionFrame[]) : [{ id: `${ctx.step.id}-frame`, ocr: text(ctx.step.args.ocr), dom: text(ctx.step.args.dom), screenshot: text(ctx.step.args.screenshot), selectors: Array.isArray(ctx.step.args.selectors) ? (ctx.step.args.selectors as string[]) : [] }];
    const keys = Array.isArray(ctx.step.args.keys) ? (ctx.step.args.keys as string[]) : ['tab', 'enter'];
    const result = runVisionLoop(frames, { keys, fallbackSelectors: Array.isArray(ctx.step.args.fallbackSelectors) ? (ctx.step.args.fallbackSelectors as string[]) : [] });
    ctx.state.artifacts[ctx.step.id] = result.session;
    return { ok: true, output: { uiState: result.session, perceptions: result.perceptions, actions: result.actions, driftRecoveries: result.driftRecoveries }, retryable: false, note: 'vision loop completed', trace: { captures: result.perceptions.length, driftRecoveries: result.driftRecoveries } };
  }
}

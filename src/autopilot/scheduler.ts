import { mergeWake, type AutopilotWake } from './events';

export type SchedulerSnapshot = {
  pendingCount: number;
  nextWakeAt: number | null;
  queuedKeys: string[];
  modes: Array<'debounce' | 'throttle' | 'immediate'>;
  lastFlushedAt: number | null;
};

export type SchedulerWakeRequest = AutopilotWake & {
  onWake?: (wake: AutopilotWake) => void;
};

export class AutopilotSchedulerWorker {
  private queue = new Map<string, SchedulerWakeRequest>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushedAt: number | null = null;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  schedule(request: SchedulerWakeRequest): SchedulerSnapshot {
    const existing = this.queue.get(request.key);
    const merged = existing ? { ...mergeWake(existing, request), onWake: request.onWake ?? existing.onWake } : request;
    this.queue.set(request.key, merged);
    this.armTimer();
    return this.snapshot();
  }

  debounce(request: Omit<SchedulerWakeRequest, 'mode' | 'wakeAt'> & { delayMs: number }): SchedulerSnapshot {
    return this.schedule({ ...request, mode: 'debounce', wakeAt: this.clock() + request.delayMs });
  }

  throttle(request: Omit<SchedulerWakeRequest, 'mode' | 'wakeAt'> & { delayMs: number }): SchedulerSnapshot {
    return this.schedule({ ...request, mode: 'throttle', wakeAt: this.clock() + request.delayMs });
  }

  wakeNow(request: Omit<SchedulerWakeRequest, 'mode' | 'wakeAt'>): SchedulerSnapshot {
    return this.schedule({ ...request, mode: 'immediate', wakeAt: this.clock() });
  }

  cancel(key: string): void {
    this.queue.delete(key);
    this.armTimer();
  }

  flushDue(now = this.clock()): SchedulerWakeRequest[] {
    const due = [...this.queue.values()].filter((wake) => wake.wakeAt <= now).sort((left, right) => left.wakeAt - right.wakeAt);
    if (due.length === 0) return [];
    for (const wake of due) this.queue.delete(wake.key);
    this.lastFlushedAt = now;
    this.armTimer();
    for (const wake of due) wake.onWake?.(wake);
    return due;
  }

  snapshot(): SchedulerSnapshot {
    const wakes = [...this.queue.values()];
    return {
      pendingCount: wakes.length,
      nextWakeAt: wakes.length > 0 ? Math.min(...wakes.map((wake) => wake.wakeAt)) : null,
      queuedKeys: wakes.map((wake) => wake.key).sort(),
      modes: [...new Set(wakes.map((wake) => wake.mode))],
      lastFlushedAt: this.lastFlushedAt,
    };
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextWakeAt = this.snapshot().nextWakeAt;
    if (nextWakeAt === null) return;
    const delay = Math.max(0, nextWakeAt - this.clock());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushDue();
    }, delay);
  }
}

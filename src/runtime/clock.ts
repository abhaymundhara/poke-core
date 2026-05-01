export type RuntimeClock = {
  now: () => number;
  iso: () => string;
  advance: (ms: number) => number;
};

export function createFixedClock(start: string | number | Date): RuntimeClock {
  let current = start instanceof Date ? start.getTime() : typeof start === 'number' ? start : Date.parse(start);
  if (!Number.isFinite(current)) throw new Error(`invalid fixed clock start: ${String(start)}`);
  return {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
      return current;
    },
  };
}

export function createSystemClock(): RuntimeClock {
  return {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    advance: () => Date.now(),
  };
}

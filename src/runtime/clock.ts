export type RuntimeClock = {
  now: () => number;
  iso: () => string;
  advance: (ms: number) => number;
};

function toMillis(value: string | number | Date): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid clock value: ' + String(value));
  return parsed;
}

export function createFixedClock(start: string | number | Date): RuntimeClock {
  let current = toMillis(start);
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

export function createDriftingClock(initial?: number | string | Date): RuntimeClock {
  let current = initial === undefined ? Date.now() : toMillis(initial);
  let lastReal = Date.now();
  let tick = 0;
  return {
    now: () => {
      const realNow = Date.now();
      const elapsed = Math.max(1, realNow - lastReal);
      lastReal = realNow;
      tick += 1;
      const wobble = ((tick % 9) - 4) * 5 + (elapsed % 17) + 1;
      current += elapsed + wobble;
      return current;
    },
    iso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
      return current;
    },
  };
}

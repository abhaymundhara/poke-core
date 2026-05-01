const DEFAULT_DIMENSION = 64;

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function tokenizeSemantic(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    .split(/[\s_-]+/)
    .filter((token) => token.length > 1);
}

export function embedText(text: string, dimension = DEFAULT_DIMENSION): number[] {
  const vector = Array.from({ length: dimension }, () => 0);
  const tokens = tokenizeSemantic(text);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const hash = stableHash(token);
    const weight = 1 + Math.log1p(token.length);
    const primary = hash % dimension;
    const secondary = (hash >>> 7) % dimension;
    const tertiary = (hash >>> 13) % dimension;
    const sign = hash & 1 ? 1 : -1;
    vector[primary] += weight * sign;
    vector[secondary] += weight * 0.45;
    vector[tertiary] += weight * 0.25 * sign;
  }

  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < size; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1;
  return dot / denominator;
}

export function vectorMagnitude(vector: number[]): number {
  return Math.hypot(...vector);
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function nowMs(): number { return Date.now(); }
export function clamp(value: number, min = 0, max = 1): number { return Math.max(min, Math.min(max, value)); }
export function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
export function uniq<T extends string>(values: T[]): T[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean) as T[])]; }
export function normalize(text: string): string { return text.toLowerCase().trim().replace(/[^a-z0-9@._:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''); }
export function words(text: string): string[] { return text.toLowerCase().match(/[a-z0-9@._:-]{2,}/g) ?? []; }
export function stableHash(value: string): string { return createHash('sha1').update(value).digest('hex').slice(0, 12); }
export function hostname(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
export function ensureDir(path: string): void { const dir = dirname(path); if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
export function readJson<T>(path: string, fallback: T): T { try { if (!existsSync(path)) return fallback; return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; } }
export function writeJson(path: string, value: unknown): void { ensureDir(path); writeFileSync(path, JSON.stringify(value, null, 2)); }
export function textFrom(value: unknown): string { return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''; }

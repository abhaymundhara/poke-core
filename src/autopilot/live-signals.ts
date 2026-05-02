import { createObservation, createSignal, type AutopilotObservation, type AutopilotSignal, type AutopilotSignalSource } from './events';
import { createSearchSession, type SearchPlan, type SearchResult, type SearchSignalForecast, type SemanticNluProvider } from '../search/index.ts';
import { listIssues, listPullRequests } from '../../../../mcp/github-2-5fa2cac3-9210-42b4-8e09-3c789dc5c9e3.ts';
import { realtimeWebSearch } from '../../../../poke/search/realtime_web_search.ts';

export type LiveWebResult = {
  title: string;
  url: string;
  snippet: string;
  source: 'realtime-web' | 'web';
  publishedAt: string | null;
  freshness: number;
  crawlSummary?: LiveWebCrawlResult;
};

export type LiveWebCrawlResult = {
  url: string;
  title: string;
  description: string;
  canonicalUrl: string;
  status: number;
  publishedAt: string | null;
  freshness: number;
};

export type LiveWebSignalBundle = {
  query: string;
  searchedAt: number;
  results: LiveWebResult[];
  crawls: LiveWebCrawlResult[];
  signals: AutopilotSignal[];
  observations: AutopilotObservation[];
  freshnessScore: number;
  sourceCount: number;
};

export type GithubWatch = {
  owner: string;
  repo: string;
  labels?: string[];
  since?: string;
  state?: 'OPEN' | 'CLOSED' | 'ALL';
  perPage?: number;
};

export type PlatformEvent = {
  source: 'github';
  owner: string;
  repo: string;
  kind: 'issue' | 'pull-request';
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  freshness: number;
  labels: string[];
  state: string;
  signal: AutopilotSignal;
  observation: AutopilotObservation;
};

export type PlatformSignalBundle = {
  polledAt: number;
  events: PlatformEvent[];
  signals: AutopilotSignal[];
  observations: AutopilotObservation[];
  sourceCount: number;
};

export type LiveDaemonSnapshot = {
  running: boolean;
  intervalMs: number;
  pollCount: number;
  lastPollAt: number | null;
  lastWakeAt: number | null;
  lastWebQuery: string | null;
  lastPlatformPollCount: number;
  lastWebResultCount: number;
  lastSourceCount: number;
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9@._:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs).unref?.();
    }),
  ]);
}

function parseRelativeDate(dateText: string, now: number): number | null {
  const normalized = dateText.trim().toLowerCase();
  if (!normalized) return null;
  const direct = Date.parse(normalized);
  if (!Number.isNaN(direct)) return direct;
  const relative = normalized.match(/^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\s+ago$/);
  if (relative) {
    const value = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit.startsWith('minute') ? 60_000 : unit.startsWith('hour') ? 3_600_000 : unit.startsWith('day') ? 86_400_000 : 604_800_000;
    return now - value * multiplier;
  }
  if (normalized === 'today') return now;
  if (normalized === 'yesterday') return now - 86_400_000;
  return null;
}

function decodeBingUrl(href: string): string {
  try {
    const parsed = new URL(href, 'https://www.bing.com');
    const encoded = parsed.searchParams.get('u');
    if (!encoded) return href;
    const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    return decoded.startsWith('http') ? decoded : href;
  } catch {
    return href;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function parseGithubListHtml(html: string, kind: 'issue' | 'pull-request', owner: string, repo: string, now: number): PlatformEvent[] {
  const events: PlatformEvent[] = [];
  const regex = kind === 'issue'
    ? new RegExp(`<a[^>]*href="/${owner}/${repo}/issues/(\d+)"[^>]*>([\s\S]*?)<\/a>`, 'gi')
    : new RegExp(`<a[^>]*href="/${owner}/${repo}/pull/(\d+)"[^>]*>([\s\S]*?)<\/a>`, 'gi');
  const seen = new Set<number>();
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = regex.exec(html)) !== null) {
    const number = Number(match[1]);
    if (!Number.isFinite(number) || seen.has(number)) continue;
    const title = stripHtml(match[2]);
    if (!title) continue;
    seen.add(number);
    const freshness = Math.max(0.2, Number((1 - index * 0.08).toFixed(3)));
    const updatedAt = new Date(now - index * 15 * 60_000).toISOString();
    const url = `https://github.com/${owner}/${repo}/${kind === 'issue' ? 'issues' : 'pull'}/${number}`;
    const labels: string[] = [];
    const state = 'open';
    const signal = createSignal({
      source: 'integration',
      key: `github:${owner}/${repo}:${kind === 'issue' ? 'issue' : 'pr'}:${number}`,
      reason: title,
      payload: { platform: 'github', owner, repo, kind, number, title, url, updatedAt, labels, state },
      priority: Math.min(1, 0.58 + freshness * 0.35),
      debounceMs: 180,
      throttleMs: 2_000,
      wakeMode: freshness >= 0.7 ? 'immediate' : 'debounce',
      tags: ['github', kind, 'live'],
    });
    const observation = createObservation({
      source: 'integration',
      focus: `github:${owner}/${repo}:${kind === 'issue' ? 'issue' : 'pr'}:${number}`,
      value: title,
      confidence: Math.min(1, 0.52 + freshness * 0.4),
      freshnessMs: Math.max(2_000, Math.round((1 - freshness) * 1_200_000)),
      tags: ['github', kind],
    });
    events.push({ source: 'github', owner, repo, kind, number, title, url, updatedAt, freshness, labels, state, signal, observation });
    index += 1;
    if (events.length >= 3) break;
  }
  return events;
}

function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const first = content.find((item) => item && typeof item === 'object' && 'text' in (item as Record<string, unknown>));
  const text = first && typeof first === 'object' ? String((first as Record<string, unknown>).text ?? '') : '';
  return text;
}

function asObject(result: unknown): Record<string, unknown> {
  const text = extractText(result);
  const parsed = safeJsonParse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function collectUrls(payload: Record<string, unknown>): Array<{ title: string; url: string; snippet: string; publishedAt: string | null }> {
  const urls: Array<{ title: string; url: string; snippet: string; publishedAt: string | null }> = [];
  const organic = Array.isArray(payload.organic_results) ? payload.organic_results : [];
  for (const item of organic) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = typeof record.link === 'string' ? record.link : '';
    if (!url) continue;
    urls.push({
      title: typeof record.title === 'string' ? record.title : url,
      url,
      snippet: typeof record.snippet === 'string' ? record.snippet : '',
      publishedAt: typeof record.date === 'string' ? record.date : null,
    });
  }
  const inlineVideos = Array.isArray(payload.inline_videos) ? payload.inline_videos : [];
  for (const item of inlineVideos) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = typeof record.link === 'string' ? record.link : '';
    if (!url) continue;
    urls.push({
      title: typeof record.title === 'string' ? record.title : url,
      url,
      snippet: typeof record.snippet === 'string' ? record.snippet : '',
      publishedAt: typeof record.date === 'string' ? record.date : null,
    });
  }
  return urls;
}

function freshnessFromDate(dateText: string | null, now: number): number {
  if (!dateText) return 0.35;
  const parsed = Date.parse(dateText);
  if (Number.isNaN(parsed)) return 0.42;
  const ageHours = Math.max(0, (now - parsed) / 3_600_000);
  return Number(Math.max(0.08, Math.min(1, Math.exp(-ageHours / 72))).toFixed(3));
}

async function crawlUrl(url: string, now: number): Promise<LiveWebCrawlResult | null> {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    const html = await response.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? url).trim();
    const description = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1]
      ?? '').trim();
    const canonicalUrl = (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? url).trim();
    const publishedAt = html.match(/<meta[^>]*property=["'](?:article:published_time|og:updated_time)["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? null;
    return {
      url,
      title,
      description,
      canonicalUrl,
      status: response.status,
      publishedAt,
      freshness: freshnessFromDate(publishedAt, now),
    };
  } catch {
    return null;
  }
}

function buildWebSignal(source: AutopilotSignalSource, key: string, reason: string, payload: Record<string, unknown>, freshness: number): AutopilotSignal {
  return createSignal({
    source,
    key,
    reason,
    payload,
    priority: Math.min(1, 0.55 + freshness * 0.4),
    debounceMs: 120,
    throttleMs: 1_500,
    wakeMode: freshness >= 0.75 ? 'immediate' : 'debounce',
    tags: ['live', 'web', key],
  });
}

function buildWebObservation(source: AutopilotSignalSource, focus: string, value: string, freshness: number, tags: string[]): AutopilotObservation {
  return createObservation({
    source,
    focus,
    value,
    confidence: Math.min(1, 0.45 + freshness * 0.5),
    freshnessMs: Math.max(2_000, Math.round((1 - freshness) * 360_000)),
    tags: ['live', ...tags],
  });
}

async function searchLiveWeb(query: string, now: number): Promise<LiveWebResult[]> {
  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let html = '';
  try {
    const response = await fetch(bingUrl, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: controller.signal });
    html = await response.text();
  } catch {
    html = '';
  } finally {
    clearTimeout(timeout);
  }

  const results: LiveWebResult[] = [];
  if (html) {
    const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
    for (const block of blocks.slice(0, 8)) {
      const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
      if (!titleMatch) continue;
      const url = decodeBingUrl(titleMatch[1]);
      const rawTitle = titleMatch[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
      const snippet = (block.match(/<p class="b_lineclamp2"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const dateText = block.match(/<span class="news_dt">([\s\S]*?)<\/span>/i)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? null;
      results.push({
        title: rawTitle.replace(/\s+/g, ' ').trim(),
        url,
        snippet,
        source: 'web',
        publishedAt: dateText,
        freshness: dateText ? (() => {
          const parsed = parseRelativeDate(dateText, now);
          return parsed ? freshnessFromDate(new Date(parsed).toISOString(), now) : freshnessFromDate(dateText, now);
        })() : 0.35,
      });
    }
  }

  if (results.length === 0) {
    try {
      const payload = asObject(await withTimeout(realtimeWebSearch({ query }), 8_000, 'realtime-web-search'));
      const payloads = collectUrls(payload).map((result) => ({
        ...result,
        source: 'realtime-web',
        freshness: freshnessFromDate(result.publishedAt, now),
      }));
      for (const result of payloads) results.push(result);
    } catch {
      // strict realtime-only path: no web fallback branch
    }
  }

  const deduped = new Map<string, LiveWebResult>();
  for (const result of results) {
    const key = normalizeKey(result.url);
    const existing = deduped.get(key);
    if (!existing || existing.freshness < result.freshness) deduped.set(key, result);
  }
  return [...deduped.values()].sort((left, right) => right.freshness - left.freshness);
}

export async function pollLiveWebSignals(query: string, now = Date.now()): Promise<LiveWebSignalBundle> {
  const results = await searchLiveWeb(query, now);
  const crawls: LiveWebCrawlResult[] = [];
  for (const result of results.slice(0, 3)) {
    const crawl = await crawlUrl(result.url, now);
    if (crawl) {
      crawls.push(crawl);
      result.crawlSummary = crawl;
      result.freshness = Math.max(result.freshness, crawl.freshness);
    }
  }

  const freshnessScore = results.length > 0
    ? Number((results.reduce((sum, result) => sum + result.freshness, 0) / results.length).toFixed(3))
    : 0;
  const signals = results.slice(0, 4).map((result, index) => buildWebSignal(
    'browser',
    `live-web:${normalizeKey(query)}:${index}`,
    `fresh web result for ${query}`,
    { query, title: result.title, url: result.url, snippet: result.snippet, source: result.source, freshness: result.freshness, crawl: result.crawlSummary ?? null },
    result.freshness,
  ));
  const observations = results.slice(0, 4).map((result, index) => buildWebObservation('browser', `live-web:${index}`, result.title, result.freshness, [normalizeKey(query), normalizeKey(result.source)]));
  return { query, searchedAt: now, results, crawls, signals, observations, freshnessScore, sourceCount: results.length };
}

function normalizeGithubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => {
    if (!label) return '';
    if (typeof label === 'string') return label;
    if (typeof label === 'object' && label !== null && 'name' in label) return String((label as Record<string, unknown>).name ?? '');
    return '';
  }).filter(Boolean);
}

function githubFreshness(updatedAt: string, now: number): number {
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return 0.45;
  const ageHours = Math.max(0, (now - parsed) / 3_600_000);
  return Number(Math.max(0.12, Math.min(1, Math.exp(-ageHours / 168))).toFixed(3));
}

function issueEventsFromPayload(owner: string, repo: string, payload: unknown, now: number): PlatformEvent[] {
  const items = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { issues?: unknown }).issues) ? (payload as { issues?: unknown }).issues : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const number = typeof record.number === 'number' ? record.number : Number(record.number ?? 0);
    const title = typeof record.title === 'string' ? record.title : `issue-${number}`;
    const url = typeof record.html_url === 'string' ? record.html_url : typeof record.url === 'string' ? record.url : `https://github.com/${owner}/${repo}/issues/${number}`;
    const updatedAt = typeof record.updated_at === 'string' ? record.updated_at : typeof record.updatedAt === 'string' ? record.updatedAt : new Date(now).toISOString();
    const freshness = githubFreshness(updatedAt, now);
    const labels = normalizeGithubLabels(record.labels);
    const state = typeof record.state === 'string' ? record.state : 'open';
    const signal = createSignal({
      source: 'integration',
      key: `github:${owner}/${repo}:issue:${number}`,
      reason: title,
      payload: { platform: 'github', owner, repo, kind: 'issue', number, title, url, updatedAt, labels, state },
      priority: Math.min(1, 0.58 + freshness * 0.35),
      debounceMs: 180,
      throttleMs: 2_000,
      wakeMode: freshness >= 0.7 ? 'immediate' : 'debounce',
      tags: ['github', 'issue', ...labels.slice(0, 3), 'live'],
    });
    const observation = createObservation({
      source: 'integration',
      focus: `github:${owner}/${repo}:issue:${number}`,
      value: title,
      confidence: Math.min(1, 0.52 + freshness * 0.4),
      freshnessMs: Math.max(2_000, Math.round((1 - freshness) * 1_200_000)),
      tags: ['github', 'issue', ...labels.slice(0, 3)],
    });
    return [{ source: 'github', owner, repo, kind: 'issue', number, title, url, updatedAt, freshness, labels, state, signal, observation }];
  });
}

function pullRequestEventsFromPayload(owner: string, repo: string, payload: unknown, now: number): PlatformEvent[] {
  const items = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { pullRequests?: unknown }).pullRequests) ? (payload as { pullRequests?: unknown }).pullRequests : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const number = typeof record.number === 'number' ? record.number : Number(record.number ?? 0);
    const title = typeof record.title === 'string' ? record.title : `pull-request-${number}`;
    const url = typeof record.html_url === 'string' ? record.html_url : typeof record.url === 'string' ? record.url : `https://github.com/${owner}/${repo}/pull/${number}`;
    const updatedAt = typeof record.updated_at === 'string' ? record.updated_at : typeof record.updatedAt === 'string' ? record.updatedAt : new Date(now).toISOString();
    const freshness = githubFreshness(updatedAt, now);
    const labels = normalizeGithubLabels(record.labels);
    const state = typeof record.state === 'string' ? record.state : 'open';
    const signal = createSignal({
      source: 'integration',
      key: `github:${owner}/${repo}:pr:${number}`,
      reason: title,
      payload: { platform: 'github', owner, repo, kind: 'pull-request', number, title, url, updatedAt, labels, state },
      priority: Math.min(1, 0.58 + freshness * 0.35),
      debounceMs: 180,
      throttleMs: 2_000,
      wakeMode: freshness >= 0.7 ? 'immediate' : 'debounce',
      tags: ['github', 'pull-request', ...labels.slice(0, 3), 'live'],
    });
    const observation = createObservation({
      source: 'integration',
      focus: `github:${owner}/${repo}:pr:${number}`,
      value: title,
      confidence: Math.min(1, 0.52 + freshness * 0.4),
      freshnessMs: Math.max(2_000, Math.round((1 - freshness) * 1_200_000)),
      tags: ['github', 'pull-request', ...labels.slice(0, 3)],
    });
    return [{ source: 'github', owner, repo, kind: 'pull-request', number, title, url, updatedAt, freshness, labels, state, signal, observation }];
  });
}

export async function pollGithubPlatformSignals(watches: GithubWatch[], now = Date.now()): Promise<PlatformSignalBundle> {
  const allEvents: PlatformEvent[] = [];
  for (const watch of watches) {
    const state = (watch.state ?? 'OPEN').toLowerCase();
    try {
      const issueResponse = await listIssues({ owner: watch.owner, repo: watch.repo, state: state === 'all' ? 'OPEN' : (state.toUpperCase() as 'OPEN' | 'CLOSED'), perPage: watch.perPage ?? 5, orderBy: 'UPDATED_AT', direction: 'DESC', labels: watch.labels ?? [] });
      const pullResponse = await listPullRequests({ owner: watch.owner, repo: watch.repo, state: state === 'all' ? 'all' : state, perPage: watch.perPage ?? 5, sort: 'updated', direction: 'desc' });
      const issuePayload = asObject(issueResponse);
      const pullPayload = asObject(pullResponse);
      const issueEvents = issueEventsFromPayload(watch.owner, watch.repo, issuePayload.issues ?? issuePayload.nodes ?? issuePayload, now);
      const pullEvents = pullRequestEventsFromPayload(watch.owner, watch.repo, pullPayload.pullRequests ?? pullPayload.nodes ?? pullPayload, now);
      if (issueEvents.length > 0 || pullEvents.length > 0) {
        allEvents.push(...issueEvents, ...pullEvents);
        continue;
      }
    } catch {
      // fall back to HTML scraping below
    }
    const issuePage = 'https://github.com/' + encodeURIComponent(watch.owner) + '/' + encodeURIComponent(watch.repo) + '/issues?q=is%3Aissue+is%3A' + (state === 'all' ? 'open' : state) + '+sort%3Aupdated-desc';
    const pullPage = 'https://github.com/' + encodeURIComponent(watch.owner) + '/' + encodeURIComponent(watch.repo) + '/pulls?q=is%3Apr+is%3A' + (state === 'all' ? 'open' : state) + '+sort%3Aupdated-desc';
    const [issueHtml, pullHtml] = await Promise.all([fetchText(issuePage, 12_000), fetchText(pullPage, 12_000)]);
    if (issueHtml) allEvents.push(...parseGithubListHtml(issueHtml, 'issue', watch.owner, watch.repo, now));
    if (pullHtml) allEvents.push(...parseGithubListHtml(pullHtml, 'pull-request', watch.owner, watch.repo, now));
  }

  const deduped = new Map<string, PlatformEvent>();
  for (const event of allEvents) {
    const key = event.owner + '/' + event.repo + ':' + event.kind + ':' + event.number;
    const existing = deduped.get(key);
    if (!existing || existing.freshness < event.freshness || Date.parse(existing.updatedAt) < Date.parse(event.updatedAt)) deduped.set(key, event);
  }
  const events = [...deduped.values()].sort((left, right) => right.freshness - left.freshness);
  return {
    polledAt: now,
    events,
    signals: events.map((event) => event.signal),
    observations: events.map((event) => event.observation),
    sourceCount: events.length,
  };
}

export type LiveDaemonDependencies = {
  clock: () => number;
  query: string;
  context?: Record<string, unknown>;
  githubWatches?: GithubWatch[];
  nluProvider: SemanticNluProvider;
  onSignal?: (signal: AutopilotSignal) => void;
  onObservation?: (observation: AutopilotObservation) => void;
  onEvent?: (event: PlatformEvent) => void;
  onWake?: (reason: string, payload: Record<string, unknown>) => void;
};

export class AutopilotLiveDaemon {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollCount = 0;
  private lastPollAt: number | null = null;
  private lastWakeAt: number | null = null;
  private lastWebQuery: string | null = null;
  private lastPlatformPollCount = 0;
  private lastWebResultCount = 0;
  private lastSourceCount = 0;
  private readonly session;

  constructor(private readonly deps: LiveDaemonDependencies, private intervalMs = 30_000) {
    this.session = createSearchSession({ nluProvider: deps.nluProvider, behaviorSeed: deps.context ?? { query: deps.query }, strictSemanticNlu: true });
  }

  start(intervalMs = this.intervalMs): void {
    this.intervalMs = intervalMs;
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<{ web: LiveWebSignalBundle; platform: PlatformSignalBundle; wakeReasons: string[]; searchPlan: SearchPlan }> {
    this.pollCount += 1;
    const now = this.deps.clock();
    const searchPlan = await this.session.planSemantic(this.deps.query, { ...(this.deps.context ?? {}), liveSignals: true, query: this.deps.query, providerNluAvailable: true });
    const [web, platform] = await Promise.all([
      pollLiveWebSignals(searchPlan.intent.semanticQuery, now),
      pollGithubPlatformSignals(this.deps.githubWatches ?? [], now),
    ]);
    this.lastPollAt = now;
    this.lastWebQuery = searchPlan.intent.semanticQuery;
    this.lastWebResultCount = web.results.length;
    this.lastPlatformPollCount = platform.events.length;
    this.lastSourceCount = web.sourceCount + platform.sourceCount;
    const wakeReasons: string[] = [];
    for (const observation of [...web.observations, ...platform.observations]) this.deps.onObservation?.(observation);
    for (const signal of [...web.signals, ...platform.signals]) {
      this.deps.onSignal?.(signal);
      if (signal.wakeMode === 'immediate' || signal.priority >= 0.8) wakeReasons.push(signal.reason);
    }
    for (const event of platform.events) this.deps.onEvent?.(event);
    if (wakeReasons.length > 0) {
      this.lastWakeAt = now;
      this.deps.onWake?.(wakeReasons[0], { reasons: wakeReasons, webFreshness: web.freshnessScore, platformSignals: platform.sourceCount, searchStrategy: searchPlan.strategy.name });
    }
    return { web, platform, wakeReasons, searchPlan };
  }

  snapshot(): LiveDaemonSnapshot {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      pollCount: this.pollCount,
      lastPollAt: this.lastPollAt,
      lastWakeAt: this.lastWakeAt,
      lastWebQuery: this.lastWebQuery,
      lastPlatformPollCount: this.lastPlatformPollCount,
      lastWebResultCount: this.lastWebResultCount,
      lastSourceCount: this.lastSourceCount,
    };
  }
}

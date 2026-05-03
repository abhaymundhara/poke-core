import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { SkillAdapter } from './types';

type IntegrationMode = 'read' | 'write' | 'dry-run' | 'compensate';

type IntegrationActionContext = {
  provider: string;
  action: string;
  mode: IntegrationMode;
  payload: Record<string, unknown>;
  ctx: ExecutionContext;
};

type IntegrationOutput = {
  provider: string;
  action: string;
  mode: IntegrationMode;
  externalIds?: string[];
  artifact?: unknown;
  riskFlags?: string[];
  nextAction: 'confirm' | 'retry' | 'continue' | 'clarify' | 'done';
};

type ProviderConfig = {
  token?: string;
  baseUrl?: string;
  version?: string;
  teamId?: string;
  projectId?: string;
  workspaceId?: string;
  databaseId?: string;
  notionVersion?: string;
};

class IntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(attempt: number): number {
  const base = Math.min(2_000 * (2 ** Math.max(0, attempt - 1)), 15_000);
  const jitter = Math.round(base * (0.2 * Math.random()));
  return base + jitter;
}

function headerValue(headers: Headers | undefined, key: string): string | undefined {
  const value = headers?.get(key);
  return value ? value : undefined;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  const reset = headerValue(headers, 'x-ratelimit-reset');
  if (reset) {
    const resetSeconds = Number(reset);
    if (Number.isFinite(resetSeconds)) return Math.max(0, (resetSeconds * 1000) - Date.now());
  }

  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function requestJson<T>(url: string, init: RequestInit, options?: { attempts?: number; provider?: string; action?: string; retryableStatuses?: number[]; parseText?: boolean }): Promise<{ status: number; headers: Headers; data: T; rawText: string }> {
  const attempts = options?.attempts ?? 3;
  const retryableStatuses = new Set(options?.retryableStatuses ?? [429, 500, 502, 503, 504]);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const rawText = await response.text();
      let data: unknown = null;
      if (rawText.length > 0) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = options?.parseText ? rawText : rawText;
        }
      }

      if (!response.ok) {
        const retryable = retryableStatuses.has(response.status) || (response.status === 403 && !!headerValue(response.headers, 'x-ratelimit-remaining') && headerValue(response.headers, 'x-ratelimit-remaining') === '0');
        if (retryable && attempt < attempts) {
          const delay = parseRetryAfter(response.headers) ?? jitteredBackoff(attempt);
          await sleep(delay);
          continue;
        }

        throw new IntegrationError(
          'http_error',
          'request failed with status ' + response.status,
          retryable,
          response.status,
          { url, body: data, headers: Object.fromEntries(response.headers.entries()) },
        );
      }

      return { status: response.status, headers: response.headers, data: data as T, rawText };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof IntegrationError ? error.retryable : true;
      if (!retryable || attempt >= attempts) break;
      await sleep(jitteredBackoff(attempt));
    }
  }

  if (lastError instanceof IntegrationError) throw lastError;
  throw new IntegrationError('network_error', lastError instanceof Error ? lastError.message : 'request failed', true, undefined, { cause: String(lastError) });
}

function deepFind(value: unknown, predicate: (key: string, current: unknown) => boolean, seen = new Set<unknown>()): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = deepFind(entry, predicate, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const [key, current] of Object.entries(value)) {
    if (predicate(key, current)) return current;
    const found = deepFind(current, predicate, seen);
    if (found !== undefined) return found;
  }

  return undefined;
}

function findFirstString(root: unknown, keys: string[]): string | undefined {
  const lower = keys.map((key) => key.toLowerCase());
  const found = deepFind(root, (key, current) => {
    if (!lower.includes(key.toLowerCase())) return false;
    return typeof current === 'string' || typeof current === 'number';
  });
  if (typeof found === 'string') return found.trim();
  if (typeof found === 'number') return String(found);
  return undefined;
}

function resolveAuthValue(ctx: ExecutionContext, provider: string, keys: string[], fallbackEnv: string[]): string | undefined {
  const roots: unknown[] = [
    (ctx as unknown as Record<string, unknown>).step,
    (ctx as unknown as Record<string, unknown>).state,
    (ctx as unknown as Record<string, unknown>).plan,
    (ctx as unknown as Record<string, unknown>).task,
    (ctx.step.args ?? {}),
    (ctx.step.args?.payload ?? {}),
  ];

  for (const root of roots) {
    const found = findFirstString(root, keys);
    if (found) return found;
  }

  for (const envName of fallbackEnv) {
    const value = process.env[envName];
    if (value && value.trim()) return value.trim();
  }

  const providerRoots = [
    (ctx.step.args?.payload as Record<string, unknown> | undefined)?.auth,
    (ctx.step.args?.payload as Record<string, unknown> | undefined)?.secrets,
    (ctx.step.args?.payload as Record<string, unknown> | undefined)?.credentials,
    (ctx.step.args?.payload as Record<string, unknown> | undefined)?.context,
    (ctx.state as unknown as Record<string, unknown>),
  ];

  for (const root of providerRoots) {
    if (!isRecord(root)) continue;
    const bucket = root[provider];
    const found = findFirstString(bucket, keys);
    if (found) return found;
  }

  return undefined;
}

function providerPayload(ctx: ExecutionContext): Record<string, unknown> {
  const payload = (ctx.step.args?.payload ?? {}) as Record<string, unknown>;
  return asRecord(payload);
}

function readString(payload: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function readNumber(payload: Record<string, unknown>, keys: string[], fallback?: number): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function readBoolean(payload: Record<string, unknown>, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

function readArray(payload: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function parseRepo(payload: Record<string, unknown>): { owner: string; repo: string } {
  const repoPath = readString(payload, ['repo', 'repository', 'repositoryPath', 'full_name']);
  const owner = readString(payload, ['owner', 'repositoryOwner']);
  const repo = readString(payload, ['repoName', 'name']);
  if (repoPath.includes('/')) {
    const [pathOwner, pathRepo] = repoPath.split('/');
    return { owner: owner || pathOwner, repo: repo || pathRepo };
  }
  if (!owner || !repoPath && !repo) {
    throw new IntegrationError('missing_repository', 'owner and repo are required', false, undefined, { keys: Object.keys(payload) });
  }
  return { owner, repo: repo || repoPath };
}

function encodePath(pathname: string): string {
  return pathname.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function base64(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function success(provider: string, action: string, mode: IntegrationMode, artifact: unknown, externalIds: string[] = [], nextAction: IntegrationOutput['nextAction'] = mode === 'read' ? 'continue' : 'done', note?: string, trace: Record<string, unknown> = {}, riskFlags: string[] = []): SkillResult {
  const output: IntegrationOutput = { provider, action, mode, artifact, nextAction };
  if (externalIds.length) output.externalIds = externalIds;
  if (riskFlags.length) output.riskFlags = riskFlags;
  return { ok: true, output, retryable: false, note, trace };
}

function failure(provider: string, action: string, error: unknown): SkillResult {
  if (error instanceof IntegrationError) {
    return {
      ok: false,
      output: {
        provider,
        action,
        mode: 'write',
        artifact: {
          code: error.code,
          message: error.message,
          status: error.status,
          details: error.details,
        },
        nextAction: error.retryable ? 'retry' : 'clarify',
      },
      retryable: error.retryable,
      note: error.message,
      trace: { code: error.code, status: error.status, details: error.details },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    output: {
      provider,
      action,
      mode: 'write',
      artifact: { message },
      nextAction: 'retry',
    },
    retryable: true,
    note: message,
    trace: { error: message },
  };
}

function githubToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(ctx, 'github', ['token', 'accessToken', 'apiToken', 'githubToken', 'github_access_token'], ['GITHUB_TOKEN', 'GITHUB_API_TOKEN', 'GH_TOKEN']);
}

function todoistToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(ctx, 'todoist', ['token', 'accessToken', 'apiToken', 'todoistToken'], ['TODOIST_API_TOKEN', 'TODOIST_TOKEN']);
}

function linearToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(ctx, 'linear', ['token', 'accessToken', 'apiToken', 'linearToken', 'linearApiKey'], ['LINEAR_API_KEY', 'LINEAR_TOKEN']);
}

function notionToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(ctx, 'notion', ['token', 'accessToken', 'apiToken', 'notionToken'], ['NOTION_TOKEN', 'NOTION_API_KEY']);
}

function vercelToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(ctx, 'vercel', ['token', 'accessToken', 'apiToken', 'vercelToken'], ['VERCEL_TOKEN', 'VERCEL_API_TOKEN']);
}

class GithubIntegrationAdapter {
  provider = 'github';
  actions = ['inspect', 'list_issues', 'list_pull_requests', 'create_issue', 'comment', 'merge_pull_request', 'upsert_file'];

  private async githubFetch<T>(ctx: ExecutionContext, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Headers; data: T }> {
    const token = githubToken(ctx);
    if (!token) throw new IntegrationError('auth_missing', 'github token is required', false);
    const response = await requestJson<T>(
      'https://api.github.com' + path,
      {
        method,
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { attempts: 3, retryableStatuses: [429, 500, 502, 503, 504] },
    );
    return { status: response.status, headers: response.headers, data: response.data };
  }

  private async listIssues(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const { owner, repo } = parseRepo(payload);
    const state = readString(payload, ['state'], 'open') || 'open';
    const perPage = readNumber(payload, ['per_page', 'perPage'], 10) ?? 10;
    const page = readNumber(payload, ['page'], 1) ?? 1;
    const labels = asStringArray(payload.labels ?? payload.labelNames);
    const query = new URLSearchParams({ state, per_page: String(perPage), page: String(page) });
    if (labels.length) query.set('labels', labels.join(','));
    const response = await this.githubFetch<any[]>(ctx, 'GET', '/repos/' + owner + '/' + repo + '/issues?' + query.toString());
    const issues = Array.isArray(response.data) ? response.data.filter((item) => !isRecord(item) || !('pull_request' in item)).map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      state: item.state,
      htmlUrl: item.html_url,
      url: item.url,
      labels: Array.isArray(item.labels) ? item.labels.map((label: any) => label?.name).filter(Boolean) : [],
      assignees: Array.isArray(item.assignees) ? item.assignees.map((assignee: any) => assignee?.login).filter(Boolean) : [],
      author: item.user?.login,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })) : [];
    return success(this.provider, 'list_issues', mode, { repository: owner + '/' + repo, issues, page, perPage }, issues.map((issue) => String(issue.number)), 'continue', undefined, { status: response.status, rateLimitRemaining: headerValue(response.headers, 'x-ratelimit-remaining') ?? undefined });
  }

  private async listPullRequests(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const { owner, repo } = parseRepo(payload);
    const state = readString(payload, ['state'], 'open') || 'open';
    const perPage = readNumber(payload, ['per_page', 'perPage'], 10) ?? 10;
    const page = readNumber(payload, ['page'], 1) ?? 1;
    const query = new URLSearchParams({ state, per_page: String(perPage), page: String(page) });
    const response = await this.githubFetch<any[]>(ctx, 'GET', '/repos/' + owner + '/' + repo + '/pulls?' + query.toString());
    const pullRequests = Array.isArray(response.data) ? response.data.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      state: item.state,
      htmlUrl: item.html_url,
      url: item.url,
      head: item.head?.ref,
      base: item.base?.ref,
      mergedAt: item.merged_at,
      draft: item.draft,
      author: item.user?.login,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })) : [];
    return success(this.provider, 'list_pull_requests', mode, { repository: owner + '/' + repo, pullRequests, page, perPage }, pullRequests.map((pr) => String(pr.number)), 'continue', undefined, { status: response.status, rateLimitRemaining: headerValue(response.headers, 'x-ratelimit-remaining') ?? undefined });
  }

  private async inspect(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const issuesResult = await this.listIssues(ctx, 'read', payload);
    const prsResult = await this.listPullRequests(ctx, 'read', payload);
    const issues = isRecord(issuesResult.output) ? (issuesResult.output as { artifact?: any }).artifact?.issues ?? [] : [];
    const pullRequests = isRecord(prsResult.output) ? (prsResult.output as { artifact?: any }).artifact?.pullRequests ?? [] : [];
    return success(this.provider, 'inspect', mode, { issues, pullRequests }, [...(issues as any[]).map((issue) => String(issue.number)), ...(pullRequests as any[]).map((pr) => String(pr.number))], 'continue', 'fetched issues and pull requests');
  }

  private async createIssue(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const { owner, repo } = parseRepo(payload);
    const title = readString(payload, ['title', 'name']);
    if (!title) throw new IntegrationError('missing_title', 'title is required', false);
    const body = readString(payload, ['body', 'description']);
    const labels = asStringArray(payload.labels);
    const assignees = asStringArray(payload.assignees);
    const milestone = readNumber(payload, ['milestone_number', 'milestone']);
    const response = await this.githubFetch<any>(ctx, 'POST', '/repos/' + owner + '/' + repo + '/issues', {
      title,
      body: body || undefined,
      labels: labels.length ? labels : undefined,
      assignees: assignees.length ? assignees : undefined,
      milestone: milestone ?? undefined,
    });
    return success(this.provider, 'create_issue', mode, {
      id: response.data.id,
      number: response.data.number,
      title: response.data.title,
      htmlUrl: response.data.html_url,
      url: response.data.url,
      state: response.data.state,
    }, [String(response.data.number)], 'done', 'created github issue');
  }

  private async comment(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const { owner, repo } = parseRepo(payload);
    const issueNumber = readNumber(payload, ['issue_number', 'pull_number', 'number', 'issueNumber', 'pullNumber']);
    const body = readString(payload, ['body', 'comment', 'text']);
    if (!issueNumber) throw new IntegrationError('missing_issue_number', 'issue_number is required', false);
    if (!body) throw new IntegrationError('missing_body', 'body is required', false);
    const response = await this.githubFetch<any>(ctx, 'POST', '/repos/' + owner + '/' + repo + '/issues/' + issueNumber + '/comments', { body });
    return success(this.provider, 'comment', mode, {
      id: response.data.id,
      body: response.data.body,
      htmlUrl: response.data.html_url,
      issueNumber,
    }, [String(issueNumber), String(response.data.id)], 'done', 'created issue comment');
  }

  private async mergePullRequest(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const { owner, repo } = parseRepo(payload);
    const pullNumber = readNumber(payload, ['pull_number', 'number', 'pullNumber']);
    if (!pullNumber) throw new IntegrationError('missing_pull_number', 'pull_number is required', false);
    const mergeMethod = readString(payload, ['merge_method', 'mergeMethod'], 'merge') || 'merge';
    const commitTitle = readString(payload, ['commit_title', 'commitTitle']);
    const commitMessage = readString(payload, ['commit_message', 'commitMessage']);
    const response = await this.githubFetch<any>(ctx, 'PUT', '/repos/' + owner + '/' + repo + '/pulls/' + pullNumber + '/merge', {
      merge_method: mergeMethod,
      commit_title: commitTitle || undefined,
      commit_message: commitMessage || undefined,
    });
    return success(this.provider, 'merge_pull_request', mode, {
      merged: response.data.merged,
      message: response.data.message,
      sha: response.data.sha,
    }, [String(pullNumber), String(response.data.sha ?? '')].filter(Boolean), 'done', 'merged pull request');
  }

  private async upsertFile(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const { owner, repo } = parseRepo(payload);
    const pathName = readString(payload, ['path', 'filePath']);
    const branch = readString(payload, ['branch'], 'main') || 'main';
    const contentText = readString(payload, ['content', 'text']);
    const message = readString(payload, ['message', 'commit_message'], 'update file') || 'update file';
    const shaValue = readString(payload, ['sha', 'blobSha']);
    if (!pathName) throw new IntegrationError('missing_path', 'path is required', false);
    if (!contentText) throw new IntegrationError('missing_content', 'content is required', false);
    const response = await this.githubFetch<any>(ctx, 'PUT', '/repos/' + owner + '/' + repo + '/contents/' + encodePath(pathName), {
      message,
      branch,
      content: base64(contentText),
      sha: shaValue || undefined,
    });
    return success(this.provider, 'upsert_file', mode, {
      contentPath: pathName,
      commitSha: response.data.commit?.sha,
      contentSha: response.data.content?.sha,
      url: response.data.content?.html_url,
    }, [String(response.data.commit?.sha ?? ''), String(response.data.content?.sha ?? '')].filter(Boolean), 'done', 'upserted repository file');
  }

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    try {
      const action = ctx.action;
      const payload = ctx.payload;
      if (action === 'inspect') return await this.inspect(ctx.ctx, ctx.mode, payload);
      if (action === 'list_issues') return await this.listIssues(ctx.ctx, ctx.mode, payload);
      if (action === 'list_pull_requests') return await this.listPullRequests(ctx.ctx, ctx.mode, payload);
      if (action === 'create_issue') return await this.createIssue(ctx.ctx, ctx.mode, payload);
      if (action === 'comment') return await this.comment(ctx.ctx, ctx.mode, payload);
      if (action === 'merge_pull_request') return await this.mergePullRequest(ctx.ctx, ctx.mode, payload);
      if (action === 'upsert_file') return await this.upsertFile(ctx.ctx, ctx.mode, payload);
      throw new IntegrationError('unsupported_action', 'unsupported github action: ' + action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class TodoistIntegrationAdapter {
  provider = 'todoist';
  actions = ['list_tasks', 'create_task', 'complete_task', 'add_task'];

  private async todoistFetch<T>(ctx: ExecutionContext, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Headers; data: T }> {
    const token = todoistToken(ctx);
    if (!token) throw new IntegrationError('auth_missing', 'todoist token is required', false);
    const response = await requestJson<T>(
      'https://api.todoist.com/rest/v2' + path,
      {
        method,
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { attempts: 3, retryableStatuses: [429, 500, 502, 503, 504] },
    );
    return { status: response.status, headers: response.headers, data: response.data };
  }

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    try {
      const payload = ctx.payload;
      if (ctx.action === 'list_tasks') {
        const response = await this.todoistFetch<any[]>(ctx.ctx, 'GET', '/tasks');
        const tasks = Array.isArray(response.data) ? response.data.map((task) => ({
          id: task.id,
          content: task.content,
          description: task.description,
          projectId: task.project_id,
          sectionId: task.section_id,
          parentId: task.parent_id,
          priority: task.priority,
          url: task.url,
          due: task.due,
          labels: task.labels ?? [],
          assigneeId: task.assignee_id,
          createdAt: task.created_at,
        })) : [];
        return success(this.provider, 'list_tasks', ctx.mode, { tasks }, tasks.map((task) => String(task.id)), 'continue', 'listed todoist tasks');
      }

      if (ctx.action === 'create_task' || ctx.action === 'add_task') {
        const content = readString(payload, ['content', 'title', 'text']);
        if (!content) throw new IntegrationError('missing_content', 'content is required', false);
        const response = await this.todoistFetch<any>(ctx.ctx, 'POST', '/tasks', {
          content,
          description: readString(payload, ['description']),
          project_id: readString(payload, ['project_id', 'projectId']) || undefined,
          section_id: readString(payload, ['section_id', 'sectionId']) || undefined,
          parent_id: readString(payload, ['parent_id', 'parentId']) || undefined,
          priority: readNumber(payload, ['priority']),
          labels: asStringArray(payload.labels),
          due_string: readString(payload, ['due_string', 'dueString']) || undefined,
          due_date: readString(payload, ['due_date', 'dueDate']) || undefined,
          due_datetime: readString(payload, ['due_datetime', 'dueDateTime']) || undefined,
        });
        return success(this.provider, 'create_task', ctx.mode, {
          id: response.data.id,
          content: response.data.content,
          projectId: response.data.project_id,
          url: response.data.url,
        }, [String(response.data.id)], 'done', 'created todoist task');
      }

      if (ctx.action === 'complete_task') {
        const taskId = readString(payload, ['task_id', 'taskId', 'id']);
        if (!taskId) throw new IntegrationError('missing_task_id', 'task_id is required', false);
        await this.todoistFetch<unknown>(ctx.ctx, 'POST', '/tasks/' + encodeURIComponent(taskId) + '/close');
        return success(this.provider, 'complete_task', ctx.mode, { id: taskId, completed: true }, [taskId], 'done', 'completed todoist task');
      }

      throw new IntegrationError('unsupported_action', 'unsupported todoist action: ' + ctx.action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class LinearIntegrationAdapter {
  provider = 'linear';
  actions = ['list_issues', 'create_issue', 'update_status', 'inspect', 'update_issue'];

  private async linearGraphQL<T>(ctx: ExecutionContext, query: string, variables: Record<string, unknown>): Promise<T> {
    const token = linearToken(ctx);
    if (!token) throw new IntegrationError('auth_missing', 'linear token is required', false);
    const response = await requestJson<{ data?: T; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> }>(
      'https://api.linear.app/graphql',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
      { attempts: 3, retryableStatuses: [429, 500, 502, 503, 504] },
    );
    if (response.data.errors?.length) {
      const message = response.data.errors.map((item) => item.message).join('; ');
      throw new IntegrationError('graphql_error', message, false, 200, { errors: response.data.errors });
    }
    return response.data.data as T;
  }

  private issueSelection = '
    id
    identifier
    title
    description
    url
    createdAt
    updatedAt
    state { id name type }
    team { id key name }
    assignee { id name email }
  ';

  private async listIssues(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const teamId = readString(payload, ['team_id', 'teamId']);
    const first = readNumber(payload, ['first', 'limit'], 10) ?? 10;
    const after = readString(payload, ['after', 'cursor']) || null;
    const query = teamId
      ? 'query Issues($first: Int!, $after: String, $teamId: String) { issues(first: $first, after: $after, filter: { team: { id: { eq: $teamId } } }) { nodes {' + this.issueSelection + '} pageInfo { hasNextPage endCursor } } }'
      : 'query Issues($first: Int!, $after: String) { issues(first: $first, after: $after) { nodes {' + this.issueSelection + '} pageInfo { hasNextPage endCursor } } }';
    const variables = teamId ? { first, after, teamId } : { first, after };
    const data = await this.linearGraphQL<{ issues: { nodes: any[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(ctx, query, variables);
    const issues = (data.issues?.nodes ?? []).map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      state: issue.state,
      team: issue.team,
      assignee: issue.assignee,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    }));
    return success(this.provider, 'list_issues', mode, { issues, pageInfo: data.issues?.pageInfo ?? null }, issues.map((issue) => String(issue.id)), 'continue', 'listed linear issues');
  }

  private async createIssue(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const teamId = readString(payload, ['team_id', 'teamId']);
    const title = readString(payload, ['title', 'name']);
    if (!teamId) throw new IntegrationError('missing_team_id', 'teamId is required', false);
    if (!title) throw new IntegrationError('missing_title', 'title is required', false);
    const input: Record<string, unknown> = {
      teamId,
      title,
      description: readString(payload, ['description', 'body']) || undefined,
      priority: readNumber(payload, ['priority']) ?? undefined,
      assigneeId: readString(payload, ['assignee_id', 'assigneeId']) || undefined,
      projectId: readString(payload, ['project_id', 'projectId']) || undefined,
      parentId: readString(payload, ['parent_id', 'parentId']) || undefined,
      labelIds: asStringArray(payload.labelIds).length ? asStringArray(payload.labelIds) : undefined,
    };
    const data = await this.linearGraphQL<{ issueCreate: { success: boolean; issue: any } }>(ctx, 'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }', { input });
    return success(this.provider, 'create_issue', mode, {
      id: data.issueCreate.issue.id,
      identifier: data.issueCreate.issue.identifier,
      title: data.issueCreate.issue.title,
      url: data.issueCreate.issue.url,
    }, [String(data.issueCreate.issue.id)], 'done', 'created linear issue');
  }

  private async resolveStateId(ctx: ExecutionContext, payload: Record<string, unknown>, teamId: string | undefined): Promise<string | undefined> {
    const stateId = readString(payload, ['state_id', 'stateId']);
    if (stateId) return stateId;
    const stateName = readString(payload, ['state_name', 'stateName']);
    if (!stateName || !teamId) return undefined;
    const data = await this.linearGraphQL<{ issueStates: { nodes: Array<{ id: string; name: string }> } }>(ctx, 'query States($teamId: String!) { issueStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }', { teamId });
    return data.issueStates.nodes.find((state) => state.name.toLowerCase() === stateName.toLowerCase())?.id;
  }

  private async updateStatus(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const issueId = readString(payload, ['issue_id', 'issueId', 'id']);
    const teamId = readString(payload, ['team_id', 'teamId']);
    if (!issueId) throw new IntegrationError('missing_issue_id', 'issueId is required', false);
    const stateId = await this.resolveStateId(ctx, payload, teamId);
    if (!stateId) throw new IntegrationError('missing_state', 'stateId or stateName is required', false);
    const data = await this.linearGraphQL<{ issueUpdate: { success: boolean; issue: any } }>(ctx, 'mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url state { id name } } } }', { id: issueId, input: { stateId } });
    return success(this.provider, 'update_status', mode, {
      id: data.issueUpdate.issue.id,
      identifier: data.issueUpdate.issue.identifier,
      title: data.issueUpdate.issue.title,
      url: data.issueUpdate.issue.url,
      state: data.issueUpdate.issue.state,
    }, [String(data.issueUpdate.issue.id)], 'done', 'updated linear issue status');
  }

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    try {
      const action = ctx.action === 'update_issue' ? 'update_status' : ctx.action;
      if (action === 'inspect') return await this.listIssues(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'list_issues') return await this.listIssues(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'create_issue') return await this.createIssue(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'update_status') return await this.updateStatus(ctx.ctx, ctx.mode, ctx.payload);
      throw new IntegrationError('unsupported_action', 'unsupported linear action: ' + ctx.action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class NotionIntegrationAdapter {
  provider = 'notion';
  actions = ['query_database', 'create_page', 'append_blocks', 'inspect', 'append'];

  private notionConfig(ctx: ExecutionContext): { token: string; version: string } {
    const token = notionToken(ctx);
    if (!token) throw new IntegrationError('auth_missing', 'notion token is required', false);
    return { token, version: '2022-06-28' };
  }

  private async notionFetch<T>(ctx: ExecutionContext, method: string, path: string, body?: unknown): Promise<T> {
    const { token, version } = this.notionConfig(ctx);
    const response = await requestJson<T>(
      'https://api.notion.com/v1' + path,
      {
        method,
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/json',
          'content-type': 'application/json',
          'notion-version': version,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { attempts: 3, retryableStatuses: [429, 500, 502, 503, 504] },
    );
    return response.data;
  }

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    try {
      const payload = ctx.payload;
      if (ctx.action === 'inspect' || ctx.action === 'query_database') {
        const databaseId = readString(payload, ['database_id', 'databaseId']);
        if (!databaseId) throw new IntegrationError('missing_database_id', 'database_id is required', false);
        const query = asRecord(payload.filter ?? payload.query ?? {});
        const sorts = readArray(payload, ['sorts']);
        const pageSize = readNumber(payload, ['page_size', 'pageSize'], 10) ?? 10;
        const data = await this.notionFetch<any>(ctx.ctx, 'POST', '/databases/' + databaseId + '/query', {
          filter: Object.keys(query).length ? query : undefined,
          sorts: sorts.length ? sorts : undefined,
          page_size: pageSize,
        });
        const pages = Array.isArray(data.results) ? data.results.map((page) => ({ id: page.id, url: page.url, createdTime: page.created_time, lastEditedTime: page.last_edited_time, properties: page.properties })) : [];
        return success(this.provider, 'query_database', ctx.mode, { databaseId, pages, hasMore: data.has_more, nextCursor: data.next_cursor }, pages.map((page) => String(page.id)), 'continue', 'queried notion database');
      }

      if (ctx.action === 'create_page') {
        const databaseId = readString(payload, ['database_id', 'databaseId']);
        if (!databaseId) throw new IntegrationError('missing_database_id', 'database_id is required', false);
        const properties = asRecord(payload.properties);
        const title = readString(payload, ['title', 'name']);
        const titleProperty = readString(payload, ['title_property', 'titleProperty'], 'Name') || 'Name';
        const pagePayload = {
          parent: { database_id: databaseId },
          properties: Object.keys(properties).length ? properties : (title ? { [titleProperty]: { title: [{ text: { content: title } }] } } : undefined),
          children: readArray(payload, ['children']).length ? readArray(payload, ['children']) : undefined,
        };
        const data = await this.notionFetch<any>(ctx.ctx, 'POST', '/pages', pagePayload);
        return success(this.provider, 'create_page', ctx.mode, { id: data.id, url: data.url, properties: data.properties }, [String(data.id)], 'done', 'created notion page');
      }

      if (ctx.action === 'append_blocks' || ctx.action === 'append') {
        const blockId = readString(payload, ['block_id', 'blockId', 'page_id', 'pageId']);
        const children = readArray(payload, ['children', 'blocks']);
        if (!blockId) throw new IntegrationError('missing_block_id', 'block_id is required', false);
        if (!children.length) throw new IntegrationError('missing_children', 'children is required', false);
        const data = await this.notionFetch<any>(ctx.ctx, 'PATCH', '/blocks/' + blockId + '/children', { children });
        return success(this.provider, 'append_blocks', ctx.mode, { blockId, children: data.results ?? [] }, [blockId], 'done', 'appended notion blocks');
      }

      throw new IntegrationError('unsupported_action', 'unsupported notion action: ' + ctx.action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class VercelIntegrationAdapter {
  provider = 'vercel';
  actions = ['list_deployments', 'get_build_logs', 'inspect', 'deploy'];

  private async vercelFetch<T>(ctx: ExecutionContext, path: string): Promise<T> {
    const token = vercelToken(ctx);
    if (!token) throw new IntegrationError('auth_missing', 'vercel token is required', false);
    const response = await requestJson<T>(
      'https://api.vercel.com' + path,
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/json',
        },
      },
      { attempts: 3, retryableStatuses: [429, 500, 502, 503, 504] },
    );
    return response.data;
  }

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    try {
      const payload = ctx.payload;
      if (ctx.action === 'inspect' || ctx.action === 'list_deployments') {
        const teamId = readString(payload, ['team_id', 'teamId']);
        const projectId = readString(payload, ['project_id', 'projectId']);
        const limit = readNumber(payload, ['limit', 'page_size', 'pageSize'], 10) ?? 10;
        const query = new URLSearchParams({ limit: String(limit) });
        if (teamId) query.set('teamId', teamId);
        if (projectId) query.set('projectId', projectId);
        const data = await this.vercelFetch<any>('/v13/deployments?' + query.toString());
        const deployments = Array.isArray(data.deployments) ? data.deployments.map((deployment) => ({
          id: deployment.uid ?? deployment.id,
          name: deployment.name,
          url: deployment.url,
          state: deployment.state,
          createdAt: deployment.createdAt,
          target: deployment.target,
          projectId: deployment.projectId,
          meta: deployment.meta,
        })) : [];
        return success(this.provider, 'list_deployments', ctx.mode, { deployments, pagination: data.pagination ?? null }, deployments.map((deployment) => String(deployment.id)), 'continue', 'listed vercel deployments');
      }

      if (ctx.action === 'get_build_logs') {
        const deploymentId = readString(payload, ['deployment_id', 'deploymentId', 'id']);
        if (!deploymentId) throw new IntegrationError('missing_deployment_id', 'deployment_id is required', false);
        const limit = readNumber(payload, ['limit'], 100) ?? 100;
        const data = await this.vercelFetch<any>('/v2/deployments/' + encodeURIComponent(deploymentId) + '/logs?limit=' + String(limit));
        const logs = Array.isArray(data.logs) ? data.logs : Array.isArray(data.data) ? data.data : data;
        return success(this.provider, 'get_build_logs', ctx.mode, { deploymentId, logs }, [deploymentId], 'continue', 'retrieved vercel build logs');
      }

      throw new IntegrationError('unsupported_action', 'unsupported vercel action: ' + ctx.action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class IntegrationRegistry {
  private readonly adapters = new Map<string, { actions: string[]; execute(ctx: IntegrationActionContext): Promise<SkillResult> }>();

  constructor() {
    this.register(new GithubIntegrationAdapter());
    this.register(new TodoistIntegrationAdapter());
    this.register(new LinearIntegrationAdapter());
    this.register(new NotionIntegrationAdapter());
    this.register(new VercelIntegrationAdapter());
  }

  register(adapter: { provider: string; actions: string[]; execute(ctx: IntegrationActionContext): Promise<SkillResult> }) {
    this.adapters.set(adapter.provider, adapter);
  }

  resolve(provider: string) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new IntegrationError('unsupported_provider', 'unsupported integration provider: ' + provider, false);
    return adapter;
  }
}

function normalizeMode(value: unknown, action: string): IntegrationMode {
  const mode = asString(value).toLowerCase();
  if (mode === 'read' || mode === 'write' || mode === 'dry-run' || mode === 'compensate') return mode;
  return action === 'list_issues' || action === 'list_pull_requests' || action === 'list_tasks' || action === 'query_database' || action === 'list_deployments' || action === 'get_build_logs' || action === 'inspect' ? 'read' : 'write';
}

export class IntegrationSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'integration',
    domain: 'external-integrations',
    capabilities: ['github', 'todoist', 'linear', 'notion', 'vercel'],
    version: '2.0.0',
  };

  private readonly registry = new IntegrationRegistry();

  canHandle(step: PlanStep): boolean {
    return step.skill === 'integration';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const provider = asString(ctx.step.args.provider) || 'github';
    const action = asString(ctx.step.args.action) || 'inspect';
    const mode = normalizeMode(ctx.step.args.mode, action);
    const payload = providerPayload(ctx);
    const adapter = this.registry.resolve(provider);
    if (!adapter.actions.includes(action)) {
      throw new IntegrationError('unsupported_action', 'unsupported action ' + action + ' for provider ' + provider, false);
    }
    return await adapter.execute({ provider, action, mode, payload, ctx });
  }

  async compensate(ctx: ExecutionContext): Promise<SkillResult> {
    return {
      ok: true,
      output: {
        provider: asString(ctx.step.args.provider) || 'github',
        action: asString(ctx.step.args.action) || 'inspect',
        mode: 'compensate',
        artifact: { compensated: false },
        nextAction: 'continue',
      },
      retryable: false,
      note: 'no provider compensation hook registered',
    };
  }
}

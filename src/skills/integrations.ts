import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import type { ConnectionSelector, ConnectionView } from '../connections/types.ts';
import { ConnectionLifecycleError } from '../connections/manager.ts';
import { getRuntimeServices, integrationPermissionScope } from '../runtime/services.ts';
import type { SkillAdapter } from './types';

type IntegrationMode = 'read' | 'write' | 'dry-run' | 'compensate';

type IntegrationActionContext = ExecutionContext & {
  provider: string;
  action: string;
  mode: IntegrationMode;
  payload: Record<string, unknown>;
  connection: ConnectionView;
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

function resolveAuthValue(connection: ConnectionView, keys: string[]): string | undefined {
  return findFirstString(connection.secrets ?? {}, keys);
}

function integrationConnectionSelector(provider: string, ctx: ExecutionContext): ConnectionSelector {
  const args = asRecord(ctx.step.args);
  const payload = providerPayload(ctx);

  const readSelector = (source: unknown): { connectionId?: string; accountId?: string; label?: string } | undefined => {
    if (!isRecord(source)) return undefined;
    const connectionId = readString(source, ['connectionId', 'connection_id', 'id']);
    const accountId = readString(source, ['accountId', 'account_id', 'account']);
    const label = readString(source, ['label', 'name']);
    if (!connectionId && !accountId && !label) return undefined;
    const selector: { connectionId?: string; accountId?: string; label?: string } = {};
    if (connectionId) selector.connectionId = connectionId;
    if (accountId) selector.accountId = accountId;
    if (label) selector.label = label;
    return selector;
  };

  return {
    provider,
    ...(readSelector(args.connection) ?? {}),
    ...(readSelector(args.credentials) ?? {}),
    ...(readSelector(args.auth) ?? {}),
    ...(readSelector(args.connectionSelector) ?? {}),
    ...(readSelector(payload.connection) ?? {}),
    ...(readSelector(payload.credentials) ?? {}),
    ...(readSelector(payload.auth) ?? {}),
    ...(readSelector(payload.connectionSelector) ?? {}),
  };
}

function integrationConnection(ctx: ExecutionContext): ConnectionView {
  const connection = (ctx as IntegrationActionContext).connection;
  if (!connection) {
    throw new IntegrationError('auth_missing', 'integration connection is required', false);
  }
  return connection;
}

async function resolveIntegrationConnection(provider: string, ctx: ExecutionContext): Promise<ConnectionView> {
  const { connectionManager } = getRuntimeServices();
  const selector = integrationConnectionSelector(provider, ctx);

  try {
    const connection = await connectionManager.getConnection(selector, { includeSecrets: true, autoRefresh: true });
    if (!connection) {
      throw new IntegrationError('auth_missing', provider + ' connection is required', false, undefined, { provider, selector });
    }
    if (!connection.secrets) {
      throw new IntegrationError('auth_missing', provider + ' connection does not expose secrets', false, undefined, { provider, connectionId: connection.connectionId });
    }
    return connection;
  } catch (error) {
    if (error instanceof ConnectionLifecycleError) {
      throw new IntegrationError('auth_missing', error.message, false, undefined, { provider, selector, code: error.code });
    }
    throw error;
  }
}

async function emitIntegrationTelemetry(topic: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await getRuntimeServices().eventBus.publish({ topic, source: 'skill', payload });
  } catch {
    // telemetry must never block execution
  }
}

function ensureIntegrationPermission(provider: string, action: string, connection: ConnectionView): void {
  const { permissionRegistry } = getRuntimeServices();
  const decision = permissionRegistry.authorize({ subject: 'integration', action: integrationPermissionScope(action), provider }, connection.scopes);
  if (!decision.allowed) {
    throw new IntegrationError('permission_denied', provider + ' connection is missing required scopes: ' + decision.missingScopes.join(', '), false, 403, {
      provider,
      action,
      requiredScopes: decision.requiredScopes,
      grantedScopes: decision.grantedScopes,
      missingScopes: decision.missingScopes,
      connectionId: connection.connectionId,
    });
  }
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

function failure(provider: string, action: string, mode: IntegrationMode, error: unknown): SkillResult {
  if (error instanceof IntegrationError) {
    return {
      ok: false,
      output: {
        provider,
        action,
        mode,
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
      mode,
      artifact: { message },
      nextAction: 'retry',
    },
    retryable: true,
    note: message,
    trace: { error: message },
  };
}

function githubToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(integrationConnection(ctx), ['token', 'accessToken', 'apiToken', 'githubToken', 'github_access_token']);
}

function todoistToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(integrationConnection(ctx), ['token', 'accessToken', 'apiToken', 'todoistToken']);
}

function linearToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(integrationConnection(ctx), ['token', 'accessToken', 'apiToken', 'linearToken', 'linearApiKey']);
}

function notionToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(integrationConnection(ctx), ['token', 'accessToken', 'apiToken', 'notionToken']);
}

function vercelToken(ctx: ExecutionContext): string | undefined {
  return resolveAuthValue(integrationConnection(ctx), ['token', 'accessToken', 'apiToken', 'vercelToken']);
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
  actions = ['list_tasks', 'create_task', 'update_task', 'complete_task', 'delete_task', 'add_comment', 'add_task'];

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

  private buildTaskBody(payload: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const content = readString(payload, ['content', 'title', 'text']);
    if (content) body.content = content;
    const description = readString(payload, ['description']);
    if (description) body.description = description;
    const projectId = readString(payload, ['project_id', 'projectId']);
    if (projectId) body.project_id = projectId;
    const sectionId = readString(payload, ['section_id', 'sectionId']);
    if (sectionId) body.section_id = sectionId;
    const parentId = readString(payload, ['parent_id', 'parentId']);
    if (parentId) body.parent_id = parentId;
    const assigneeId = readString(payload, ['assignee_id', 'assigneeId']);
    if (assigneeId) body.assignee_id = assigneeId;
    const priority = readNumber(payload, ['priority']);
    if (priority !== undefined) body.priority = priority;
    const labels = asStringArray(payload.labels ?? payload.labelIds ?? payload.label_ids);
    if (labels.length) body.labels = labels;
    const dueString = readString(payload, ['due_string', 'dueString']);
    if (dueString) body.due_string = dueString;
    const dueDate = readString(payload, ['due_date', 'dueDate']);
    if (dueDate) body.due_date = dueDate;
    const dueDateTime = readString(payload, ['due_datetime', 'dueDateTime']);
    if (dueDateTime) body.due_datetime = dueDateTime;
    return body;
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
        const body = this.buildTaskBody(payload);
        if (!body.content) throw new IntegrationError('missing_content', 'content is required', false);
        const response = await this.todoistFetch<any>(ctx.ctx, 'POST', '/tasks', body);
        return success(this.provider, 'create_task', ctx.mode, {
          id: response.data.id,
          content: response.data.content,
          projectId: response.data.project_id,
          url: response.data.url,
        }, [String(response.data.id)], 'done', 'created todoist task');
      }

      if (ctx.action === 'update_task') {
        const taskId = readString(payload, ['task_id', 'taskId', 'id']);
        if (!taskId) throw new IntegrationError('missing_task_id', 'task_id is required', false);
        const body = this.buildTaskBody(payload);
        delete body.content;
        if (!Object.keys(body).length) throw new IntegrationError('missing_update_fields', 'at least one task field must be provided', false);
        const response = await this.todoistFetch<any>(ctx.ctx, 'POST', '/tasks/' + encodeURIComponent(taskId), body);
        return success(this.provider, 'update_task', ctx.mode, {
          id: response.data.id,
          content: response.data.content,
          description: response.data.description,
          projectId: response.data.project_id,
          sectionId: response.data.section_id,
          parentId: response.data.parent_id,
          priority: response.data.priority,
          url: response.data.url,
          due: response.data.due,
          labels: response.data.labels ?? [],
          assigneeId: response.data.assignee_id,
          updatedAt: response.data.updated_at,
        }, [String(response.data.id)], 'done', 'updated todoist task');
      }

      if (ctx.action === 'complete_task') {
        const taskId = readString(payload, ['task_id', 'taskId', 'id']);
        if (!taskId) throw new IntegrationError('missing_task_id', 'task_id is required', false);
        await this.todoistFetch<unknown>(ctx.ctx, 'POST', '/tasks/' + encodeURIComponent(taskId) + '/close');
        return success(this.provider, 'complete_task', ctx.mode, { id: taskId, completed: true }, [taskId], 'done', 'completed todoist task');
      }

      if (ctx.action === 'delete_task') {
        const taskId = readString(payload, ['task_id', 'taskId', 'id']);
        if (!taskId) throw new IntegrationError('missing_task_id', 'task_id is required', false);
        await this.todoistFetch<unknown>(ctx.ctx, 'DELETE', '/tasks/' + encodeURIComponent(taskId));
        return success(this.provider, 'delete_task', ctx.mode, { id: taskId, deleted: true }, [taskId], 'done', 'deleted todoist task');
      }

      if (ctx.action === 'add_comment') {
        const taskId = readString(payload, ['task_id', 'taskId']);
        const projectId = readString(payload, ['project_id', 'projectId']);
        const content = readString(payload, ['content', 'body', 'text', 'comment']);
        if (!content) throw new IntegrationError('missing_content', 'content is required', false);
        if (!taskId && !projectId) throw new IntegrationError('missing_reference', 'task_id or project_id is required', false);
        const response = await this.todoistFetch<any>(ctx.ctx, 'POST', '/comments', {
          ...(taskId ? { task_id: taskId } : {}),
          ...(projectId ? { project_id: projectId } : {}),
          content,
        });
        return success(this.provider, 'add_comment', ctx.mode, {
          id: response.data.id,
          content: response.data.content,
          taskId: response.data.task_id,
          projectId: response.data.project_id,
          postedAt: response.data.posted_at,
        }, [String(response.data.id)], 'done', 'created todoist comment');
      }

      throw new IntegrationError('unsupported_action', 'unsupported todoist action: ' + ctx.action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class LinearIntegrationAdapter {
  provider = 'linear';
  actions = ['list_issues', 'create_issue', 'update_status', 'inspect', 'update_issue', 'create_comment', 'comment', 'merge_issue'];

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
      labelIds: asStringArray(payload.labelIds ?? payload.label_ids ?? payload.labels).length ? asStringArray(payload.labelIds ?? payload.label_ids ?? payload.labels) : undefined,
      cycleId: readString(payload, ['cycle_id', 'cycleId']) || undefined,
      estimate: readNumber(payload, ['estimate']) ?? undefined,
      dueDate: readString(payload, ['due_date', 'dueDate']) || undefined,
    };
    const data = await this.linearGraphQL<{ issueCreate: { success: boolean; issue: any } }>(ctx, 'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url state { id name type } team { id key name } assignee { id name email } } } }', { input });
    return success(this.provider, 'create_issue', mode, {
      id: data.issueCreate.issue.id,
      identifier: data.issueCreate.issue.identifier,
      title: data.issueCreate.issue.title,
      url: data.issueCreate.issue.url,
      state: data.issueCreate.issue.state,
      team: data.issueCreate.issue.team,
      assignee: data.issueCreate.issue.assignee,
    }, [String(data.issueCreate.issue.id)], 'done', 'created linear issue');
  }

  private async resolveStateId(ctx: ExecutionContext, payload: Record<string, unknown>, teamId: string | undefined): Promise<string | undefined> {
    const stateId = readString(payload, ['state_id', 'stateId']);
    if (stateId) return stateId;
    const stateName = readString(payload, ['state_name', 'stateName', 'status']);
    if (!stateName || !teamId) return undefined;
    const data = await this.linearGraphQL<{ issueStates: { nodes: Array<{ id: string; name: string }> } }>(ctx, 'query States($teamId: String!) { issueStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }', { teamId });
    return data.issueStates.nodes.find((state) => state.name.toLowerCase() === stateName.toLowerCase())?.id;
  }

  private async buildIssueUpdateInput(ctx: ExecutionContext, payload: Record<string, unknown>, teamId: string | undefined): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {};
    const title = readString(payload, ['title', 'name']);
    if (title) input.title = title;
    const description = readString(payload, ['description', 'body']);
    if (description) input.description = description;
    const priority = readNumber(payload, ['priority']);
    if (priority !== undefined) input.priority = priority;
    const assigneeId = readString(payload, ['assignee_id', 'assigneeId']);
    if (assigneeId) input.assigneeId = assigneeId;
    const projectId = readString(payload, ['project_id', 'projectId']);
    if (projectId) input.projectId = projectId;
    const parentId = readString(payload, ['parent_id', 'parentId']);
    if (parentId) input.parentId = parentId;
    const cycleId = readString(payload, ['cycle_id', 'cycleId']);
    if (cycleId) input.cycleId = cycleId;
    const estimate = readNumber(payload, ['estimate']);
    if (estimate !== undefined) input.estimate = estimate;
    const dueDate = readString(payload, ['due_date', 'dueDate']);
    if (dueDate) input.dueDate = dueDate;
    const labelIds = asStringArray(payload.labelIds ?? payload.label_ids ?? payload.labels);
    if (labelIds.length) input.labelIds = labelIds;
    const stateId = await this.resolveStateId(ctx, payload, teamId);
    if (stateId) input.stateId = stateId;
    const teamValue = readString(payload, ['team_id', 'teamId']);
    if (teamValue) input.teamId = teamValue;
    return input;
  }

  private async updateIssue(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const issueId = readString(payload, ['issue_id', 'issueId', 'id']);
    const teamId = readString(payload, ['team_id', 'teamId']);
    if (!issueId) throw new IntegrationError('missing_issue_id', 'issueId is required', false);
    const input = await this.buildIssueUpdateInput(ctx, payload, teamId);
    if (!Object.keys(input).length) throw new IntegrationError('missing_update_fields', 'at least one issue field must be provided', false);
    const data = await this.linearGraphQL<{ issueUpdate: { success: boolean; issue: any } }>(ctx, 'mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title description url state { id name type } team { id key name } assignee { id name email } createdAt updatedAt } } }', { id: issueId, input });
    return success(this.provider, 'update_issue', mode, {
      id: data.issueUpdate.issue.id,
      identifier: data.issueUpdate.issue.identifier,
      title: data.issueUpdate.issue.title,
      description: data.issueUpdate.issue.description,
      url: data.issueUpdate.issue.url,
      state: data.issueUpdate.issue.state,
      team: data.issueUpdate.issue.team,
      assignee: data.issueUpdate.issue.assignee,
      createdAt: data.issueUpdate.issue.createdAt,
      updatedAt: data.issueUpdate.issue.updatedAt,
    }, [String(data.issueUpdate.issue.id)], 'done', 'updated linear issue');
  }

  private async updateStatus(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const issueId = readString(payload, ['issue_id', 'issueId', 'id']);
    if (!issueId) throw new IntegrationError('missing_issue_id', 'issueId is required', false);
    const stateValue = readString(payload, ['state_id', 'stateId', 'state_name', 'stateName', 'status']);
    if (!stateValue) throw new IntegrationError('missing_state', 'stateId or stateName is required', false);
    return await this.updateIssue(ctx, mode, { ...payload, state_name: stateValue });
  }

  private async createComment(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const issueId = readString(payload, ['issue_id', 'issueId', 'id']);
    const body = readString(payload, ['body', 'comment', 'text', 'content']);
    if (!issueId) throw new IntegrationError('missing_issue_id', 'issueId is required', false);
    if (!body) throw new IntegrationError('missing_body', 'body is required', false);
    const data = await this.linearGraphQL<{ commentCreate: { success: boolean; comment: any } }>(ctx, 'mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body url createdAt updatedAt issue { id identifier title } user { id name email } } } }', { input: { issueId, body } });
    return success(this.provider, 'create_comment', mode, {
      id: data.commentCreate.comment.id,
      body: data.commentCreate.comment.body,
      url: data.commentCreate.comment.url,
      issue: data.commentCreate.comment.issue,
      user: data.commentCreate.comment.user,
      createdAt: data.commentCreate.comment.createdAt,
      updatedAt: data.commentCreate.comment.updatedAt,
    }, [String(data.commentCreate.comment.id), issueId], 'done', 'created linear comment');
  }

  private async mergeIssue(ctx: ExecutionContext, mode: IntegrationMode, payload: Record<string, unknown>): Promise<SkillResult> {
    const issueId = readString(payload, ['issue_id', 'issueId', 'id']);
    if (!issueId) throw new IntegrationError('missing_issue_id', 'issueId is required', false);
    const status = readString(payload, ['state_id', 'stateId', 'state_name', 'stateName', 'status']) || 'Done';
    return await this.updateIssue(ctx, mode, { ...payload, issue_id: issueId, state_name: status });
  }

  async execute(ctx: IntegrationActionContext): Promise<SkillResult> {
    try {
      const action = ctx.action === 'comment' ? 'create_comment' : ctx.action;
      if (action === 'inspect') return await this.listIssues(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'list_issues') return await this.listIssues(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'create_issue') return await this.createIssue(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'update_status') return await this.updateStatus(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'update_issue') return await this.updateIssue(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'create_comment') return await this.createComment(ctx.ctx, ctx.mode, ctx.payload);
      if (action === 'merge_issue') return await this.mergeIssue(ctx.ctx, ctx.mode, ctx.payload);
      throw new IntegrationError('unsupported_action', 'unsupported linear action: ' + ctx.action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class NotionIntegrationAdapter {
  provider = 'notion';
  actions = ['query_database', 'create_page', 'append_blocks', 'inspect', 'append', 'update_page', 'update_block', 'add_comment'];

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

  private buildCommentRichText(payload: Record<string, unknown>): Array<Record<string, unknown>> {
    const richText = payload.rich_text ?? payload.richText;
    if (Array.isArray(richText) && richText.length) return richText as Array<Record<string, unknown>>;
    const content = readString(payload, ['content', 'body', 'text', 'comment']);
    if (!content) return [];
    return [{ type: 'text', text: { content } }];
  }

  private buildBlockUpdateBody(payload: Record<string, unknown>): Record<string, unknown> {
    const reserved = new Set(['block_id', 'blockId', 'page_id', 'pageId', 'id', 'children', 'content', 'body', 'text', 'comment']);
    const direct = asRecord(payload.block ?? payload.data ?? payload.fields ?? payload.update);
    if (Object.keys(direct).length) return direct;
    return Object.fromEntries(Object.entries(payload).filter(([key]) => !reserved.has(key)));
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

      if (ctx.action === 'update_page') {
        const pageId = readString(payload, ['page_id', 'pageId', 'id']);
        if (!pageId) throw new IntegrationError('missing_page_id', 'page_id is required', false);
        const properties = asRecord(payload.properties);
        const pageUpdate: Record<string, unknown> = {};
        if (Object.keys(properties).length) pageUpdate.properties = properties;
        const archived = payload.archived;
        if (typeof archived === 'boolean') pageUpdate.archived = archived;
        const icon = asRecord(payload.icon);
        if (Object.keys(icon).length) pageUpdate.icon = icon;
        const cover = asRecord(payload.cover);
        if (Object.keys(cover).length) pageUpdate.cover = cover;
        if (!Object.keys(pageUpdate).length) throw new IntegrationError('missing_update_fields', 'at least one page field must be provided', false);
        const data = await this.notionFetch<any>(ctx.ctx, 'PATCH', '/pages/' + pageId, pageUpdate);
        return success(this.provider, 'update_page', ctx.mode, { id: data.id, url: data.url, properties: data.properties, archived: data.archived }, [String(data.id)], 'done', 'updated notion page');
      }

      if (ctx.action === 'append_blocks' || ctx.action === 'append') {
        const blockId = readString(payload, ['block_id', 'blockId', 'page_id', 'pageId']);
        const children = readArray(payload, ['children', 'blocks']);
        if (!blockId) throw new IntegrationError('missing_block_id', 'block_id is required', false);
        if (!children.length) throw new IntegrationError('missing_children', 'children is required', false);
        const data = await this.notionFetch<any>(ctx.ctx, 'PATCH', '/blocks/' + blockId + '/children', { children });
        return success(this.provider, 'append_blocks', ctx.mode, { blockId, children: data.results ?? [] }, [blockId], 'done', 'appended notion blocks');
      }

      if (ctx.action === 'update_block') {
        const blockId = readString(payload, ['block_id', 'blockId', 'id']);
        if (!blockId) throw new IntegrationError('missing_block_id', 'block_id is required', false);
        const blockUpdate = this.buildBlockUpdateBody(payload);
        if (!Object.keys(blockUpdate).length) throw new IntegrationError('missing_update_fields', 'at least one block field must be provided', false);
        const data = await this.notionFetch<any>(ctx.ctx, 'PATCH', '/blocks/' + blockId, blockUpdate);
        return success(this.provider, 'update_block', ctx.mode, { id: data.id, archived: data.archived, type: data.type, block: data }, [String(data.id)], 'done', 'updated notion block');
      }

      if (ctx.action === 'add_comment') {
        const pageId = readString(payload, ['page_id', 'pageId', 'parent_id', 'parentId', 'block_id', 'blockId']);
        const discussionId = readString(payload, ['discussion_id', 'discussionId']);
        const richText = this.buildCommentRichText(payload);
        if (!pageId && !discussionId) throw new IntegrationError('missing_page_id', 'page_id is required', false);
        if (!richText.length) throw new IntegrationError('missing_content', 'content is required', false);
        const commentPayload: Record<string, unknown> = {
          rich_text: richText,
          ...(discussionId ? { parent: { discussion_id: discussionId } } : { parent: { page_id: pageId } }),
        };
        const data = await this.notionFetch<any>(ctx.ctx, 'POST', '/comments', commentPayload);
        return success(this.provider, 'add_comment', ctx.mode, { id: data.id, discussionId: data.discussion_id, parent: data.parent, richText: data.rich_text, createdTime: data.created_time }, [String(data.id)], 'done', 'created notion comment');
      }

      throw new IntegrationError('unsupported_action', 'unsupported notion action: ' + ctx.action, false);
    } catch (error) {
      return failure(this.provider, ctx.action, error);
    }
  }
}

class VercelIntegrationAdapter {
  provider = 'vercel';
  actions = ['list_deployments', 'get_build_logs', 'inspect', 'deploy', 'create_deployment', 'update_deployment', 'add_comment', 'cancel_deployment'];

  private async vercelFetch<T>(ctx: ExecutionContext, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Headers; data: T }> {
    const token = vercelToken(ctx);
    if (!token) throw new IntegrationError('auth_missing', 'vercel token is required', false);
    const response = await requestJson<T>(
      'https://api.vercel.com' + path,
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

  private async vercelFetchFallback<T>(ctx: ExecutionContext, attempts: Array<{ method: string; path: string; body?: unknown }>): Promise<{ status: number; headers: Headers; data: T }> {
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        return await this.vercelFetch<T>(ctx, attempt.method, attempt.path, attempt.body);
      } catch (error) {
        lastError = error;
        if (error instanceof IntegrationError && error.status && [404, 405, 409, 422].includes(error.status)) continue;
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new IntegrationError('request_failed', 'vercel request failed', true);
  }

  private buildDeploymentBody(payload: Record<string, unknown>): Record<string, unknown> {
    const source = asRecord(payload.deployment ?? payload.data ?? payload.body ?? payload.input ?? payload);
    const body: Record<string, unknown> = {};
    const name = readString(source, ['name']);
    if (name) body.name = name;
    const project = readString(source, ['project', 'projectId']);
    if (project) body.project = project;
    const target = readString(source, ['target']);
    if (target) body.target = target;
    const gitSource = asRecord(source.gitSource);
    if (Object.keys(gitSource).length) body.gitSource = gitSource;
    const meta = asRecord(source.meta);
    if (Object.keys(meta).length) body.meta = meta;
    const files = Array.isArray(source.files) ? source.files : [];
    if (files.length) body.files = files;
    const deletedFiles = Array.isArray(source.deletedFiles) ? source.deletedFiles : [];
    if (deletedFiles.length) body.deletedFiles = deletedFiles;
    const buildCommand = readString(source, ['buildCommand']);
    if (buildCommand) body.buildCommand = buildCommand;
    const ignoreCommand = readString(source, ['ignoreCommand']);
    if (ignoreCommand) body.ignoreCommand = ignoreCommand;
    const installCommand = readString(source, ['installCommand']);
    if (installCommand) body.installCommand = installCommand;
    const outputDirectory = readString(source, ['outputDirectory']);
    if (outputDirectory) body.outputDirectory = outputDirectory;
    const publicValue = source.public;
    if (typeof publicValue === 'boolean') body.public = publicValue;
    const skipAutoDetection = source.skipAutoDetection;
    if (typeof skipAutoDetection === 'boolean') body.skipAutoDetection = skipAutoDetection;
    const regions = Array.isArray(source.regions) ? source.regions : [];
    if (regions.length) body.regions = regions;
    const routeAliases = Array.isArray(source.routeAliases) ? source.routeAliases : [];
    if (routeAliases.length) body.routeAliases = routeAliases;
    const cleanUrls = source.cleanUrls;
    if (typeof cleanUrls === 'boolean') body.cleanUrls = cleanUrls;
    const trailingSlash = source.trailingSlash;
    if (typeof trailingSlash === 'boolean') body.trailingSlash = trailingSlash;
    const framework = readString(source, ['framework']);
    if (framework) body.framework = framework;
    const env = Array.isArray(source.env) ? source.env : [];
    if (env.length) body.env = env;
    return body;
  }

  private buildDeploymentCommentBody(payload: Record<string, unknown>): Record<string, unknown> {
    const content = readString(payload, ['content', 'body', 'text', 'comment']);
    if (!content) throw new IntegrationError('missing_content', 'content is required', false);
    return { content };
  }

  private buildDeploymentUpdateBody(payload: Record<string, unknown>): Record<string, unknown> {
    const source = asRecord(payload.deployment ?? payload.data ?? payload.body ?? payload.input ?? payload);
    const body: Record<string, unknown> = {};
    const name = readString(source, ['name']);
    if (name) body.name = name;
    const target = readString(source, ['target']);
    if (target) body.target = target;
    const meta = asRecord(source.meta);
    if (Object.keys(meta).length) body.meta = meta;
    const project = readString(source, ['project', 'projectId']);
    if (project) body.project = project;
    const publicValue = source.public;
    if (typeof publicValue === 'boolean') body.public = publicValue;
    return body;
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
        const response = await this.vercelFetch<any>(ctx.ctx, 'GET', '/v13/deployments?' + query.toString());
        const deployments = Array.isArray(response.data.deployments) ? response.data.deployments.map((deployment) => ({
          id: deployment.uid ?? deployment.id,
          name: deployment.name,
          url: deployment.url,
          state: deployment.state,
          createdAt: deployment.createdAt,
          target: deployment.target,
          projectId: deployment.projectId,
          meta: deployment.meta,
        })) : [];
        return success(this.provider, 'list_deployments', ctx.mode, { deployments, pagination: response.data.pagination ?? null }, deployments.map((deployment) => String(deployment.id)), 'continue', 'listed vercel deployments');
      }

      if (ctx.action === 'get_build_logs') {
        const deploymentId = readString(payload, ['deployment_id', 'deploymentId', 'id']);
        if (!deploymentId) throw new IntegrationError('missing_deployment_id', 'deployment_id is required', false);
        const limit = readNumber(payload, ['limit'], 100) ?? 100;
        const response = await this.vercelFetch<any>(ctx.ctx, 'GET', '/v2/deployments/' + encodeURIComponent(deploymentId) + '/logs?limit=' + String(limit));
        const logs = Array.isArray(response.data.logs) ? response.data.logs : Array.isArray(response.data.data) ? response.data.data : response.data;
        return success(this.provider, 'get_build_logs', ctx.mode, { deploymentId, logs }, [deploymentId], 'continue', 'retrieved vercel build logs');
      }

      if (ctx.action === 'create_deployment' || ctx.action === 'deploy') {
        const body = this.buildDeploymentBody(payload);
        const response = await this.vercelFetch<any>(ctx.ctx, 'POST', '/v13/deployments', body);
        const deployment = response.data.deployment ?? response.data;
        return success(this.provider, 'create_deployment', ctx.mode, {
          id: deployment.uid ?? deployment.id,
          url: deployment.url,
          name: deployment.name,
          state: deployment.state,
          createdAt: deployment.createdAt,
          target: deployment.target,
          meta: deployment.meta,
        }, [String(deployment.uid ?? deployment.id ?? '')].filter(Boolean), 'done', 'created vercel deployment');
      }

      if (ctx.action === 'update_deployment') {
        const deploymentId = readString(payload, ['deployment_id', 'deploymentId', 'id']);
        if (!deploymentId) throw new IntegrationError('missing_deployment_id', 'deployment_id is required', false);
        const body = this.buildDeploymentUpdateBody(payload);
        if (!Object.keys(body).length) throw new IntegrationError('missing_update_fields', 'at least one deployment field must be provided', false);
        const response = await this.vercelFetchFallback<any>(ctx.ctx, [
          { method: 'PATCH', path: '/v13/deployments/' + encodeURIComponent(deploymentId) + '/meta', body: body.meta ? { meta: body.meta } : body },
          { method: 'PATCH', path: '/v13/deployments/' + encodeURIComponent(deploymentId), body },
        ]);
        const deployment = response.data.deployment ?? response.data;
        return success(this.provider, 'update_deployment', ctx.mode, {
          id: deployment.uid ?? deployment.id ?? deploymentId,
          url: deployment.url,
          name: deployment.name,
          state: deployment.state,
          createdAt: deployment.createdAt,
          target: deployment.target,
          meta: deployment.meta,
        }, [String(deployment.uid ?? deployment.id ?? deploymentId)], 'done', 'updated vercel deployment');
      }

      if (ctx.action === 'add_comment') {
        const deploymentId = readString(payload, ['deployment_id', 'deploymentId', 'id']);
        if (!deploymentId) throw new IntegrationError('missing_deployment_id', 'deployment_id is required', false);
        const body = this.buildDeploymentCommentBody(payload);
        const response = await this.vercelFetchFallback<any>(ctx.ctx, [
          { method: 'POST', path: '/v13/deployments/' + encodeURIComponent(deploymentId) + '/comments', body },
          { method: 'POST', path: '/v12/deployments/' + encodeURIComponent(deploymentId) + '/comments', body },
          { method: 'POST', path: '/v6/deployments/' + encodeURIComponent(deploymentId) + '/comments', body },
        ]);
        return success(this.provider, 'add_comment', ctx.mode, {
          deploymentId,
          comment: response.data.comment ?? response.data,
          id: response.data.comment?.id ?? response.data.id,
        }, [deploymentId, String(response.data.comment?.id ?? response.data.id ?? '')].filter(Boolean), 'done', 'created vercel deployment comment');
      }

      if (ctx.action === 'cancel_deployment') {
        const deploymentId = readString(payload, ['deployment_id', 'deploymentId', 'id']);
        if (!deploymentId) throw new IntegrationError('missing_deployment_id', 'deployment_id is required', false);
        const response = await this.vercelFetchFallback<any>(ctx.ctx, [
          { method: 'POST', path: '/v13/deployments/' + encodeURIComponent(deploymentId) + '/cancel' },
          { method: 'POST', path: '/v12/deployments/' + encodeURIComponent(deploymentId) + '/cancel' },
        ]);
        return success(this.provider, 'cancel_deployment', ctx.mode, {
          deploymentId,
          status: response.data.state ?? response.data.status ?? 'canceled',
          deployment: response.data.deployment ?? response.data,
        }, [deploymentId], 'done', 'canceled vercel deployment');
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

    await emitIntegrationTelemetry('skill.integration.started', {
      provider,
      action,
      mode,
      taskId: ctx.taskId,
      stepId: ctx.step.id,
    });

    try {
      const connection = await resolveIntegrationConnection(provider, ctx);
      ensureIntegrationPermission(provider, action, connection);
      const actionContext: IntegrationActionContext = {
        ...ctx,
        provider,
        action,
        mode,
        payload,
        connection,
      };
      if (mode === 'compensate') {
        return await this.compensate(actionContext);
      }
      const result = await adapter.execute(actionContext);
      await emitIntegrationTelemetry('skill.integration.completed', {
        provider,
        action,
        mode,
        taskId: ctx.taskId,
        stepId: ctx.step.id,
        connectionId: connection.connectionId,
        ok: result.ok,
        note: result.note ?? null,
      });
      return result;
    } catch (error) {
      const failed = failure(provider, action, mode, error);
      await emitIntegrationTelemetry('skill.integration.failed', {
        provider,
        action,
        mode,
        taskId: ctx.taskId,
        stepId: ctx.step.id,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });
      return failed;
    }
  }

  async compensate(ctx: ExecutionContext): Promise<SkillResult> {
    const actionContext = ctx as IntegrationActionContext;
    const provider = asString(actionContext.provider || actionContext.step.args.provider) || 'github';
    const action = asString(actionContext.action || actionContext.step.args.action) || 'inspect';
    const payload = providerPayload(actionContext);
    const rollback = asRecord(payload.rollback ?? payload.previous ?? payload.before ?? payload.snapshot ?? payload.state);

    if (provider === 'github') {
      const { owner, repo } = parseRepo(payload);
      const issueNumber = readNumber(payload, ['issue_number', 'issueNumber', 'number']) ?? readNumber(rollback, ['issue_number', 'issueNumber', 'number']);
      const commentId = readNumber(payload, ['comment_id', 'commentId']) ?? readNumber(rollback, ['comment_id', 'commentId']);
      const pathName = readString(payload, ['path', 'filePath']) || readString(rollback, ['path', 'filePath']);
      const branch = readString(payload, ['branch'], 'main') || readString(rollback, ['branch'], 'main') || 'main';
      const previousContent = readString(rollback, ['content', 'previousContent', 'body', 'text']);
      const previousSha = readString(rollback, ['sha', 'previousSha', 'blobSha']);
      if ((action === 'create_issue' || action === 'comment') && (issueNumber || commentId)) {
        const token = githubToken(actionContext);
        if (!token) throw new IntegrationError('auth_missing', 'github token is required', false);
        const method = action === 'comment' ? 'DELETE' : 'PATCH';
        const path = action === 'comment' ? '/repos/' + owner + '/' + repo + '/issues/comments/' + commentId : '/repos/' + owner + '/' + repo + '/issues/' + issueNumber;
        await requestJson<unknown>('https://api.github.com' + path, { method, headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(action === 'comment' ? {} : { 'content-type': 'application/json' }) }, body: action === 'comment' ? undefined : JSON.stringify({ state: 'closed' }) }, { attempts: 3, retryableStatuses: [429, 500, 502, 503, 504] });
        return success(this.provider, action, 'compensate', { rolledBack: true, provider, action, status: 'closed' }, [String(issueNumber ?? ''), String(commentId ?? '')].filter(Boolean), 'done', 'rolled back github state');
      }
      if ((action === 'upsert_file' || action === 'delete_file') && pathName && previousContent) {
        const token = githubToken(actionContext);
        if (!token) throw new IntegrationError('auth_missing', 'github token is required', false);
        const response = await requestJson<any>('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + encodePath(pathName), { method: 'PUT', headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' }, body: JSON.stringify({ message: 'revert file after failed step', branch, content: base64(previousContent), sha: previousSha || undefined }) }, { attempts: 3, retryableStatuses: [429, 500, 502, 503, 504] });
        return success(this.provider, action, 'compensate', { rolledBack: true, provider, action, path: pathName, commitSha: response.data.commit?.sha, contentSha: response.data.content?.sha }, [String(response.data.commit?.sha ?? ''), String(response.data.content?.sha ?? '')].filter(Boolean), 'done', 'restored github file state');
      }
      throw new IntegrationError('missing_rollback_context', 'github compensation requires issue, comment, or file rollback context', false);
    }

    if (provider === 'todoist') {
      const todoist = new TodoistIntegrationAdapter();
      const taskId = readString(payload, ['task_id', 'taskId', 'id']) || readString(rollback, ['task_id', 'taskId', 'id']);
      if (!taskId) throw new IntegrationError('missing_rollback_context', 'todoist compensation requires a task id', false);
      if (action === 'create_task' || action === 'add_task' || action === 'delete_task') return await todoist.execute({ ...actionContext, action: 'delete_task', payload: { ...payload, task_id: taskId }, mode: 'compensate' } as IntegrationActionContext);
      if (action === 'update_task' && Object.keys(rollback).length > 0) return await todoist.execute({ ...actionContext, action: 'update_task', payload: { ...rollback, task_id: taskId }, mode: 'compensate' } as IntegrationActionContext);
      return success(provider, action, 'compensate', { compensated: false, reason: 'no revert action for todoist state change' }, [taskId], 'continue', 'todoist compensation not applicable');
    }

    if (provider === 'linear') {
      const linear = new LinearIntegrationAdapter();
      const issueId = readString(payload, ['issue_id', 'issueId', 'id']) || readString(rollback, ['issue_id', 'issueId', 'id']);
      const restoredStateId = readString(rollback, ['state_id', 'stateId', 'previousStateId']);
      const restoredStateName = readString(rollback, ['state_name', 'stateName', 'previousStateName']);
      if (!issueId || (!restoredStateId && !restoredStateName)) throw new IntegrationError('missing_rollback_context', 'linear compensation requires an issue id and previous state snapshot', false);
      return await linear.execute({ ...actionContext, action: 'update_issue', payload: { ...payload, issue_id: issueId, state_id: restoredStateId || undefined, state_name: restoredStateName || undefined }, mode: 'compensate' } as IntegrationActionContext);
    }

    if (provider === 'notion') {
      const notion = new NotionIntegrationAdapter();
      const pageId = readString(payload, ['page_id', 'pageId', 'id']) || readString(rollback, ['page_id', 'pageId', 'id']);
      const blockId = readString(payload, ['block_id', 'blockId', 'id']) || readString(rollback, ['block_id', 'blockId', 'id']);
      if ((action === 'create_page' || action === 'update_page') && pageId) return await notion.execute({ ...actionContext, action: 'update_page', payload: { ...payload, page_id: pageId, archived: true }, mode: 'compensate' } as IntegrationActionContext);
      if ((action === 'append_blocks' || action === 'append' || action === 'update_block') && blockId && Object.keys(rollback).length > 0) return await notion.execute({ ...actionContext, action: 'update_block', payload: { ...rollback, block_id: blockId, archived: true }, mode: 'compensate' } as IntegrationActionContext);
      throw new IntegrationError('missing_rollback_context', 'notion compensation requires a page or block snapshot', false);
    }

    if (provider === 'vercel') {
      const vercel = new VercelIntegrationAdapter();
      const deploymentId = readString(payload, ['deployment_id', 'deploymentId', 'id']) || readString(rollback, ['deployment_id', 'deploymentId', 'id']);
      if (!deploymentId) throw new IntegrationError('missing_rollback_context', 'vercel compensation requires a deployment id', false);
      return await vercel.execute({ ...actionContext, action: 'cancel_deployment', payload: { ...payload, deployment_id: deploymentId, id: deploymentId }, mode: 'compensate' } as IntegrationActionContext);
    }

    throw new IntegrationError('unsupported_provider', 'unsupported compensation provider: ' + provider, false);
  }
}

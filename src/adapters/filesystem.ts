import { createHash } from 'node:crypto';
import { WorkspaceFilesystemRuntime } from '../runtime/filesystem.ts';
import { listFiles, patchFile, readFile, writeFile, searchFiles } from '../../../../mcp/poke-operator-5cf42317-0aac-4114-893d-4bd3b25b7e4b.ts';
import type { FilesystemNode, FilesystemSnapshot } from '../runtime/types.ts';

function parseToolResult(result: unknown): unknown {
  const candidate = result as { content?: Array<{ text?: string; resource?: { text?: string } }> };
  const items = candidate?.content ?? [];
  for (const item of items) {
    const text = item.text ?? item.resource?.text;
    if (!text) continue;
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.parse(trimmed); } catch { /* ignore */ }
    }
  }
  return items.map((item) => item.text ?? item.resource?.text ?? '').filter(Boolean);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeListResult(value: unknown): FilesystemNode[] {
  const records = Array.isArray(value) ? value : [];
  return records.map((record) => {
    const row = record as Record<string, unknown>;
    const kind = String(row.kind ?? (row.type === 'directory' ? 'directory' : 'file')) as 'file' | 'directory';
    const path = String(row.path ?? row.name ?? '');
    const size = Number(row.size ?? 0);
    return { path, kind, size, hash: typeof row.hash === 'string' ? row.hash : undefined, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : undefined };
  });
}

export type OperatorFilesystemToolset = {
  listFiles(params: { path?: string; maxDepth?: number; recursive?: boolean; maxEntries?: number; includeHidden?: boolean }): Promise<FilesystemNode[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, createDirs?: boolean): Promise<void>;
  patchFile(path: string, search: string, replace: string, all?: boolean): Promise<void>;
  searchFiles(query: string, path?: string, glob?: string, maxResults?: number): Promise<Array<{ path: string; snippet?: string }>>;
};

export function createOperatorFilesystemToolset(): OperatorFilesystemToolset {
  return {
    listFiles: async (params) => normalizeListResult(parseToolResult(await listFiles(params as never))),
    readFile: async (path) => String(parseToolResult(await readFile({ path })) ?? ''),
    writeFile: async (path, content, createDirs = true) => { await writeFile({ path, content, createDirs }); },
    patchFile: async (path, search, replace, all = false) => { await patchFile({ path, search, replace, all }); },
    searchFiles: async (query, path = '.', glob, maxResults = 50) => {
      const parsed = parseToolResult(await searchFiles({ query, path, glob, maxResults }));
      return (Array.isArray(parsed) ? parsed : []).map((item) => item as { path: string; snippet?: string });
    },
  };
}

export class PokeOperatorFilesystemRuntime {
  private live = createOperatorFilesystemToolset();

  constructor(private base: WorkspaceFilesystemRuntime) {}

  async exists(path: string): Promise<boolean> {
    return await this.base.exists(path);
  }

  async readText(path: string): Promise<string> {
    return await this.live.readFile(path);
  }

  async writeTextAtomic(path: string, content: string): Promise<FilesystemNode> {
    await this.live.writeFile(path, content, true);
    return { path, kind: 'file', size: content.length, hash: sha256(content), updatedAt: Date.now() };
  }

  async hashFile(path: string): Promise<string> {
    const text = await this.live.readFile(path);
    return sha256(text);
  }

  async list(path = '.', recursive = true): Promise<FilesystemNode[]> {
    const nodes = await this.live.listFiles({ path, recursive, includeHidden: false });
    return nodes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async snapshot(path = '.'): Promise<FilesystemSnapshot> {
    return { root: path, capturedAt: Date.now(), nodes: await this.list(path, true) };
  }

  diffSnapshots(before: FilesystemSnapshot, after: FilesystemSnapshot) {
    return this.base.diffSnapshots(before, after);
  }

  async search(pattern: RegExp): Promise<FilesystemNode[]> {
    const results = await this.live.searchFiles(pattern.source, '.', undefined, 100);
    return results.map((item) => ({ path: item.path, kind: 'file', size: 0 }));
  }

  async patchFile(path: string, search: string, replace: string, all = false): Promise<void> {
    await this.live.patchFile(path, search, replace, all);
  }
}

export function createPokeFilesystemRuntime(root = '.') {
  return new PokeOperatorFilesystemRuntime(new WorkspaceFilesystemRuntime(root));
}

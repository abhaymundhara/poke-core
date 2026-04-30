import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { FilesystemDiff, FilesystemNode, FilesystemSnapshot } from './types';

function isSubpath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !resolve(target).includes('..'));
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function diffLines(_before: string, _after: string) {
  return [];
}

export class WorkspaceFilesystemRuntime {
  constructor(private root: string) {
    this.root = resolve(root);
  }

  private resolvePath(path: string): string {
    const target = resolve(this.root, path);
    if (!isSubpath(this.root, target)) throw new Error(`path escapes workspace root: ${path}`);
    return target;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(path));
      return true;
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<string> {
    return await fs.readFile(this.resolvePath(path), 'utf8');
  }

  async writeTextAtomic(path: string, content: string): Promise<FilesystemNode> {
    const target = this.resolvePath(path);
    await fs.mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, target);
    const stat = await fs.stat(target);
    return { path, kind: 'file', size: stat.size, hash: hashBuffer(Buffer.from(content, 'utf8')), updatedAt: stat.mtimeMs };
  }

  async hashFile(path: string): Promise<string> {
    const buffer = await fs.readFile(this.resolvePath(path));
    return hashBuffer(buffer);
  }

  async list(path = '.', recursive = true): Promise<FilesystemNode[]> {
    const target = this.resolvePath(path);
    const output: FilesystemNode[] = [];
    async function walk(current: string, prefix: string) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = join(current, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const stat = await fs.stat(absolute);
        if (entry.isDirectory()) {
          output.push({ path: relativePath, kind: 'directory', size: 0, updatedAt: stat.mtimeMs });
          if (recursive) await walk(absolute, relativePath);
        } else if (entry.isFile()) {
          const buffer = await fs.readFile(absolute);
          output.push({ path: relativePath, kind: 'file', size: stat.size, hash: hashBuffer(buffer), updatedAt: stat.mtimeMs });
        }
      }
    }
    const stat = await fs.stat(target);
    if (stat.isFile()) {
      const buffer = await fs.readFile(target);
      return [{ path, kind: 'file', size: stat.size, hash: hashBuffer(buffer), updatedAt: stat.mtimeMs }];
    }
    await walk(target, path === '.' ? '' : path);
    return output.sort((a, b) => a.path.localeCompare(b.path));
  }

  async snapshot(path = '.'): Promise<FilesystemSnapshot> {
    const nodes = await this.list(path, true);
    return { root: this.resolvePath(path), capturedAt: Date.now(), nodes };
  }

  diffSnapshots(before: FilesystemSnapshot, after: FilesystemSnapshot): FilesystemDiff[] {
    const byPath = new Map(before.nodes.map((node) => [node.path, node] as const));
    const nextByPath = new Map(after.nodes.map((node) => [node.path, node] as const));
    const paths = [...new Set([...byPath.keys(), ...nextByPath.keys()])].sort();
    return paths.map((path) => {
      const oldNode = byPath.get(path);
      const newNode = nextByPath.get(path);
      if (!oldNode && newNode) return { path, change: 'create', after: newNode.hash, hunks: [] } as FilesystemDiff;
      if (oldNode && !newNode) return { path, change: 'delete', before: oldNode.hash, hunks: [] } as FilesystemDiff;
      if (oldNode?.hash === newNode?.hash) return { path, change: 'update', before: oldNode?.hash, after: newNode?.hash, hunks: [] } as FilesystemDiff;
      return { path, change: 'update', before: oldNode?.hash, after: newNode?.hash, hunks: [] } as FilesystemDiff;
    }).filter((entry) => entry.change !== 'update' || entry.before !== entry.after);
  }

  async search(pattern: RegExp): Promise<FilesystemNode[]> {
    const nodes = await this.list('.');
    return nodes.filter((node) => pattern.test(node.path));
  }
}

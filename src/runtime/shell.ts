import { exec, spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export type ShellExecutionMode = 'spawn' | 'exec';

export type ShellOutputChunk = {
  stream: 'stdout' | 'stderr';
  data: string;
  acceptedBytes: number;
  totalBytes: number;
  truncated: boolean;
};

export type ShellRunOptions = {
  cwd?: string;
  env?: Record<string, string | number | boolean | null | undefined>;
  timeoutMs?: number;
  shell?: string;
  mode?: ShellExecutionMode;
  allowUnsafeCommands?: boolean;
  maxOutputBytes?: number;
  gracePeriodMs?: number;
  onChunk?: (chunk: ShellOutputChunk) => void;
};

export type ShellRunResult = {
  command: string;
  cwd: string;
  shell: string;
  mode: ShellExecutionMode;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  startedAt: number;
  endedAt: number;
};

type PreparedShellInvocation = {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: string;
  mode: ShellExecutionMode;
  timeoutMs: number;
  maxOutputBytes: number;
  gracePeriodMs: number;
  allowUnsafeCommands: boolean;
  onChunk?: (chunk: ShellOutputChunk) => void;
};

export type ShellRuntimeOptions = {
  workspaceRoot?: string;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  defaultMode?: ShellExecutionMode;
  defaultShell?: string;
  allowUnsafeCommands?: boolean;
};

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+(\/|~|$)/i,
  /\brm\s+-rf\s+--no-preserve-root\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  /\bmkfs(\.|$)/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bdd\b[^|;&]*\bof=\/dev\//i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\bchown\s+-R\s+[^|;&]+\s+\//i,
  /:\s*>\s*\/dev\/sda/i,
];

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function stringifyEnvValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

function appendWithLimit(current: string, chunk: string, maxBytes: number) {
  const currentBytes = Buffer.byteLength(current, 'utf8');
  const remainingBytes = Math.max(0, maxBytes - currentBytes);
  if (remainingBytes <= 0) {
    return { value: current, acceptedBytes: 0, truncated: Buffer.byteLength(chunk, 'utf8') > 0 };
  }

  const buffer = Buffer.from(chunk, 'utf8');
  const acceptedBuffer = buffer.subarray(0, remainingBytes);
  const acceptedText = acceptedBuffer.toString('utf8');
  return {
    value: current + acceptedText,
    acceptedBytes: Buffer.byteLength(acceptedText, 'utf8'),
    truncated: acceptedBuffer.length < buffer.length,
  };
}

function resolveShellExecutable(shellOverride: string | undefined): string {
  if (shellOverride) return shellOverride;
  if (process.platform === 'win32') return process.env.ComSpec ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

function shellInvocation(shell: string, command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return { executable: shell, args: ['/d', '/s', '/c', command] };
  }
  return { executable: shell, args: ['-lc', command] };
}

function isPotentiallyDestructive(command: string): RegExp | null {
  return DANGEROUS_COMMAND_PATTERNS.find((pattern) => pattern.test(command)) ?? null;
}

function createResult(params: {
  command: string;
  cwd: string;
  shell: string;
  mode: ShellExecutionMode;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  startedAt: number;
}): ShellRunResult {
  const endedAt = Date.now();
  return {
    ...params,
    startedAt: params.startedAt,
    endedAt,
    durationMs: endedAt - params.startedAt,
  };
}

export class ShellRuntime {
  private readonly workspaceRoot: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;
  private readonly defaultMode: ShellExecutionMode;
  private readonly defaultShell?: string;
  private readonly allowUnsafeCommands: boolean;

  constructor(options: ShellRuntimeOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 1_048_576;
    this.defaultMode = options.defaultMode ?? 'spawn';
    this.defaultShell = options.defaultShell;
    this.allowUnsafeCommands = options.allowUnsafeCommands ?? false;
  }

  private resolveCwd(cwd?: string): string {
    const target = resolve(this.workspaceRoot, cwd ?? '.');
    if (!isInsideRoot(this.workspaceRoot, target)) {
      throw new Error(`cwd escapes workspace root: ${cwd}`);
    }
    return target;
  }

  private buildEnv(env?: Record<string, string | number | boolean | null | undefined>): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') merged[key] = value;
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      const stringified = stringifyEnvValue(value);
      if (stringified === undefined) delete merged[key];
      else merged[key] = stringified;
    }
    return merged;
  }

  private validateCommand(command: string, allowUnsafeCommands: boolean): void {
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('command is required');
    }
    if (command.includes('\0')) {
      throw new Error('command contains a null byte');
    }
    if (command.length > 32_768) {
      throw new Error('command is too long');
    }
    if (!allowUnsafeCommands) {
      const pattern = isPotentiallyDestructive(command);
      if (pattern) {
        throw new Error(`refusing to run potentially destructive command: ${pattern}`);
      }
    }
  }

  private prepareInvocation(command: string, options: ShellRunOptions): PreparedShellInvocation {
    const resolvedCommand = command.trim();
    const allowUnsafeCommands = options.allowUnsafeCommands ?? this.allowUnsafeCommands;
    this.validateCommand(resolvedCommand, allowUnsafeCommands);

    return {
      command: resolvedCommand,
      cwd: this.resolveCwd(options.cwd),
      env: this.buildEnv(options.env),
      shell: resolveShellExecutable(options.shell ?? this.defaultShell),
      mode: options.mode ?? this.defaultMode,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? this.defaultMaxOutputBytes,
      gracePeriodMs: options.gracePeriodMs ?? 5_000,
      allowUnsafeCommands,
      onChunk: options.onChunk,
    };
  }

  async run(command: string, options: ShellRunOptions = {}): Promise<ShellRunResult> {
    const prepared = this.prepareInvocation(command, options);
    return prepared.mode === 'exec' ? await this.runWithExec(prepared) : await this.runWithSpawn(prepared);
  }

  private async runWithExec(prepared: PreparedShellInvocation): Promise<ShellRunResult> {
    const startedAt = Date.now();
    try {
      const result = await execAsync(prepared.command, {
        cwd: prepared.cwd,
        env: prepared.env,
        timeout: prepared.timeoutMs,
        maxBuffer: prepared.maxOutputBytes,
        shell: prepared.shell,
        killSignal: 'SIGTERM',
      });

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(stderr, 'utf8');
      return createResult({
        command: prepared.command,
        cwd: prepared.cwd,
        shell: prepared.shell,
        mode: 'exec',
        pid: null,
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: stdoutBytes + stderrBytes >= prepared.maxOutputBytes,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        startedAt,
      });
    } catch (error) {
      const err = error as {
        stdout?: string;
        stderr?: string;
        code?: number | string | null;
        signal?: string | null;
        killed?: boolean;
        message?: string;
      };
      const stdout = err.stdout ?? '';
      const stderr = err.stderr ?? '';
      const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(stderr, 'utf8');
      const timedOut = Boolean(err.killed && /timeout/i.test(err.message ?? ''));
      return createResult({
        command: prepared.command,
        cwd: prepared.cwd,
        shell: prepared.shell,
        mode: 'exec',
        pid: null,
        exitCode: typeof err.code === 'number' ? err.code : null,
        signal: err.signal ?? null,
        timedOut,
        truncated: stdoutBytes + stderrBytes >= prepared.maxOutputBytes || /maxbuffer/i.test(err.message ?? ''),
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
        startedAt,
      });
    }
  }

  private async runWithSpawn(prepared: PreparedShellInvocation): Promise<ShellRunResult> {
    const startedAt = Date.now();
    const { executable, args } = shellInvocation(prepared.shell, prepared.command);

    return await new Promise<ShellRunResult>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let totalBytes = 0;
      let truncated = false;
      let timedOut = false;
      let pid: number | null = null;

      const child = spawn(executable, args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      pid = child.pid ?? null;

      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill('SIGTERM');
        const killHandle = setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, prepared.gracePeriodMs);
        killHandle.unref?.();
      }, prepared.timeoutMs);
      timeoutHandle.unref?.();

      const emitChunk = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
        if (settled) return;
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const remainingBytes = Math.max(0, prepared.maxOutputBytes - totalBytes);
        const buffer = Buffer.from(text, 'utf8');
        const acceptedBuffer = buffer.subarray(0, remainingBytes);
        const acceptedText = acceptedBuffer.toString('utf8');

        if (acceptedBytes(acceptedText) > 0) {
          if (stream === 'stdout') {
            stdout += acceptedText;
            stdoutBytes += acceptedBytes(acceptedText);
          } else {
            stderr += acceptedText;
            stderrBytes += acceptedBytes(acceptedText);
          }
          totalBytes += acceptedBytes(acceptedText);
          prepared.onChunk?.({
            stream,
            data: acceptedText,
            acceptedBytes: acceptedBytes(acceptedText),
            totalBytes,
            truncated,
          });
        }

        if (acceptedBuffer.length < buffer.length) {
          truncated = true;
        }
      };

      const acceptedBytes = (value: string) => Buffer.byteLength(value, 'utf8');

      child.stdout?.on('data', (chunk) => emitChunk('stdout', chunk));
      child.stderr?.on('data', (chunk) => emitChunk('stderr', chunk));

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });

      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(createResult({
          command: prepared.command,
          cwd: prepared.cwd,
          shell: prepared.shell,
          mode: 'spawn',
          pid,
          exitCode,
          signal,
          timedOut,
          truncated,
          stdout,
          stderr,
          stdoutBytes,
          stderrBytes,
          startedAt,
        }));
      });
    });
  }
}

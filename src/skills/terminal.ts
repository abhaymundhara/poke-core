import type { ExecutionContext, PlanStep, SkillDescriptor, SkillResult } from '../types';
import { ShellRuntime, type ShellOutputChunk, type ShellRunOptions, type ShellRunResult } from '../runtime/shell';
import type { SkillAdapter } from './types';

export type TerminalSkillOptions = ShellRunOptions & {
  workspaceRoot?: string;
};

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseEnv(value: unknown): Record<string, string | number | boolean | null | undefined> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, string | number | boolean | null | undefined>;
}

function tail(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function commandFromArgs(args: Record<string, unknown>): string {
  return toText(args.command) || toText(args.script) || toText(args.shellCommand);
}

function cwdFromArgs(args: Record<string, unknown>): string | undefined {
  return toText(args.cwd) || toText(args.workingDirectory) || toText(args.workdir) || undefined;
}

function modeFromArgs(args: Record<string, unknown>): ShellRunOptions['mode'] {
  const mode = toText(args.mode);
  return mode === 'exec' ? 'exec' : 'spawn';
}

function buildRuntimeOutput(result: ShellRunResult, streamHistory: ShellOutputChunk[], command: string): Record<string, unknown> {
  return {
    command,
    cwd: result.cwd,
    shell: result.shell,
    mode: result.mode,
    pid: result.pid,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutPreview: tail(result.stdout),
    stderrPreview: tail(result.stderr),
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    streamHistory,
  };
}

export class TerminalSkill implements SkillAdapter {
  descriptor: SkillDescriptor = {
    name: 'terminal',
    domain: 'system-execution',
    capabilities: ['run-command', 'capture-stdout', 'capture-stderr', 'cwd-management', 'env-injection', 'timeout-control'],
    version: '1.0.0',
  };

  private readonly shell: ShellRuntime;

  constructor(options: TerminalSkillOptions = {}) {
    this.shell = new ShellRuntime(options);
  }

  canHandle(step: PlanStep): boolean {
    return step.skill === 'terminal' || step.skill === 'shell';
  }

  async execute(ctx: ExecutionContext): Promise<SkillResult> {
    const args = toRecord(ctx.step.args);
    const command = commandFromArgs(args);
    if (!command) {
      throw new Error('terminal skill requires a command');
    }

    const cwd = cwdFromArgs(args);
    const env = parseEnv(args.env) ?? parseEnv(args.environment);
    const timeoutMs = toNumber(args.timeoutMs) ?? toNumber(args.timeout) ?? toNumber(args.maxDurationMs);
    const maxOutputBytes = toNumber(args.maxOutputBytes) ?? toNumber(args.maxBufferBytes);
    const gracePeriodMs = toNumber(args.gracePeriodMs);
    const shell = toText(args.shell) || undefined;
    const allowUnsafeCommands = toBoolean(args.allowUnsafe) || toBoolean(args.allowUnsafeCommands);
    const mode = modeFromArgs(args);

    const streamHistory: ShellOutputChunk[] = [];
    let liveStdout = '';
    let liveStderr = '';

    const onChunk = (chunk: ShellOutputChunk) => {
      streamHistory.push(chunk);
      if (streamHistory.length > 50) streamHistory.shift();
      if (chunk.stream === 'stdout') {
        liveStdout += chunk.data;
      } else {
        liveStderr += chunk.data;
      }

      const liveOutput = {
        status: 'running',
        command,
        cwd,
        shell,
        mode,
        stdoutPreview: tail(liveStdout),
        stderrPreview: tail(liveStderr),
        chunksSeen: streamHistory.length,
        lastChunk: chunk,
      };
      ctx.state.artifacts[ctx.step.id] = liveOutput;
      ctx.state.outputs[ctx.step.id] = liveOutput;
    };

    try {
      const result = await this.shell.run(command, {
        cwd,
        env,
        timeoutMs,
        shell,
        mode,
        allowUnsafeCommands,
        maxOutputBytes,
        gracePeriodMs,
        onChunk,
      });

      const output = buildRuntimeOutput(result, streamHistory.slice(), command);
      ctx.state.artifacts[ctx.step.id] = output;
      ctx.state.outputs[ctx.step.id] = output;

      const ok = result.exitCode === 0 && !result.timedOut;
      return {
        ok,
        output,
        retryable: !ok && result.timedOut,
        note: ok
          ? 'command completed successfully'
          : result.timedOut
            ? `command timed out after ${result.durationMs}ms`
            : `command exited with code ${result.exitCode ?? 'unknown'}`,
        trace: {
          command,
          cwd: result.cwd,
          shell: result.shell,
          mode: result.mode,
          pid: result.pid,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          chunksSeen: streamHistory.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const output = {
        command,
        cwd,
        shell,
        mode,
        error: message,
      };
      ctx.state.artifacts[ctx.step.id] = output;
      ctx.state.outputs[ctx.step.id] = output;
      return {
        ok: false,
        output,
        retryable: false,
        note: 'terminal runtime rejected the command',
        trace: { command, cwd, shell, mode, error: message },
      };
    }
  }
}

#!/usr/bin/env bun
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PokeCoreStore } from './store';
import { SkillRouter } from './router';
import { BrowserSkill } from './skills/browser';
import { IntegrationSkill } from './skills/integrations';
import { PokeCoreOrchestrator } from './orchestrator';
import { buildPlan } from './planner';

type Args = { _: string[]; [k: string]: string | boolean | undefined };
function parse(argv: string[]): Args { const out: Args = { _: [] }; for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (!t.startsWith('--')) { out._.push(t); continue; } const k = t.slice(2); const next = argv[i + 1]; if (!next || next.startsWith('--')) { out[k] = true; continue; } out[k] = next; i++; } return out; }
function str(args: Args, key: string, fallback?: string) { const v = args[key]; if (typeof v === 'string') return v; if (fallback !== undefined) return fallback; throw new Error(`Missing --${key}`); }
function dbPath(args: Args) { return str(args, 'db', './poke-core.sqlite'); }
function storeFor(args: Args) { const path = dbPath(args); const dir = dirname(resolve(path)); if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); const store = new PokeCoreStore(path); store.init(); return store; }

const args = parse(process.argv.slice(2)); const [cmd] = args._;
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log('poke-core init|plan|run|tasks|history|snapshots');
  process.exit(0);
}

const store = storeFor(args);
const router = new SkillRouter([new BrowserSkill(), new IntegrationSkill()]);
const orchestrator = new PokeCoreOrchestrator(store, router);

try {
  if (cmd === 'init') {
    console.log(JSON.stringify({ ok: true, db: dbPath(args) }, null, 2));
  } else if (cmd === 'plan') {
    const objective = str(args, 'objective');
    const taskId = str(args, 'task', `task-${Date.now()}`);
    const plan = buildPlan({ id: taskId, objective, context: typeof args.context === 'string' ? JSON.parse(args.context) : undefined });
    console.log(JSON.stringify(plan, null, 2));
  } else if (cmd === 'run') {
    const objective = str(args, 'objective');
    const taskId = str(args, 'task', `task-${Date.now()}`);
    const result = await orchestrator.runTask({ id: taskId, objective, context: typeof args.context === 'string' ? JSON.parse(args.context) : undefined });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'tasks') {
    const taskId = str(args, 'task');
    console.log(JSON.stringify(store.getTask(taskId), null, 2));
  } else if (cmd === 'history') {
    const taskId = str(args, 'task');
    console.log(JSON.stringify(store.allHistory(taskId), null, 2));
  } else if (cmd === 'snapshots') {
    const taskId = str(args, 'task');
    console.log(JSON.stringify(store.allSnapshots(taskId), null, 2));
  } else if (cmd === 'executions') {
    const taskId = str(args, 'task');
    console.log(JSON.stringify(store.allExecutions(taskId), null, 2));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} finally {
  store.close();
}

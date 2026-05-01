#!/usr/bin/env bun
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PokeCoreStore } from './store';
import { PokeCoreOrchestrator } from './orchestrator';
import { AutopilotSkill, BrowserSkill, ComputerUseSkill, GroundingSkill, HarnessSkill, IntegrationSkill, SignalObservationSkill, UserModelingSkill } from './skills';
import { buildPlan } from './planner';
import { formatRetrievalBenchmark } from './rag';
import { formatAutopilotAudit, formatAutopilotBenchmark } from './autopilot';
import { formatRaidingAiAudit, formatRaidingAiBenchmark } from './raidingai';

type Args = { _: string[]; [k: string]: string | boolean | undefined };
function parse(argv: string[]): Args { const out: Args = { _: [] }; for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (!t.startsWith('--')) { out._.push(t); continue; } const k = t.slice(2); const next = argv[i + 1]; if (!next || next.startsWith('--')) { out[k] = true; continue; } out[k] = next; i++; } return out; }
function str(args: Args, key: string, fallback?: string) { const v = args[key]; if (typeof v === 'string') return v; if (fallback !== undefined) return fallback; throw new Error(`missing --${key}`); }
function ensureDbPath(path: string) { const dir = dirname(resolve(path)); if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); return path; }

const args = parse(process.argv.slice(2));
const [cmd] = args._;
const db = ensureDbPath(str(args, 'db', './poke-core.sqlite'));
const store = new PokeCoreStore(db);
store.init();
const orchestrator = new PokeCoreOrchestrator(store, [new BrowserSkill(), new IntegrationSkill(), new AutopilotSkill(), new UserModelingSkill(), new GroundingSkill(), new SignalObservationSkill(), new ComputerUseSkill(), new HarnessSkill()]);

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('poke-core init|plan|run|tasks|events|snapshots|attempts|skills|bench');
  } else if (cmd === 'init') {
    console.log(JSON.stringify({ ok: true, db }, null, 2));
  } else if (cmd === 'plan') {
    const plan = buildPlan({ id: str(args, 'task', `task-${Date.now()}`), objective: str(args, 'objective'), context: typeof args.context === 'string' ? JSON.parse(args.context) : undefined });
    console.log(JSON.stringify(plan, null, 2));
  } else if (cmd === 'run') {
    const result = await orchestrator.execute({ id: str(args, 'task', `task-${Date.now()}`), objective: str(args, 'objective'), context: typeof args.context === 'string' ? JSON.parse(args.context) : undefined });
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === 'tasks') {
    const task = store.getTask(str(args, 'task'));
    console.log(JSON.stringify(task, null, 2));
  } else if (cmd === 'events') {
    console.log(JSON.stringify(store.allEvents(str(args, 'task')), null, 2));
  } else if (cmd === 'snapshots') {
    console.log(JSON.stringify(store.allSnapshots(str(args, 'task')), null, 2));
  } else if (cmd === 'attempts') {
    console.log(JSON.stringify(store.allAttempts(str(args, 'task')), null, 2));
  } else if (cmd === 'skills') {
    console.log(JSON.stringify(orchestrator.skillCatalog, null, 2));
  } else if (cmd === 'bench') {
    const suite = args._[1] ?? 'all';
    if (suite === 'rag') {
      console.log(formatRetrievalBenchmark());
    } else if (suite === 'autopilot') {
      console.log(formatAutopilotBenchmark());
      console.log('');
      console.log(formatAutopilotAudit());
    } else if (suite === 'raidingai') {
      console.log(formatRaidingAiBenchmark());
      console.log('');
      console.log(formatRaidingAiAudit());
    } else {
      console.log(formatRetrievalBenchmark());
      console.log('');
      console.log(formatAutopilotBenchmark());
      console.log('');
      console.log(formatAutopilotAudit());
      console.log('');
      console.log(formatRaidingAiBenchmark());
      console.log('');
      console.log(formatRaidingAiAudit());
    }
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} finally {
  store.close();
}

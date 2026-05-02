import { spawnSync } from 'node:child_process';

export function parseModelJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    return JSON.parse(cleaned) as T;
  }
  return value as T;
}

export function extractWithDefaultProviderSync<T>(payload: unknown, providerModulePath = './src/search/nlu.ts', exportName = 'DEFAULT_LLM_SEMANTIC_NLU_PROVIDER'): T {
  const script = 'const payload = JSON.parse(process.argv[process.argv.length - 1]);
'
    + 'const mod = await import(' + JSON.stringify(providerModulePath) + ');
'
    + 'const provider = mod[' + JSON.stringify(exportName) + '];
'
    + 'if (!provider || typeof provider.extract !== 'function') throw new Error('missing-llm-provider');
'
    + 'const result = await provider.extract(payload);
'
    + 'process.stdout.write(JSON.stringify(result));';
  const run = spawnSync('bun', ['-e', script, JSON.stringify(payload)], { cwd: process.cwd(), encoding: 'utf8' });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || 'llm-extraction-failed').trim());
  }
  const text = (run.stdout ?? '').trim();
  if (!text) throw new Error('empty-llm-output');
  return parseModelJson<T>(text);
}

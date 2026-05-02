import { spawnSync } from 'node:child_process';

export function extractWithDefaultProviderSync<T>(payload: unknown, providerModulePath = './src/search/nlu.ts', exportName = 'DEFAULT_LLM_SEMANTIC_NLU_PROVIDER'): T {
  const script = `
const payload = JSON.parse(process.argv[1]);
const mod = await import("./src/search/nlu.ts");
const provider = mod["DEFAULT_LLM_SEMANTIC_NLU_PROVIDER"];
if (!provider || typeof provider.extract !== 'function') throw new Error('missing-llm-provider');
const result = await provider.extract(payload);
process.stdout.write(JSON.stringify(result));
`;
  const run = spawnSync('bun', ['-e', script.replace("./src/search/nlu.ts", providerModulePath).replace("DEFAULT_LLM_SEMANTIC_NLU_PROVIDER", exportName), JSON.stringify(payload)], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || 'llm-extraction-failed').trim());
  }
  const text = (run.stdout ?? '').trim();
  if (!text) throw new Error('empty-llm-output');
  return JSON.parse(text) as T;
}

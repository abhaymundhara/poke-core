import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileDurableStore } from '../src/runtime/durable.ts';
import { MultimodalRuntime } from '../src/runtime/multimodal.ts';
import { AutomationRuntime } from '../src/runtime/automation.ts';

const multimodalStateRoot = mkdtempSync(join(tmpdir(), 'poke-mm-'));
const automationStateRoot = mkdtempSync(join(tmpdir(), 'poke-auto-'));

const multimodal = new MultimodalRuntime({
  tools: {
    generateMedia: async (params) => ({ mediaId: `media-${params.output_format ?? 'image'}`, description: params.query }),
    compileLatexToPdf: async (params) => ({ mediaId: `pdf-${params.output_filename ?? 'doc'}` }),
    queryMedia: async (params) => ({ answer: `${params.media_id}:${params.query}` }),
  },
  store: new JsonFileDurableStore(join(multimodalStateRoot, 'runs')),
});

const automation = new AutomationRuntime({
  tools: {
    createTrigger: async (params) => ({ triggerId: `${params.type}-trigger`, spec: params }),
    manageIngestEndpoints: async (params) => params.action === 'list'
      ? [{ endpointId: 'endpoint-1', name: 'Test Endpoint' }]
      : { endpointId: 'endpoint-created', name: params.name },
  },
  store: new JsonFileDurableStore(join(automationStateRoot, 'runs')),
});

const image = await multimodal.generateImage({ query: 'a clean product mockup', outputFilename: 'mockup' });
assert.equal(image.mediaId, 'media-image');
const voice = await multimodal.transcribeVoice({ mediaId: 'audio-1' });
assert.ok(voice.result.includes('audio-1'));
const pdf = await multimodal.compilePdf({ latexSource: '\\documentclass{article}\\begin{document}hi\\end{document}', outputFilename: 'report' });
assert.equal(pdf.mediaId, 'pdf-report');

const emailTrigger = await automation.createEmailAutomation('from:boss@example.com', 'notify the user about the email from boss@example.com', true);
assert.equal(emailTrigger.triggerId, 'email-trigger');
const ingestTrigger = await automation.createIngestAutomation({ condition: 'payload value exceeds threshold', action: 'notify the user and summarize the payload', endpointName: 'Test Endpoint', createIfMissing: false, evaluationScriptPath: 'user/ingest-eval/test.ts', repeating: true, triggersUntilStop: null });
assert.equal(ingestTrigger.endpointId, 'endpoint-1');

const recovered = await automation.recover(emailTrigger.runId);
assert.equal(recovered.status, 'succeeded');

rmSync(multimodalStateRoot, { recursive: true, force: true });
rmSync(automationStateRoot, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, image, voice, pdf, emailTrigger, ingestTrigger, recoveredStatus: recovered.status }, null, 2));

import type { SqliteDurableStore, DurableRunRecord } from './durable.ts';

export type MultimodalKind = 'image' | 'data_visualization' | 'pdf' | 'voice' | 'document' | 'audio';

export type MultimodalMediaRef = { id: string; userId?: string };

export type MultimodalJobInput = {
  kind: MultimodalKind;
  query?: string;
  inputMedia?: MultimodalMediaRef[];
  outputFilename?: string;
  aspectRatio?: '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9';
  imageModel?: 'default' | 'flux';
  latexSource?: string;
  mediaId?: string;
  voicePrompt?: string;
};

export type MultimodalJobOutput = {
  kind: MultimodalKind;
  mediaId?: string;
  answer?: string;
  description?: string;
  raw: unknown;
};

export type MultimodalToolset = {
  generateMedia(params: {
    query: string;
    output_format?: 'image' | 'data_visualization';
    input_media?: MultimodalMediaRef[];
    aspect_ratio?: MultimodalJobInput['aspectRatio'];
    output_filename?: string;
    image_model?: MultimodalJobInput['imageModel'];
  }): Promise<unknown>;
  compileLatexToPdf(params: { latex_source: string; output_filename?: string }): Promise<unknown>;
  queryMedia(params: { media_id: string; query: string }): Promise<unknown>;
};

function parseToolPayload(result: unknown): unknown {
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

function unwrapToolResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'content' in result) return parseToolPayload(result);
  return result;
}

function extractText(payload: unknown, fallback = ''): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    return String(record.answer ?? record.text ?? record.description ?? record.result ?? fallback);
  }
  return fallback;
}

async function withRun<T>(store: JsonFileDurableStore<MultimodalJobInput, MultimodalJobOutput>, kind: string, input: MultimodalJobInput, fn: (runId: string) => Promise<T>): Promise<{ run: DurableRunRecord<MultimodalJobInput, MultimodalJobOutput>; output: T }> {
  const run = await store.create(kind, input);
  await store.checkpoint(run.id, 'start', { kind });
  try {
    const output = await fn(run.id);
    await store.checkpoint(run.id, 'complete', { kind });
    return { run: await store.complete(run.id, output as MultimodalJobOutput), output };
  } catch (error) {
    await store.checkpoint(run.id, 'failed', { kind }, error instanceof Error ? error.message : String(error));
    await store.fail(run.id, error);
    throw error;
  }
}

export class MultimodalRuntime {
  constructor(private deps: { tools: MultimodalToolset; store: JsonFileDurableStore<MultimodalJobInput, MultimodalJobOutput> }) {}

  async inspectMedia(input: { mediaId: string; query: string }): Promise<{ runId: string; result: string }> {
    const { run, output } = await withRun(this.deps.store, 'inspectMedia', { kind: 'document', mediaId: input.mediaId, query: input.query }, async () => {
      const parsed = await this.deps.tools.queryMedia({ media_id: input.mediaId, query: input.query });
      return { kind: 'document', mediaId: input.mediaId, answer: extractText(unwrapToolResult(parsed), input.query), raw: parsed };
    });
    return { runId: run.id, result: output.answer ?? '' };
  }

  async transcribeVoice(input: { mediaId: string; query?: string }): Promise<{ runId: string; result: string }> {
    const query = input.query ?? 'transcribe the audio, identify speakers if possible, and summarize action items';
    const { run, output } = await withRun(this.deps.store, 'transcribeVoice', { kind: 'voice', mediaId: input.mediaId, query }, async () => {
      const parsed = await this.deps.tools.queryMedia({ media_id: input.mediaId, query });
      return { kind: 'voice', mediaId: input.mediaId, answer: extractText(unwrapToolResult(parsed), query), raw: parsed };
    });
    return { runId: run.id, result: output.answer ?? '' };
  }

  async generateImage(input: { query: string; inputMedia?: MultimodalMediaRef[]; aspectRatio?: MultimodalJobInput['aspectRatio']; outputFilename?: string; imageModel?: MultimodalJobInput['imageModel']; }): Promise<{ runId: string; mediaId?: string; raw: unknown }> {
    const { run, output } = await withRun(this.deps.store, 'generateImage', { kind: 'image', query: input.query, inputMedia: input.inputMedia, aspectRatio: input.aspectRatio, outputFilename: input.outputFilename, imageModel: input.imageModel }, async () => {
      const parsed = await this.deps.tools.generateMedia({
        query: input.query,
        output_format: 'image',
        input_media: input.inputMedia,
        aspect_ratio: input.aspectRatio,
        output_filename: input.outputFilename,
        image_model: input.imageModel,
      });
      const payload = unwrapToolResult(parsed) as Record<string, unknown>;
      return { kind: 'image', mediaId: String(payload.mediaId ?? payload.id ?? payload.media_id ?? ''), description: String(payload.description ?? payload.text ?? input.query), raw: payload };
    });
    return { runId: run.id, mediaId: output.mediaId, raw: output.raw };
  }

  async generateVisualization(input: { query: string; inputMedia?: MultimodalMediaRef[]; outputFilename?: string; }): Promise<{ runId: string; mediaId?: string; raw: unknown }> {
    const { run, output } = await withRun(this.deps.store, 'generateVisualization', { kind: 'data_visualization', query: input.query, inputMedia: input.inputMedia, outputFilename: input.outputFilename }, async () => {
      const parsed = await this.deps.tools.generateMedia({
        query: input.query,
        output_format: 'data_visualization',
        input_media: input.inputMedia,
        output_filename: input.outputFilename,
      });
      const payload = unwrapToolResult(parsed) as Record<string, unknown>;
      return { kind: 'data_visualization', mediaId: String(payload.mediaId ?? payload.id ?? payload.media_id ?? ''), description: String(payload.description ?? payload.text ?? input.query), raw: payload };
    });
    return { runId: run.id, mediaId: output.mediaId, raw: output.raw };
  }

  async compilePdf(input: { latexSource: string; outputFilename?: string }): Promise<{ runId: string; mediaId?: string; raw: unknown }> {
    const { run, output } = await withRun(this.deps.store, 'compilePdf', { kind: 'pdf', latexSource: input.latexSource, outputFilename: input.outputFilename }, async () => {
      const parsed = await this.deps.tools.compileLatexToPdf({ latex_source: input.latexSource, output_filename: input.outputFilename });
      const payload = unwrapToolResult(parsed) as Record<string, unknown>;
      return { kind: 'pdf', mediaId: String(payload.mediaId ?? payload.id ?? payload.pdfId ?? ''), description: String(payload.description ?? payload.text ?? 'compiled pdf'), raw: payload };
    });
    return { runId: run.id, mediaId: output.mediaId, raw: output.raw };
  }

  async recover(runId: string) {
    return await this.deps.store.resume(runId);
  }
}

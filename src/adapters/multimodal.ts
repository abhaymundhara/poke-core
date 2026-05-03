import { compileLatexToPdf } from '../../../../poke/media/compile_latex_to_pdf.ts';
import { generateMedia } from '../../../../poke/media/generate_media.ts';
import { queryMedia } from '../../../../poke/media/query_media.ts';
import { MultimodalRuntime } from '../runtime/multimodal.ts';
import { runtimeServices } from '../runtime/services.ts';
import { SqliteDurableStore } from '../runtime/durable.ts';

function createToolset() {
  return {
    generateMedia: async (params: Parameters<typeof generateMedia>[0]) => await generateMedia(params),
    compileLatexToPdf: async (params: Parameters<typeof compileLatexToPdf>[0]) => await compileLatexToPdf(params),
    queryMedia: async (params: Parameters<typeof queryMedia>[0]) => await queryMedia(params),
  };
}

export function createPokeMultimodalRuntime(tenantId = runtimeServices.tenantId, contextId = runtimeServices.contextId) {
  return new MultimodalRuntime({
    tools: createToolset(),
    store: new SqliteDurableStore(tenantId, contextId),
  });
}

export function createMultimodalToolset() {
  return createToolset();
}

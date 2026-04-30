import { compileLatexToPdf } from '../../../../poke/media/compile_latex_to_pdf.ts';
import { generateMedia } from '../../../../poke/media/generate_media.ts';
import { queryMedia } from '../../../../poke/media/query_media.ts';
import { MultimodalRuntime } from '../runtime/multimodal.ts';
import { JsonFileDurableStore } from '../runtime/durable.ts';

function createToolset() {
  return {
    generateMedia: async (params: Parameters<typeof generateMedia>[0]) => await generateMedia(params),
    compileLatexToPdf: async (params: Parameters<typeof compileLatexToPdf>[0]) => await compileLatexToPdf(params),
    queryMedia: async (params: Parameters<typeof queryMedia>[0]) => await queryMedia(params),
  };
}

export function createPokeMultimodalRuntime(stateDir = '.poke-core/multimodal-runs') {
  return new MultimodalRuntime({
    tools: createToolset(),
    store: new JsonFileDurableStore(stateDir),
  });
}

export function createMultimodalToolset() {
  return createToolset();
}

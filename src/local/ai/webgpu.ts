/**
 * In-browser inference through transformers.js (WebGPU, falling back to WASM).
 *
 * The library is intentionally NOT bundled: it is ~1MB of ESM plus ONNX runtime
 * binaries, so we import() it at runtime from whatever URL is in Settings. Default
 * is a CDN; point it at a copy you dropped in public/vendor/ and the whole app
 * runs with zero network.
 */

import { getSettings } from '../db/settings';
import { LLMError } from './http';
import type { ChatOptions } from './chat';

type PipelineKind = 'text-generation' | 'feature-extraction';

let transformersModule: any = null;
const pipelines = new Map<string, Promise<any>>();
const progress = new Map<string, { status: string; file: string; progress: number }>();
const listeners = new Set<() => void>();
let ready = false;
let lastError: string | null = null;

export type ModelStatus = {
  device: 'webgpu' | 'wasm';
  ready: boolean;
  loading: boolean;
  error?: string;
  files: { status: string; file: string; progress: number }[];
};

export function getModelStatus(): ModelStatus {
  const ai = getSettings().ai;
  return {
    device: ai.webgpu.device,
    ready,
    loading: !ready && pipelines.size > 0,
    error: lastError ?? undefined,
    files: [...progress.values()],
  };
}

export function subscribeModelStatus(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

// Async for symmetry with the other capability probes (and so callers can await it).
// eslint-disable-next-line @typescript-eslint/require-await
export async function hasWebgpu(): Promise<boolean> {
  try {
    return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
  } catch {
    return false;
  }
}

async function loadTransformers(): Promise<any> {
  if (transformersModule) return transformersModule;
  const cdnUrl = getSettings().ai.webgpu.cdnUrl;
  if (!cdnUrl) {
    throw new LLMError('Set "transformers.js URL" in Settings to enable in-browser inference.', false);
  }
  try {
    // Resolved at runtime only, so the bundler leaves the URL alone.
    const moduleUrl = /^[a-z]+:/i.test(cdnUrl)
      ? cdnUrl
      : new URL(cdnUrl, document.baseURI).href;
    // vite:import-analysis matches the pragma on a single line, hence the temp.
    transformersModule = await import(/* @vite-ignore */ moduleUrl);
  } catch (e: any) {
    throw new LLMError(
      'Could not load transformers.js from ' + cdnUrl + ': ' + (e?.message ?? e) + '. ' +
        'For an air-gapped setup, save the module to public/vendor/transformers.js and set that URL in Settings.',
      false,
    );
  }
  return transformersModule;
}

async function getPipeline(kind: PipelineKind): Promise<any> {
  const { webgpu } = getSettings().ai;
  const model = kind === 'text-generation' ? webgpu.chatModel : webgpu.embeddingModel;
  if (!model) throw new LLMError('Set the ' + kind + ' model id in Settings.', false);
  const device = (await hasWebgpu()) ? webgpu.device : 'wasm';
  const key = kind + ':' + model + ':' + device + ':' + (webgpu.quantized ? 'q' : 'f');
  const existing = pipelines.get(key);
  if (existing) return existing;

  const created = (async () => {
    const transformers = await loadTransformers();
    try {
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = true;
    } catch {
      /* older builds don't expose env */
    }
    const options: any = {
      device,
      progress_callback: (item: any) => {
        if (!item?.file) return;
        progress.set(String(item.file), {
          status: String(item.status ?? 'progress'),
          file: String(item.file),
          progress: typeof item.progress === 'number' ? item.progress : 0,
        });
        notify();
      },
    };
    if (webgpu.quantized) options.dtype = 'q8';
    else if (kind === 'text-generation' && device === 'webgpu') options.dtype = 'fp16';
    return transformers.pipeline(kind, model, options);
  })()
    .then((pipeline) => {
      ready = true;
      lastError = null;
      notify();
      return pipeline;
    })
    .catch((e: any) => {
      pipelines.delete(key);
      lastError = e?.message ?? String(e);
      notify();
      throw new LLMError('Failed to load ' + model + ' for ' + kind + ' (' + device + '): ' + lastError, false);
    });

  pipelines.set(key, created);
  return created;
}

/** Pull both models down up-front so the first message isn't a long wait. */
export async function warmupWebgpu(): Promise<void> {
  const jobs: Promise<any>[] = [getPipeline('feature-extraction')];
  if (getSettings().ai.webgpu.chatModel) jobs.push(getPipeline('text-generation'));
  await Promise.all(jobs);
}

export async function webgpuChat(options: ChatOptions): Promise<string> {
  const generator: any = await getPipeline('text-generation');
  const ai = getSettings().ai;
  const temperature = options.temperature ?? ai.temperature;
  const params = {
    max_new_tokens: options.maxTokens ?? ai.maxTokens,
    do_sample: temperature > 0,
    temperature: temperature || undefined,
    top_p: 0.95,
    return_full_text: false,
  };
  let output: any;
  try {
    // transformers.js applies the model's chat template when it has one.
    output = await generator(options.messages as any, params);
  } catch {
    const prompt = options.messages
      .map((m) => '<|' + m.role + '|>' + '\n' + m.content + '\n')
      .join('');
    output = await generator(prompt + '<|assistant|>\n', params);
  }
  const first = Array.isArray(output) ? output[0] : output;
  let text: string =
    typeof first === 'string' ? first : (first?.generated_text ?? first?.content ?? '');
  const stopWords = [...(ai.stopWords ?? []), ...(options.stop ?? [])].filter(Boolean);
  for (const word of stopWords) {
    const at = text.indexOf(word);
    if (at >= 0) text = text.slice(0, at);
  }
  const line = text.trim().split('\n')[0] ?? '';
  return line.replace(/^assistant:?\s*/i, '').trim();
}

export async function webgpuEmbeddings(texts: string[]): Promise<number[][]> {
  const extractor: any = await getPipeline('feature-extraction');
  const out: number[][] = [];
  for (const text of texts) {
    const tensor = await extractor(text.replace(/\n/g, ' '), {
      pooling: true,
      normalization: true,
    });
    out.push(Array.from(tensor.data as Float32Array));
  }
  return out;
}

export function resetPipelines() {
  pipelines.clear();
  ready = false;
  lastError = null;
  transformersModule = null;
  notify();
}

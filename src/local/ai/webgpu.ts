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
import { catalogEntry } from './webgpuCatalog';
import { chooseVariant, fetchModelDetail, type ModelVariant } from './hub';
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
  // Resolved at runtime only, so the bundler leaves the URL alone.
  const moduleUrl = /^[a-z]+:/i.test(cdnUrl) ? cdnUrl : new URL(cdnUrl, document.baseURI).href;
  try {
    // vite:import-analysis matches the pragma on a single line, hence the temp.
    transformersModule = await import(/* @vite-ignore */ moduleUrl);
  } catch (firstError: any) {
    // A bare `@version` URL resolves through the package's export map, which
    // not every CDN honours - jsDelivr's explicit ESM entry always does.
    const esm = moduleUrl.replace(/\/$/, '') + '/+esm';
    if (/@huggingface\/transformers@[^/]+$/.test(moduleUrl)) {
      try {
        transformersModule = await import(/* @vite-ignore */ esm);
        return transformersModule;
      } catch {
        /* report the original failure below */
      }
    }
    throw new LLMError(
      'Could not load transformers.js from ' + cdnUrl + ': ' + (firstError?.message ?? firstError) + '. ' +
        'Try the ESM entry (' + esm + '), or for an air-gapped setup save the module to ' +
        'public/vendor/transformers.js and set that URL in Settings.',
      false,
    );
  }
  return transformersModule;
}

const dtypeWarnings = new Map<string, string>();

/**
 * Which precision to ask the hub for.
 *
 * `auto` (the default) looks the repo's own `onnx/model*.onnx` files up and takes
 * the smallest one this device can run - that is the only way a repo like
 * LiquidAI/LFM2.5 works, since its q8 export has no WebGPU kernels while q4
 * does. Offline we fall back to the curated hint, then to the legacy behaviour.
 */
async function resolveDtype(model: string, kind: PipelineKind, device: 'webgpu' | 'wasm'): Promise<string | undefined> {
  const { webgpu } = getSettings().ai;
  const task = kind === 'text-generation' ? 'text-generation' : 'feature-extraction';
  const requested = kind === 'text-generation' ? webgpu.dtype : webgpu.embeddingDtype;
  const legacy = webgpu.quantized
    ? 'q8'
    : kind === 'text-generation' && device === 'webgpu'
      ? 'fp16'
      : undefined;
  if (requested && requested !== 'auto') return requested;

  const curated = catalogEntry(model);
  let variants: ModelVariant[] | undefined;
  try {
    variants = (await fetchModelDetail(model)).variants;
  } catch {
    variants = undefined;
  }
  if (variants?.length) {
    const wanted = curated?.dtype;
    const pick =
      (wanted ? variants.find((v) => v.dtype === wanted && (device === 'wasm' || v.webgpuSafe)) : null) ??
      chooseVariant(variants, device, task);
    if (pick) {
      if (wanted && pick.dtype !== wanted) {
        dtypeWarnings.set(model, `repo has no ${wanted} export for ${device}; using ${pick.dtype} (${pick.bytes ? Math.round(pick.bytes / 1024 / 1024) + 'MB' : '?'}).`);
      }
      return pick.dtype;
    }
    throw new LLMError(
      `${model} has no ONNX export transformers.js can load (found: ` +
        variants.map((v) => v.dtype).join(', ') +
        ').',
      false,
    );
  }
  return curated?.dtype ?? legacy;
}

export function peekDtypeWarning(model: string): string | undefined {
  return dtypeWarnings.get(model);
}

async function getPipeline(kind: PipelineKind): Promise<any> {
  const { webgpu } = getSettings().ai;
  const model = kind === 'text-generation' ? webgpu.chatModel : webgpu.embeddingModel;
  if (!model) throw new LLMError('Set the ' + kind + ' model id in Settings.', false);
  const device = (await hasWebgpu()) ? webgpu.device : 'wasm';
  const key = kind + ':' + model + ':' + device + ':' + (kind === 'text-generation' ? webgpu.dtype : webgpu.embeddingDtype);
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
    const dtype = await resolveDtype(model, kind, device);
    const options: any = {
      device,
      ...(dtype ? { dtype } : {}),
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

/**
 * Small instruct models with a thinking mode (Qwen3, LFM2.5-Thinking) happily
 * spend their whole budget narrating. Drop the block, and if all we got was a
 * block, fall back to the raw text so the agent never says nothing.
 */
export function stripReasoning(text: string): string {
  if (!text) return text;
  if (!/<\s*(thinking|think|reasoning|\|thinking\|)>/i.test(text)) return text;
  const closed = text.replace(/<\s*(thinking|think|reasoning)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  const open = closed.replace(/[\s\S]*<\s*(?:thinking|think|reasoning)\s*>/i, '');
  const withoutTags = open.replace(/<\s*\/?\s*(?:thinking|think|reasoning)\s*>/gi, '');
  const candidate = withoutTags.trim();
  if (!candidate) {
    // Unterminated: keep whatever followed the tag, else return the original.
    const tail = text.split(/<\s*\/\s*(?:thinking|think|reasoning)\s*>/i).pop() ?? '';
    return tail.replace(/<\s*\/?\s*(?:thinking|think|reasoning)\s*>/gi, '').trim() || text.trim();
  }
  return candidate;
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
  if (getSettings().ai.webgpu.stripReasoning) text = stripReasoning(text);
  const line = text.trim().split('\n').filter(Boolean).pop() ?? '';
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
  dtypeWarnings.clear();
  ready = false;
  lastError = null;
  transformersModule = null;
  notify();
}

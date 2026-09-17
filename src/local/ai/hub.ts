/**
 * Hugging Face hub client for model discovery.
 *
 * This is the "backend" for the model list: we call the public hub API straight
 * from the tab (no proxy, no key, CORS is open for GET /api/*). Everything here
 * degrades gracefully - when the network is unavailable the picker falls back to
 * the curated catalog in ./webgpuCatalog.ts and to whatever is already in the
 * browser cache.
 *
 * Point `ai.hubBase` at a mirror (e.g. https://hf-mirror.com) or at a static
 * directory of `models.json` you serve yourself if you want a fully offline list.
 */

import { getSettings } from '../db/settings';
import { LLMError } from './http';
import { webgpuBlockedDtypes } from './webgpuCatalog';

export const HUGGINGFACE_BASE = 'https://huggingface.co';

export type HubTask =
  | 'text-generation'
  | 'feature-extraction'
  | 'image-text-to-text'
  | 'any';

export type HubSort = 'downloads' | 'likes' | 'modified' | 'trending';

export type HubModelSummary = {
  /** Canonical repo id, e.g. `LiquidAI/LFM2.5-1.2B-Instruct-ONNX`. */
  id: string;
  author: string;
  task?: string;
  downloads: number;
  likes: number;
  tags: string[];
  /** Tagged `webgpu` on the hub. */
  webgpu: boolean;
  /** `library_name: transformers.js` (or the tag) - the format we can load. */
  transformersJs: boolean;
  /** `llama`, `lfm2`, `qwen2`, ... from `config.json` when the payload has it. */
  modelType?: string;
  architectures: string[];
  /** Has a chat template, i.e. safe to feed raw message lists. */
  conversational: boolean;
  license?: string;
  languages: string[];
  updatedAt?: string;
  createdAt?: string;
};

/** A loadable precision of one repo, derived from the `onnx/` file listing. */
export type ModelVariant = {
  /** transformers.js `dtype` key: fp32 | fp16 | bf16 | q8 | q4 | q4f16 | int8 | uint8 */
  dtype: string;
  /** The file the pipeline will actually open. */
  entry: string;
  /** Total bytes of every file that belongs to this precision. */
  bytes: number;
  /** Present but split across shards (model.onnx_data, _1, _2 ...). */
  sharded: boolean;
  /** We know ONNX Runtime Web has no kernels for this on this architecture. */
  webgpuSafe: boolean;
  /** Older `model_quantized.onnx` naming, implies a legacy export. */
  legacyQuantized: boolean;
};

export type ModelDetail = {
  id: string;
  variants: ModelVariant[];
  modelType?: string;
  architectures: string[];
  hasChatTemplate: boolean;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  gated?: boolean;
  /** Total repo size on disk, all precisions together. */
  bytes: number;
};

export type SearchOptions = {
  query?: string;
  task?: HubTask;
  /** Only `webgpu`-tagged repos (the hub filter, not a name guess). */
  onlyWebgpu?: boolean;
  /** Only repos the transformers.js docs claim to load. */
  onlyTransformersJs?: boolean;
  sort?: HubSort;
  limit?: number;
  /** Ignore the 6h response cache (what the Refresh button passes). */
  force?: boolean;
  signal?: AbortSignal;
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = 'aifavella.hubCache';
type CacheEntry = { at: number; value: unknown };
const memory = new Map<string, CacheEntry>();

function ssafe(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readCache<T>(key: string): T | null {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const store = ssafe();
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, CacheEntry>;
    const entry = all[key];
    if (!entry || Date.now() - entry.at > CACHE_TTL_MS) return null;
    memory.set(key, entry);
    return entry.value as T;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown) {
  memory.set(key, { at: Date.now(), value });
  const store = ssafe();
  if (!store) return;
  try {
    const raw = store.getItem(CACHE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, CacheEntry>) : {};
    all[key] = { at: Date.now(), value };
    // Keep the payload small: newest 80 entries only.
    const trimmed = Object.fromEntries(
      Object.entries(all)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 80),
    );
    store.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota - memory cache still holds it */
  }
}

export function hubBase(): string {
  const configured = getSettings().ai.hubBase?.trim();
  const base = configured || HUGGINGFACE_BASE;
  return base.replace(/\/+$/, '');
}

async function hubFetch(url: string, signal?: AbortSignal): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (e: any) {
    throw new LLMError(
      `Could not reach ${hubBase()} (${e?.message ?? e}). The model list falls back to the built-in catalog - ` +
        'check your connection, or set a mirror under "Hub API base URL".',
      true,
    );
  }
  if (!response.ok) {
    throw new LLMError(`Hub request failed (${response.status} ${response.statusText}) for ${url}`, false);
  }
  return response.json();
}

/** Turn a hub `/api/models` item into our summary shape. Pure, so tests can feed fixtures. */
export function toModelSummary(item: any): HubModelSummary | null {
  const id: string | undefined = item?.id ?? item?.modelId;
  if (!id || typeof id !== 'string') return null;
  const tags: string[] = Array.isArray(item?.tags) ? item.tags.map(String) : [];
  const config = item?.config ?? {};
  const architectures: string[] = Array.isArray(config.architectures)
    ? config.architectures.map(String)
    : [];
  return {
    id,
    author: item?.author ?? (id.includes('/') ? id.split('/')[0] : ''),
    task: item?.pipeline_tag ?? undefined,
    downloads: Number(item?.downloads ?? 0) || 0,
    likes: Number(item?.likes ?? 0) || 0,
    tags,
    webgpu: tags.includes('webgpu'),
    transformersJs: item?.library_name === 'transformers.js' || tags.includes('transformers.js'),
    modelType: typeof config.model_type === 'string' ? config.model_type : undefined,
    architectures,
    conversational: tags.includes('conversational'),
    license: tags.find((t) => t.startsWith('license:'))?.slice('license:'.length),
    languages: tags.filter((t) => /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(t)),
    updatedAt: item?.lastModified ?? undefined,
    createdAt: item?.createdAt ?? undefined,
  };
}

export async function searchHub(options: SearchOptions = {}): Promise<HubModelSummary[]> {
  const {
    query = '',
    task = 'text-generation',
    onlyWebgpu = false,
    onlyTransformersJs = true,
    sort = 'downloads',
    limit = 40,
    force = false,
    signal,
  } = options;

  const params = new URLSearchParams();
  const filters: string[] = [];
  if (onlyWebgpu) filters.push('webgpu');
  if (onlyTransformersJs) filters.push('transformers.js');
  if (filters.length) params.set('filter', filters.join(','));
  if (task !== 'any') params.set('pipeline_tag', task);
  if (query.trim()) params.set('search', query.trim());
  params.set('sort', sort === 'trending' ? 'trendingScore' : sort);
  params.set('direction', '-1');
  params.set('limit', String(Math.max(1, Math.min(100, limit))));

  const url = `${hubBase()}/api/models?${params.toString()}${force ? '&fresh=' + Date.now() : ''}`;
  const cached = force ? null : readCache<HubModelSummary[]>(url);
  if (cached) return cached;
  const payload = await hubFetch(url, signal);
  if (!Array.isArray(payload)) return [];
  const models = payload.map(toModelSummary).filter((m): m is HubModelSummary => !!m);
  writeCache(url, models);
  return models;
}

const DTYPE_SUFFIXES: { dtype: string; suffix: string }[] = [
  { dtype: 'fp32', suffix: '' },
  { dtype: 'fp16', suffix: '_fp16' },
  { dtype: 'bf16', suffix: '_bf16' },
  { dtype: 'q8', suffix: '_q8' },
  { dtype: 'q4', suffix: '_q4' },
  { dtype: 'q4f16', suffix: '_q4f16' },
  { dtype: 'int8', suffix: '_int8' },
  { dtype: 'uint8', suffix: '_uint8' },
  { dtype: 'bnb4', suffix: '_bnb4' },
];

/**
 * `onnx/model_q4.onnx` -> q4, `onnx/model.onnx_data_2` -> fp32, `tokenizer.json`
 * -> null. Same shape for every optimum/transformers.js export: the precision is
 * the suffix on `model`, and the `_data` files are weights for that precision.
 */
const ONNX_FILE = /^(?:.*\/)?model(?:(_[a-z0-9]+))?\.onnx(?:_data(?:_\d+)?)?$/i;

function parseOnnxFile(name: string): { dtype: string; isWeights: boolean } | null {
  const match = ONNX_FILE.exec(name);
  if (!match) return null;
  const suffix = match[1] ?? '';
  const isWeights = /_data/i.test(name);
  if (!suffix) return { dtype: 'fp32', isWeights };
  if (suffix === '_quantized') return { dtype: 'q8', isWeights };
  const found = DTYPE_SUFFIXES.find((d) => d.suffix === suffix);
  return found ? { dtype: found.dtype, isWeights } : null;
}

/**
 * Group a repo's files into the precisions transformers.js can load, with the
 * download size of each. Sibling shape is the hub API's `siblings[]`
 * (`{ rfilename, size }`); size is the blob size when `?blobs=true` is used.
 */
export function variantsFromSiblings(
  siblings: { rfilename?: string; name?: string; size?: number; lfs?: { size?: number } }[],
  modelType?: string,
): ModelVariant[] {
  const buckets = new Map<string, { entry: string; bytes: number; shards: number; legacy: boolean }>();
  for (const sibling of siblings) {
    const name = String(sibling?.rfilename ?? sibling?.name ?? '');
    const parsed = parseOnnxFile(name);
    if (!parsed) continue;
    const bytes = Number(sibling?.lfs?.size ?? sibling?.size ?? 0) || 0;
    const bucket =
      buckets.get(parsed.dtype) ?? { entry: name, bytes: 0, shards: 0, legacy: false };
    bucket.bytes += bytes;
    if (!parsed.isWeights) bucket.entry = name;
    else bucket.shards += 1;
    bucket.legacy = bucket.legacy || /model_quantized\.onnx$/i.test(name);
    buckets.set(parsed.dtype, bucket);
  }
  const out: ModelVariant[] = [];
  for (const [dtype, bucket] of buckets) {
    if (!/\.onnx$/i.test(bucket.entry)) continue; // weights without a graph: unusable
    out.push({
      dtype,
      entry: bucket.entry,
      bytes: bucket.bytes,
      sharded: bucket.shards > 0,
      legacyQuantized: bucket.legacy,
      // e.g. Liquid's LFM2.5 q8 export: no WebGPU kernels for its conv/gate ops.
      webgpuSafe: !webgpuBlockedDtypes(modelType).includes(dtype),
    });
  }
  // Cheapest first: on a phone that is the only thing worth offering.
  out.sort((a, b) => a.bytes - b.bytes);
  return out;
}

export function parseModelDetail(payload: any): ModelDetail | null {
  const id: string | undefined = payload?.id ?? payload?.modelId;
  if (!id) return null;
  const siblings = Array.isArray(payload?.siblings) ? payload.siblings : [];
  const modelType = typeof payload?.config?.model_type === 'string' ? payload.config.model_type : undefined;
  const architectures: string[] = Array.isArray(payload?.config?.architectures)
    ? payload.config.architectures.map(String)
    : [];
  const hasChatTemplate = !!(
    payload?.config?.tokenizer_config?.chat_template ||
    siblings.some((s: any) => /chat_template\.(jinja|json)$/.test(String(s?.rfilename ?? '')))
  );
  return {
    id,
    variants: variantsFromSiblings(siblings, modelType),
    modelType,
    architectures,
    hasChatTemplate,
    downloads: Number(payload?.downloads ?? 0) || undefined,
    likes: Number(payload?.likes ?? 0) || undefined,
    lastModified: payload?.lastModified ?? undefined,
    gated: payload?.gated ? true : undefined,
    bytes: siblings.reduce((sum: number, s: any) => sum + (Number(s?.lfs?.size ?? s?.size ?? 0) || 0), 0),
  };
}

export async function fetchModelDetail(id: string, signal?: AbortSignal): Promise<ModelDetail> {
  const url = `${hubBase()}/api/models/${encodeURIComponent(id)}?blobs=true`;
  const cached = readCache<ModelDetail>(url);
  if (cached) return cached;
  const payload = await hubFetch(url, signal);
  const detail = parseModelDetail(payload);
  if (!detail) throw new LLMError(`Hub returned no information about ${id}.`, false);
  writeCache(url, detail);
  return detail;
}

/**
 * Pick the precision to load when the user left it on "auto".
 * Smallest WebGPU-capable variant wins; on WASM we prefer a real int8/q8 if the
 * repo has one because it is far faster there than dequantising fp16.
 */
export function chooseVariant(
  variants: ModelVariant[],
  device: 'webgpu' | 'wasm',
  task: HubTask = 'text-generation',
): ModelVariant | null {
  const usable = variants.filter((v) => (device === 'webgpu' ? v.webgpuSafe : true));
  const pool = usable.length ? usable : variants;
  if (!pool.length) return null;
  if (device === 'wasm' && task === 'text-generation') {
    const quant = pool.find((v) => v.dtype === 'q8' || v.dtype === 'int8' || v.dtype === 'uint8');
    if (quant) return quant;
  }
  return pool[0];
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

/**
 * What the tab has already downloaded. transformers.js keeps model files in the
 * Cache Storage API under `transformers-cache`; this is how the picker can say
 * "cached, 812MB, no download needed" and let you evict a model again.
 */
export async function listCachedModels(): Promise<{ model: string; files: number; bytes: number }[]> {
  if (typeof caches === 'undefined') return [];
  const byModel = new Map<string, { files: number; bytes: number }>();
  try {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const request of keys) {
        const url = new URL(request.url);
        const parts = url.pathname.split('/').filter(Boolean);
        // /{org}/{repo}/resolve/{rev}/{file}
        const model = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? 'unknown';
        const response = await cache.match(request);
        const bytes = Number(response?.headers.get('content-length') ?? 0) || 0;
        const entry = byModel.get(model) ?? { files: 0, bytes: 0 };
        entry.files += 1;
        entry.bytes += bytes;
        byModel.set(model, entry);
      }
    }
  } catch {
    return [...byModel.entries()].map(([model, v]) => ({ model, ...v }));
  }
  return [...byModel.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Delete every cached file belonging to one repo. */
export async function evictCachedModel(id: string): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  let deleted = 0;
  for (const name of await caches.keys()) {
    if (!/transformers/i.test(name)) continue;
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      if (!request.url.includes(`/${id}/`)) continue;
      if (await cache.delete(request)) deleted++;
    }
  }
  return deleted;
}

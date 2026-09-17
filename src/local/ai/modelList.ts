/**
 * The list behind the model pickers in Settings.
 *
 * Three sources, merged and de-duplicated:
 *  1. the built-in catalog (works with no network at all),
 *  2. a hub scan for WebGPU/ONNX repos (`Refresh list`),
 *  3. for HTTP providers, whatever your own server reports (Ollama /api/tags,
 *     /v1/models, OpenRouter's public catalogue).
 *
 * Results are cached in localStorage so the panel is populated the moment it
 * opens and the town keeps working on a plane.
 */

import { getSettings } from '../db/settings';
import { catalogFor, type CatalogTask } from './webgpuCatalog';
import { formatBytes, searchHub, type HubModelSummary } from './hub';

export type ModelSource = 'builtin' | 'hub' | 'server';

export type ModelChoice = {
  id: string;
  label: string;
  source: ModelSource;
  task: CatalogTask;
  /** Precision to request; undefined = let the loader decide from the repo. */
  dtype?: string;
  /** Rough download size for that precision, when we know it. */
  approxBytes?: number;
  webgpu?: boolean;
  conversational?: boolean;
  downloads?: number;
  likes?: number;
  modelType?: string;
  license?: string;
  /** False = selectable, but our pipeline cannot drive it yet. */
  supported?: boolean;
  note?: string;
};

export type ModelList = {
  chat: ModelChoice[];
  embeddings: ModelChoice[];
  fetchedAt?: number;
  /** True when the last refresh could not reach anything. */
  offline: boolean;
  error?: string;
};

const CACHE_KEY = 'aifavella.modelList';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** True when the cached scan is older than the TTL and should be re-run. */
export function isStale(list: ModelList | null | undefined): boolean {
  if (!list) return true;
  return !list.fetchedAt || Date.now() - list.fetchedAt > CACHE_TTL_MS;
}

export function readModelList(): ModelList | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelList;
    if (!parsed || !Array.isArray(parsed.chat)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeModelList(list: ModelList) {
  const s = store();
  if (!s) return;
  try {
    s.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    /* quota; the in-memory defaults are still fine */
  }
}

/** Built-in list, always available. */
export function builtinChoices(task: CatalogTask): ModelChoice[] {
  return catalogFor(task).map((entry) => ({
    id: entry.id,
    label: entry.label,
    source: 'builtin' as const,
    task: entry.task,
    dtype: entry.dtype,
    approxBytes: entry.approxBytes,
    webgpu: true,
    conversational: entry.task === 'text-generation' ? true : undefined,
    modelType: entry.modelType,
    supported: entry.supported,
    note: entry.why,
  }));
}

/** 3979 -> "4k", 1484248 -> "1.5M" - the hub numbers are noisy at full length. */
function compact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const units = ['k', 'M', 'B'];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')}${units[unit]}`;
}

export { compact as formatCount };

function hubLabel(id: string): string {
  const repo = id.split('/').pop() ?? id;
  return repo
    .replace(/[-_]/g, ' ')
    .replace(/(\d)([A-Za-z])|([A-Za-z])(\d)/g, (m) => m[0] + ' ' + m.slice(1))
    .replace(/\bOnnx\b|\bGguf\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hubChoices(models: HubModelSummary[], task: CatalogTask): ModelChoice[] {
  return models.map((model) => ({
    id: model.id,
    label: hubLabel(model.id),
    source: 'hub' as const,
    task,
    webgpu: model.webgpu,
    conversational: model.conversational || undefined,
    downloads: model.downloads,
    likes: model.likes,
    modelType: model.modelType,
    license: model.license,
    supported: true,
    note: [
      model.downloads ? `${compact(model.downloads)} downloads/mo` : null,
      model.likes ? `${compact(model.likes)} likes` : null,
      model.updatedAt ? `updated ${model.updatedAt.slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
}

/** Merge builtin + hub, keeping the builtin entry (with its dtype hint). */
export function mergeChoices(builtin: ModelChoice[], hub: ModelChoice[]): ModelChoice[] {
  const byId = new Map<string, ModelChoice>();
  for (const choice of hub) byId.set(choice.id, choice);
  for (const choice of builtin) {
    const existing = byId.get(choice.id);
    byId.set(choice.id, existing ? { ...existing, ...choice, note: choice.note ?? existing.note } : choice);
  }
  return [...byId.values()];
}

export type RefreshOptions = { query?: string; limit?: number; force?: boolean; signal?: AbortSignal };

/**
 * Re-populate the model list. With a query the hub search is scoped to it, so
 * "liquid" or "smol" narrows the dropdown the same way the hub UI does.
 */
export async function refreshModelList(options: RefreshOptions = {}): Promise<ModelList> {
  const { query = '', limit = 50, force = false, signal } = options;
  const chat = builtinChoices('text-generation');
  const embeddings = builtinChoices('feature-extraction');
  const ai = getSettings().ai;
  const list: ModelList = { chat, embeddings, offline: false };

  const wantsHub = ai.provider === 'webgpu' || !!query.trim();
  if (!wantsHub) return list;

  try {
    const [hubChat, hubEmbeddings] = await Promise.all([
      searchHub({
        query,
        task: 'text-generation',
        onlyWebgpu: false,
        onlyTransformersJs: true,
        limit,
        force,
        signal,
      }),
      searchHub({
        query,
        task: 'feature-extraction',
        onlyWebgpu: false,
        onlyTransformersJs: true,
        limit: Math.min(limit, 25),
        force,
        signal,
      }),
    ]);
    list.chat = mergeChoices(chat, hubChoices(hubChat, 'text-generation'));
    list.embeddings = mergeChoices(embeddings, hubChoices(hubEmbeddings, 'feature-extraction'));
    list.fetchedAt = Date.now();
  } catch (e: any) {
    list.offline = true;
    list.error = e?.message ?? String(e);
  }
  writeModelList(list);
  return list;
}

export type ServerModel = { id: string; label: string; note?: string; bytes?: number };

/**
 * Models a running local/hosted server offers. Ollama reports rich metadata;
 * OpenAI-compatible servers (LM Studio, llama.cpp server, vLLM) only list ids.
 */
export async function refreshServerModels(signal?: AbortSignal): Promise<{ models: ServerModel[]; error?: string }> {
  const ai = getSettings().ai;
  const base = (ai.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { models: [], error: 'Set a base URL first.' };
  const headers: Record<string, string> = { accept: 'application/json' };
  if (ai.apiKey) headers.authorization = `Bearer ${ai.apiKey}`;

  const get = async (url: string) => {
    const response = await fetch(url, { signal, headers });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  };

  try {
    if (ai.provider === 'ollama') {
      const origin = base.replace(/\/v\d+$/, '');
      const payload = await get(`${origin}/api/tags`);
      const models: ServerModel[] = (Array.isArray(payload?.models) ? payload.models : [])
        .map((m: any) => ({
          id: String(m?.name ?? m?.model ?? ''),
          label: String(m?.name ?? m?.model ?? ''),
          bytes: Number(m?.size ?? 0) || undefined,
          note: [
            m?.details?.parameter_size ? String(m.details.parameter_size) : null,
            m?.details?.quantization_level ? String(m.details.quantization_level) : null,
            m?.modified_at ? `added ${String(m.modified_at).slice(0, 10)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }))
        .filter((m: ServerModel) => m.id);
      return { models };
    }
    if (ai.provider === 'openrouter') {
      const payload = await get('https://openrouter.ai/api/v1/models');
      const models: ServerModel[] = (Array.isArray(payload?.data) ? payload.data : [])
        .map((m: any) => ({
          id: String(m?.id ?? ''),
          label: String(m?.name ?? m?.id ?? ''),
          note: [
            m?.context_length ? `${Math.round(Number(m.context_length) / 1000)}k ctx` : null,
            m?.pricing?.prompt
              ? `$${(Number(m.pricing.prompt) * 1e6).toFixed(2)}/M in`
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }))
        .filter((m: ServerModel) => m.id);
      return { models };
    }
    const payload = await get(`${base}/models`);
    const models: ServerModel[] = (Array.isArray(payload?.data) ? payload.data : [])
      .map((m: any) => ({
        id: String(m?.id ?? ''),
        label: String(m?.id ?? ''),
        note: m?.owned_by ? `owner: ${m.owned_by}` : undefined,
      }))
      .filter((m: ServerModel) => m.id);
    return { models };
  } catch (e: any) {
    return {
      models: [],
      error:
        `${e?.message ?? e} - if this is LM Studio, tick "CORS: Allow all origins" in its server ` +
        'settings; for Ollama, allow the browser origin in OLLAMA_ORIGINS.',
    };
  }
}

export function describeChoice(choice: ModelChoice): string {
  const bits: string[] = [];
  if (choice.approxBytes) bits.push(formatBytes(choice.approxBytes));
  if (choice.dtype) bits.push(choice.dtype);
  if (choice.modelType) bits.push(choice.modelType);
  if (choice.source === 'hub') bits.push('hub');
  return bits.join(' · ');
}

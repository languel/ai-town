/**
 * Settings live in localStorage: they're small, they need to be readable before
 * the async database opens, and they're the thing a user wants to survive a
 * reload instantly. Big/structured data lives in IndexedDB (`src/local/db`).
 */

export type ProviderKind =
  | 'mock'
  | 'openai'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'webgpu';

export type EmbeddingSource = 'provider' | 'webgpu' | 'hash' | 'off';

export type Settings = {
  ai: {
    provider: ProviderKind;
    /** Base URL for OpenAI-compatible endpoints, e.g. http://localhost:11434/v1 */
    baseUrl: string;
    apiKey: string;
    chatModel: string;
    temperature: number;
    maxTokens: number;
    stream: boolean;
    /** Extra stop sequences appended to every request. */
    stopWords: string[];
    embeddingSource: EmbeddingSource;
    embeddingModel: string;
    embeddingBaseUrl: string;
    embeddingApiKey: string;
    webgpu: {
      /** Where to `import()` transformers.js from. */
      cdnUrl: string;
      device: 'webgpu' | 'wasm';
      chatModel: string;
      embeddingModel: string;
      /** Smaller download, slightly lower quality. */
      quantized: boolean;
    };
    /** Max concurrent LLM requests fired by the town. */
    concurrency: number;
    requestTimeoutMs: number;
    /** Kill-switch: when false, agents act on rules only (no LLM calls). */
    enabled: boolean;
    /** Per-word delay the offline improviser pretends to have, in ms (0 = instant). */
    mockLatencyMs: number;
    useFor: {
      chat: boolean;
      memories: boolean;
      importance: boolean;
      reflections: boolean;
    };
  };
  sim: {
    /** Simulation ticks per second. */
    tickHz: number;
    /** Persist the world to IndexedDB every N ms. */
    saveIntervalMs: number;
    /** Run agent AI while the tab is in the background (slower, background timers). */
    runWhenHidden: boolean;
    movementSpeed: number;
    /** Seconds an idle agent waits before doing something. */
    conversationCooldownMs: number;
    maxAgents: number;
    autoStart: boolean;
  };
  player: {
    name: string;
    character: string;
    description: string;
    joinOnLoad: boolean;
  };
};

export const DEFAULT_SETTINGS: Settings = {
  ai: {
    provider: 'mock',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    chatModel: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 300,
    stream: true,
    stopWords: [],
    embeddingSource: 'hash',
    embeddingModel: 'text-embedding-3-small',
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    webgpu: {
      cdnUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5',
      device: 'webgpu',
      chatModel: 'onnx-community/Llama-3.2-1B-Instruct',
      embeddingModel: 'Xenova/all-MiniLM-L6-v2',
      quantized: true,
    },
    concurrency: 2,
    requestTimeoutMs: 120_000,
    enabled: true,
    mockLatencyMs: 14,
    useFor: { chat: true, memories: true, importance: true, reflections: true },
  },
  sim: {
    tickHz: 30,
    saveIntervalMs: 2000,
    runWhenHidden: false,
    movementSpeed: 1.1,
    conversationCooldownMs: 15000,
    maxAgents: 24,
    autoStart: true,
  },
  player: {
    name: 'You',
    character: 'f3',
    description: 'You are a human player exploring the town.',
    joinOnLoad: true,
  },
};

export const PROVIDER_PRESETS: Record<
  ProviderKind,
  { label: string; hint: string; patch: Partial<Settings['ai']> }
> = {
  mock: {
    label: 'Built-in improviser (no model)',
    hint: 'Rule-based, offline. The whole town runs with zero setup.',
    patch: { provider: 'mock', embeddingSource: 'hash', enabled: true },
  },
  openai: {
    label: 'OpenAI',
    hint: 'Needs CORS-friendly browser use; api.openai.com blocks browser origins, so many people prefer a proxy or OpenRouter.',
    patch: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      chatModel: 'gpt-4o-mini',
      embeddingSource: 'provider',
      embeddingModel: 'text-embedding-3-small',
      stopWords: [],
    },
  },
  openrouter: {
    label: 'OpenRouter',
    hint: 'Browser-friendly; bring any model id, e.g. meta-llama/llama-3.1-8b-instruct.',
    patch: {
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      chatModel: 'meta-llama/llama-3.1-8b-instruct',
      embeddingSource: 'hash',
      stopWords: [],
    },
  },
  ollama: {
    label: 'Ollama (local)',
    hint: 'Run `OLLAMA_ORIGINS=* ollama serve` so the browser may call it.',
    patch: {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'llama3.2',
      embeddingSource: 'provider',
      embeddingModel: 'mxbai-embed-large',
      stopWords: ['<|eot_id|>'],
    },
  },
  lmstudio: {
    label: 'LM Studio (local)',
    hint: 'Enable "CORS: Allow all origins" in the LM Studio server settings.',
    patch: {
      provider: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      chatModel: 'local-model',
      embeddingSource: 'provider',
      embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
      stopWords: [],
    },
  },
  'openai-compatible': {
    label: 'Custom OpenAI-compatible',
    hint: 'Any server exposing /v1/chat/completions and (optionally) /v1/embeddings.',
    patch: {
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:8000/v1',
      chatModel: 'model',
      embeddingSource: 'provider',
      embeddingModel: 'embedding-model',
      stopWords: [],
    },
  },
  webgpu: {
    label: 'In-browser WebGPU (transformers.js)',
    hint: 'Downloads the model into the browser cache once, then runs fully offline.',
    patch: { provider: 'webgpu', embeddingSource: 'webgpu', chatModel: '', stopWords: [] },
  },
};

const KEY = 'aifavella.settings';
const listeners = new Set<() => void>();

function merge<T>(base: T, override: any): T {
  if (override === undefined || override === null) return base;
  const out: any = Array.isArray(base) ? base : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = (base as any)?.[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? merge(current, value)
        : value;
  }
  return out;
}

let current: Settings = load();

function load(): Settings {
  if (typeof localStorage === 'undefined') return structuredCloneSafe(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredCloneSafe(DEFAULT_SETTINGS);
    return merge(structuredCloneSafe(DEFAULT_SETTINGS), JSON.parse(raw));
  } catch (e) {
    console.warn('Bad settings in localStorage, using defaults', e);
    return structuredCloneSafe(DEFAULT_SETTINGS);
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getSettings(): Settings {
  return current;
}

export function subscribeSettings(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSettingsRevision() {
  return current;
}

export function updateSettings(patch: DeepPartial<Settings>): Settings {
  current = merge(current, patch);
  persist();
  return current;
}

export function setSettings(settings: Settings) {
  current = structuredCloneSafe(settings);
  persist();
}

function persist() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch (e) {
    console.warn('Could not persist settings', e);
  }
  for (const listener of listeners) listener();
}

export function resetSettings() {
  current = structuredCloneSafe(DEFAULT_SETTINGS);
  persist();
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Generic reactive localStorage value (used for UI state + prompt overrides). */
export function createLocalStore<T>(key: string, defaultValue: T) {
  let value = read();
  const subs = new Set<() => void>();
  function read(): T {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      return raw ? merge(structuredCloneSafe(defaultValue), JSON.parse(raw)) : structuredCloneSafe(defaultValue);
    } catch {
      return structuredCloneSafe(defaultValue);
    }
  }
  return {
    get: () => value,
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    getSnapshot: () => value,
    set(next: T) {
      value = next;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(key, JSON.stringify(value));
        }
      } catch (e) {
        console.warn(`Could not save ${key}`, e);
      }
      for (const s of subs) s();
    },
    update(patch: DeepPartial<T>) {
      this.set(merge(value, patch) );
    },
    reset() {
      this.set(structuredCloneSafe(defaultValue));
    },
  };
}

/**
 * Curated list of models that are known to load in a browser tab.
 *
 * The picker shows these first (offline, zero requests) and then whatever a hub
 * scan returns - see ./hub.ts. Every id here was checked against
 * `https://huggingface.co/api/models` on 2026-09-17; the sizes are the WebGPU
 * precision we recommend, not the whole repo.
 */

export type CatalogTask = 'text-generation' | 'feature-extraction' | 'image-text-to-text';

export type CatalogEntry = {
  /** Hub repo id, exactly what you would paste into `chatModel`. */
  id: string;
  task: CatalogTask;
  label: string;
  /** One line in the picker: why you would pick this one. */
  why: string;
  /** Precision to request from transformers.js; `auto` = smallest WebGPU-safe one. */
  dtype?: 'q4' | 'q4f16' | 'fp16' | 'fp32' | 'q8';
  /** Architecture key from config.json (`llama`, `lfm2`, ...). */
  modelType?: string;
  /** Rough download for `dtype`, used for the "this will take a while" hint. */
  approxBytes?: number;
  /** False = we know the hub has it but our pipeline cannot drive it (yet). */
  supported: boolean;
  note?: string;
  languages?: string[];
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const WEBGPU_CATALOG: CatalogEntry[] = [
  // ---- chat: small enough to run a whole town in one tab --------------------
  {
    id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    task: 'text-generation',
    label: 'SmolLM2 360M Instruct',
    why: 'Default. Fast enough that six agents keep talking; short-line prose is good.',
    dtype: 'q8',
    modelType: 'llama',
    approxBytes: 400 * MB,
    supported: true,
    languages: ['en'],
  },
  {
    id: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    task: 'text-generation',
    label: 'SmolLM2 135M Instruct',
    why: 'Lightest usable option - phones, integrated GPUs, or when you just want it to move.',
    dtype: 'q8',
    modelType: 'llama',
    approxBytes: 150 * MB,
    supported: true,
    languages: ['en'],
  },
  {
    id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    task: 'text-generation',
    label: 'SmolLM2 1.7B Instruct',
    why: 'Noticeably better conversations, costs a few seconds per reply on a laptop GPU.',
    dtype: 'q4',
    modelType: 'llama',
    approxBytes: 1.1 * GB,
    supported: true,
    languages: ['en'],
  },
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    task: 'text-generation',
    label: 'Qwen2.5 0.5B Instruct',
    why: 'Punchy for its size, and the strongest multilingual of the small set.',
    dtype: 'q4',
    modelType: 'qwen2',
    approxBytes: 400 * MB,
    supported: true,
    languages: ['en', 'zh', 'fr', 'es', 'de', 'it', 'pt', 'ja', 'ko', 'ru'],
  },
  {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    task: 'text-generation',
    label: 'Qwen3 0.6B',
    why: 'Newer, slightly wittier; may emit a thinking block before the line.',
    dtype: 'q4',
    modelType: 'qwen3',
    approxBytes: 500 * MB,
    supported: true,
    note: 'May narrate its reasoning before answering - turn on "Strip reasoning" in the Model tab.',
    languages: ['en', 'zh'],
  },
  {
    id: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    task: 'text-generation',
    label: 'Llama 3.2 1B Instruct',
    why: 'The old default, kept here. Needs ~1.5GB of VRAM for fp16.',
    dtype: 'q4',
    modelType: 'llama',
    approxBytes: 900 * MB,
    supported: true,
    languages: ['en'],
  },
  // ---- chat: Liquid AI (LFM2.5) ---------------------------------------------
  {
    id: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    task: 'text-generation',
    label: 'Liquid LFM2.5 1.2B Instruct',
    why: 'Edge-tuned hybrid (conv + gated attention): quick decode, good instruction following.',
    dtype: 'q4',
    modelType: 'lfm2',
    approxBytes: 850 * MB,
    supported: true,
    note: 'WebGPU supports q4/fp16 only (q8 has no kernels for the conv/gate ops). Needs transformers.js 4.x - lfm2 landed in 4.0.0.',
    languages: ['en', 'ja', 'ko', 'fr', 'es', 'de', 'it', 'pt', 'ar', 'zh'],
  },
  {
    id: 'LiquidAI/LFM2.5-230M-ONNX',
    task: 'text-generation',
    label: 'Liquid LFM2.5 230M',
    why: 'The smallest LFM2.5 - loads in a second, fine for a background crowd of agents.',
    dtype: 'q4',
    modelType: 'lfm2',
    approxBytes: 170 * MB,
    supported: true,
    languages: ['en', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'it', 'pt', 'ar'],
  },
  {
    id: 'LiquidAI/LFM2.5-2.6B-ONNX',
    task: 'text-generation',
    label: 'Liquid LFM2.5 2.6B',
    why: 'Best in-browser prose right now; wants a real GPU and ~2.4GB free.',
    dtype: 'q4f16',
    modelType: 'lfm2',
    approxBytes: 2.4 * GB,
    supported: true,
    languages: ['en', 'ja', 'ko', 'fr', 'es', 'de', 'it', 'pt', 'ar', 'zh', 'ru', 'hi'],
  },
  {
    id: 'LiquidAI/LFM2.5-1.2B-Thinking-ONNX',
    task: 'text-generation',
    label: 'Liquid LFM2.5 1.2B Thinking',
    why: 'Reasons before answering, which the town finds oddly convincing.',
    dtype: 'q4',
    modelType: 'lfm2',
    approxBytes: 850 * MB,
    supported: true,
    note: 'Slowest of the LFM set per reply: it spends tokens thinking first.',
  },
  {
    id: 'LiquidAI/LFM2.5-VL-450M-ONNX',
    task: 'image-text-to-text',
    label: 'Liquid LFM2.5 VL 450M',
    why: 'Vision-language variant. Listed for completeness.',
    dtype: 'q4',
    modelType: 'lfm2_vl',
    supported: false,
    note: 'The town only sends text today, so there is nothing for it to look at.',
  },
  // ---- chat: toy -------------------------------------------------------------
  {
    id: 'Xenova/llama2.c-stories15M',
    task: 'text-generation',
    label: 'llama2.c stories 15M (toy)',
    why: 'Instant and tiny - use it to check the pipeline, not to role-play.',
    dtype: 'fp32',
    modelType: 'llama',
    approxBytes: 60 * MB,
    supported: true,
    note: 'Trained on fairy-tale-ish stories; replies are incoherent about people.',
  },
  // ---- embeddings ------------------------------------------------------------
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    task: 'feature-extraction',
    label: 'all-MiniLM-L6-v2',
    why: 'Default. 384 dimensions, ~90MB, and good enough to rank memories.',
    dtype: 'q8',
    modelType: 'bert',
    approxBytes: 90 * MB,
    supported: true,
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    task: 'feature-extraction',
    label: 'BGE small en v1.5',
    why: 'Better recall on paraphrases if your memory bank gets big.',
    dtype: 'q8',
    modelType: 'bert',
    approxBytes: 100 * MB,
    supported: true,
  },
];

/** Everything for one slot of the settings form. */
export function catalogFor(task: CatalogTask): CatalogEntry[] {
  return WEBGPU_CATALOG.filter((entry) => entry.task === task);
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return WEBGPU_CATALOG.find((entry) => entry.id === id);
}

/**
 * Architectures transformers.js ships an implementation for - the list we are
 * confident about, not the library's full registry. Anything else is still
 * selectable, just flagged as unverified in the picker.
 */
export const KNOWN_MODEL_TYPES = new Set([
  'llama',
  'mistral',
  'mixtral',
  'gemma',
  'gemma2',
  'gemma3_text',
  'gemma3',
  'qwen2',
  'qwen3',
  'phi',
  'phi3',
  'gpt2',
  'gptj',
  'opt',
  'starcoder2',
  'lfm2',
  'lfm2_vl',
  'lfm2_moe',
  'minicpm',
  'smollm3',
  'bert',
  'distilbert',
  'roberta',
  'xlm-roberta',
  'nomic_bert',
  'mpnet',
  'clip',
  'siglip',
  'whisper',
]);

export function isKnownArchitecture(modelType?: string): boolean {
  return !!modelType && KNOWN_MODEL_TYPES.has(modelType);
}

/**
 * Dtypes ONNX Runtime Web can execute for an architecture. Liquid's LFM2.5
 * export is explicit that q8 is server-only, and int8 kernels for the conv/gate
 * ops are missing, so we must not offer it.
 */
export function webgpuBlockedDtypes(modelType?: string): string[] {
  return modelType === 'lfm2' || modelType === 'lfm2_vl' || modelType === 'lfm2_moe'
    ? ['q8', 'int8', 'uint8']
    : [];
}

export const DEFAULT_CHAT_MODEL = 'HuggingFaceTB/SmolLM2-360M-Instruct';
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

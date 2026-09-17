import { getSettings } from '../db/settings';
import { localDB } from '../db/local';
import { embedTexts, hashEmbedding } from './providers';
import { sleep } from '../engine/object';
import { retryWithBackoff, LLMError } from './http';

/**
 * Embeddings with a persistent local cache (the `embeddingsCache` table), so a
 * given sentence only costs one round-trip per browser, ever.
 */

async function sha256Hex(text: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure context fallback (still fine as a cache key).
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv${(h >>> 0).toString(16)}`;
}

export function embeddingModelKey(): string {
  const ai = getSettings().ai;
  switch (ai.embeddingSource) {
    case 'hash':
      return 'hash-384';
    case 'off':
      return 'none';
    case 'webgpu':
      return `webgpu:${ai.webgpu.embeddingModel}`;
    default:
      return `provider:${ai.embeddingModel}`;
  }
}

export async function fetchEmbedding(text: string): Promise<number[]> {
  const [embedding] = await fetchEmbeddings([text]);
  return embedding;
}

export async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const ai = getSettings().ai;
  if (ai.embeddingSource === 'off') return texts.map(() => []);
  if (ai.embeddingSource === 'hash') return texts.map((t) => hashEmbedding(t));

  const model = embeddingModelKey();
  const out: (number[] | undefined)[] = new Array(texts.length).fill(undefined);
  const missing: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const key = `${model}:${await sha256Hex(texts[i])}`;
    const cached = localDB.get<{ embedding: number[] }>('embeddingsCache', key);
    if (cached?.embedding?.length) {
      out[i] = cached.embedding;
    } else {
      missing.push(i);
    }
  }
  if (missing.length > 0) {
    const { result } = await retryWithBackoff(async () => {
      try {
        return await embedTexts(missing.map((i) => texts[i]));
      } catch (e: any) {
        // A broken embedding setup shouldn't brick the town: degrade to hashing.
        if (ai.embeddingSource === 'provider') {
          console.warn(`Embedding provider failed (${e?.message}); using local hashed embeddings.`);
          return missing.map((i) => hashEmbedding(texts[i]));
        }
        throw e;
      }
    });
    for (let n = 0; n < missing.length; n++) {
      const index = missing[n];
      const embedding = result[n];
      out[index] = embedding;
      const key = `${model}:${await sha256Hex(texts[index])}`;
      localDB.put('embeddingsCache', {
        _id: key,
        textHash: key,
        text: texts[index].slice(0, 500),
        model,
        embedding,
      });
    }
  }
  return out.map((v, i) => v ?? hashEmbedding(texts[i]));
}

/** Rate-limits concurrent embedding calls so local servers don't choke. */
let inFlight = 0;
export async function embedSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, getSettings().ai.concurrency);
  while (inFlight >= limit) {
    await sleep(50);
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}

export { hashEmbedding, LLMError };

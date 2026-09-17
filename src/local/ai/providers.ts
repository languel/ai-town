import { getSettings } from '../db/settings';
import { authHeaders, fetchWithTimeout, LLMError, normalizeBaseUrl } from './http';
import { hashEmbedding } from './localEmbeddings';

export { hashEmbedding };

/**
 * Embedding dispatch. Sources:
 *  - `provider`: whatever OpenAI-compatible server you configured
 *    (OpenAI/OpenRouter/LM Studio, or Ollama's native /api/embed endpoints).
 *  - `webgpu`:   transformers.js feature-extraction, in the tab.
 *  - `hash`:     local hashed bag-of-words. Zero download, still ranks memories
 *                by lexical overlap — the default so the town works out of the box.
 *  - `off`:      no embeddings; memory search falls back to recency+importance.
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const ai = getSettings().ai;
  switch (ai.embeddingSource) {
    case 'off':
      return texts.map(() => []);
    case 'hash':
      return texts.map((t) => hashEmbedding(t));
    case 'webgpu': {
      const { webgpuEmbeddings } = await import('./webgpu');
      return webgpuEmbeddings(texts);
    }
    default:
      return providerEmbeddings(texts, signal);
  }
}

async function providerEmbeddings(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const ai = getSettings().ai;
  const base = normalizeBaseUrl(ai.embeddingBaseUrl || ai.baseUrl);
  const apiKey = ai.embeddingApiKey || ai.apiKey;
  if (!base) throw new LLMError('Set an embedding base URL in Settings.', false);

  if (ai.provider === 'ollama') {
    const origin = base.replace(/\/v\d+$/, '');
    const modern = await fetchWithTimeout(
      `${origin}/api/embed`,
      {
        method: 'POST',
        headers: authHeaders(apiKey, 'ollama'),
        body: JSON.stringify({ model: ai.embeddingModel, input: texts }),
      },
      ai.requestTimeoutMs,
      signal,
    ).catch(() => null);
    if (modern?.ok) {
      const json = await modern.json().catch(() => null);
      if (Array.isArray(json?.embeddings) && json.embeddings.length === texts.length) {
        return json.embeddings;
      }
    }
    const out: number[][] = [];
    for (const text of texts) {
      const resp = await fetchWithTimeout(
        `${origin}/api/embeddings`,
        {
          method: 'POST',
          headers: authHeaders(apiKey, 'ollama'),
          body: JSON.stringify({ model: ai.embeddingModel, prompt: text.replace(/\n/g, ' ') }),
        },
        ai.requestTimeoutMs,
        signal,
      );
      if (!resp.ok) {
        throw new LLMError(
          `Ollama embeddings failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`,
          resp.status >= 500,
        );
      }
      const json = await resp.json();
      if (!Array.isArray(json?.embedding)) throw new LLMError('Ollama returned no embedding');
      out.push(json.embedding);
    }
    return out;
  }

  const response = await fetchWithTimeout(
    `${base}/embeddings`,
    {
      method: 'POST',
      headers: authHeaders(apiKey, ai.provider),
      body: JSON.stringify({
        model: ai.embeddingModel,
        input: texts.map((t) => t.replace(/\n/g, ' ')),
      }),
    },
    ai.requestTimeoutMs,
    signal,
  );
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    throw new LLMError(`Embeddings failed (${response.status}): ${text}`, response.status >= 500);
  }
  const json = await response.json().catch(() => null);
  const data = json?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new LLMError(`Unexpected embedding response: ${JSON.stringify(json)?.slice(0, 200)}`);
  }
  return [...data]
    .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
    .map((d: any) => d.embedding as number[]);
}

export function normalizeVector(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm < 1e-9) return vector;
  return vector.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

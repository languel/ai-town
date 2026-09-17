/**
 * Deterministic local embeddings: a signed hashed bag-of-words vector.
 *
 * Real embeddings need a model; this doesn't. It's not semantically as good, but
 * it gives the memory search something meaningful to rank (shared vocabulary
 * scores higher), and results are stable across reloads so exported worlds stay
 * searchable.
 */

export const HASH_EMBEDDING_DIMS = 384;

function fnv1a(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .slice(0, 512);
}

export function hashEmbedding(text: string, dims = HASH_EMBEDDING_DIMS): number[] {
  const vector = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  const add = (token: string, weight: number) => {
    const h = fnv1a(token);
    const sign = h & 1 ? 1 : -1;
    vector[h % dims] += sign * weight;
    vector[(h >>> 7) % dims] += (h & 2 ? 1 : -1) * weight * 0.5;
  };
  for (const token of tokens) add(token, 1);
  for (let i = 0; i < tokens.length - 1; i++) add(`${tokens[i]}_${tokens[i + 1]}`, 0.6);

  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm < 1e-9) return vector;
  return vector.map((v) => v / norm);
}

import type { ProviderKind } from '../db/settings';

export class LLMError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Ensures a `/v1` suffix for OpenAI-compatible servers. */
export function normalizeBaseUrl(input: string): string {
  let base = (input || '').trim().replace(/\/+$/, '');
  if (!base) return base;
  if (/\/chat\/completions$/.test(base)) base = base.replace(/\/chat\/completions$/, '');
  if (/\/v\d+(\.\d+)?$/.test(base)) return base;
  if (/^https?:\/\//.test(base)) {
    try {
      const url = new URL(base);
      if (url.pathname === '/' || url.pathname === '') return `${base}/v1`;
    } catch {
      /* fall through */
    }
    return base;
  }
  // Relative path (e.g. a dev-server proxy like `/llm-proxy`).
  return base;
}

export function authHeaders(apiKey: string, provider: ProviderKind): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) out.Authorization = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    out['HTTP-Referer'] =
      typeof location !== 'undefined' ? location.origin : 'https://localhost';
    out['X-Title'] = 'AI Town Local';
  }
  return out;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (!outerSignal?.aborted) {
      throw new LLMError(
        `Request to ${url} failed or timed out after ${Math.round(
          timeoutMs / 1000,
        )}s. (A local server also needs CORS enabled for browser calls.)`,
        true,
      );
    }
    throw new LLMError(`Request to ${url} was cancelled.`);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Reads a `text/event-stream` body and invokes `onData` for every `data:` payload. */
export async function readSse(response: Response, onData: (payload: string) => void): Promise<void> {
  if (!response.body) throw new LLMError('Streaming response had no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      onData(payload);
    }
  }
}

/** Truncates generated text at the first stop sequence. */
export function cutAtStopWords(text: string, stopWords: string[]): string {
  let out = text;
  for (const word of stopWords) {
    if (!word) continue;
    const at = out.indexOf(word);
    if (at >= 0) out = out.slice(0, at);
  }
  return out;
}

export const RETRY_BACKOFF = [1000, 5_000, 15_000];

/** Retry wrapper mirroring `convex/util/llm.ts#retryWithBackoff`. */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = RETRY_BACKOFF.length,
): Promise<{ result: T; retries: number }> {
  let attempt = 0;
  for (;;) {
    try {
      return { result: await fn(), retries: attempt };
    } catch (e: any) {
      const retryable = e instanceof LLMError ? e.retryable : false;
      if (!retryable || attempt >= retries) {
        throw e instanceof LLMError ? e : new Error(e?.message ?? String(e));
      }
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_BACKOFF[attempt] + Math.random() * 250),
      );
      attempt++;
    }
  }
}

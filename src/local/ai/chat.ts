import { getSettings } from '../db/settings';
import { cutAtStopWords, fetchWithTimeout, LLMError, normalizeBaseUrl, authHeaders, readSse, retryWithBackoff } from './http';
import { improvise } from './mock';
import { webgpuChat } from './webgpu';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

export type ChatOptions = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /**
   * Structured hints. Real providers ignore this; the built-in improviser uses it
   * to pick a response shape, which keeps the town alive with no model at all.
   */
  context?: {
    kind: 'start' | 'continue' | 'leave' | 'summary' | 'importance' | 'reflect' | 'generic';
    speaker?: string;
    listener?: string;
    identity?: string;
    plan?: string;
    lastMessage?: string;
    input?: string;
  };
  onToken?: (token: string, soFar: string) => void;
  signal?: AbortSignal;
};

export function isStreamingSupported(): boolean {
  return typeof fetch !== 'undefined' && typeof ReadableStream !== 'undefined';
}

export function aiEnabled(): boolean {
  const ai = getSettings().ai;
  return ai.enabled && (ai.provider === 'mock' || !!ai.chatModel || ai.provider === 'webgpu');
}

/**
 * One entry point for "ask the model for text". Dispatches to the configured
 * provider: a hosted API key (OpenAI/OpenRouter), a local server
 * (Ollama/LM Studio/any OpenAI-compatible endpoint), in-browser WebGPU via
 * transformers.js, or the built-in offline improviser.
 */
export async function chatCompletion(options: ChatOptions): Promise<string> {
  const ai = getSettings().ai;
  if (!ai.enabled) throw new LLMError('AI is disabled in Settings.', false);
  const { result } = await retryWithBackoff(() => chatOnce(options));
  return result;
}

async function chatOnce(options: ChatOptions): Promise<string> {
  const ai = getSettings().ai;

  if (ai.provider === 'mock') {
    return mockChat(options);
  }
  if (ai.provider === 'webgpu') {
    return webgpuChat(options);
  }

  const base = normalizeBaseUrl(ai.baseUrl);
  if (!base) throw new LLMError('Set a base URL for your LLM provider in Settings.', false);
  if ((ai.provider === 'openai' || ai.provider === 'openrouter') && !ai.apiKey) {
    throw new LLMError(`"${ai.provider}" needs an API key — add it in Settings.`, false);
  }

  const stop = [...(ai.stopWords ?? []), ...(options.stop ?? [])].filter(Boolean);
  const useStream = ai.stream && !!options.onToken && isStreamingSupported();
  const body: Record<string, unknown> = {
    model: ai.chatModel,
    messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: useStream,
    max_tokens: options.maxTokens ?? ai.maxTokens,
    temperature: options.temperature ?? ai.temperature,
  };
  if (stop.length) body.stop = stop;

  const response = await fetchWithTimeout(
    `${base}/chat/completions`,
    { method: 'POST', headers: authHeaders(ai.apiKey, ai.provider), body: JSON.stringify(body) },
    ai.requestTimeoutMs,
    options.signal,
  );

  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 400);
    throw new LLMError(
      `Chat completion failed (${response.status}): ${text}`,
      response.status === 429 || response.status >= 500,
      response.status,
    );
  }

  if (useStream) {
    return streamInto(response, stop, options);
  }

  const json = await response.json().catch(() => null);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LLMError(`Unexpected provider response: ${JSON.stringify(json)?.slice(0, 300)}`);
  }
  return finalize(cutAtStopWords(content, stop), options);
}

async function streamInto(
  response: Response,
  stop: string[],
  options: ChatOptions,
): Promise<string> {
  let content = '';
  let pending = '';
  await readSse(response, (payload) => {
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.text ?? '';
    if (!delta) return;
    pending += delta;
    // Hold back a tail that could be the beginning of a stop sequence.
    let hold = 0;
    for (const word of stop) {
      for (let n = Math.min(word.length - 1, pending.length); n > 0; n--) {
        if (word.startsWith(pending.slice(-n))) {
          hold = Math.max(hold, n);
          break;
        }
      }
    }
    const flushable = pending.slice(0, pending.length - hold);
    if (flushable) {
      pending = pending.slice(flushable.length);
      content += flushable;
      options.onToken?.(flushable, content);
    }
  });
  content += pending;
  return finalize(cutAtStopWords(content, stop), options);
}

async function mockChat(options: ChatOptions): Promise<string> {
  const text = improvise(options);
  const latency = Math.max(0, getSettings().ai.mockLatencyMs ?? 14);
  if (options.onToken && latency > 0) {
    // Small artificial latency so the "typing..." bubble behaves like a model.
    let soFar = '';
    for (const word of text.split(/(?<=\s)/)) {
      soFar += word;
      options.onToken(word, soFar);
      await new Promise((r) => setTimeout(r, latency));
    }
    options.onToken('', text);
  }
  return text;
}

/** Models sometimes echo "Alice to Bob:" back — strip that prefix. */
function finalize(content: string, options: ChatOptions): string {
  const trimmed = content.trim();
  const last = options.messages.at(-1)?.content?.trim().split('\n').pop()?.trim();
  if (last && trimmed.startsWith(last)) {
    return trimmed.slice(last.length).replace(/^[:\-\s]+/, '').trim();
  }
  return trimmed;
}

/** Cheap "is the server reachable?" probe used by the Settings panel. */
export async function probeProvider(): Promise<{ ok: boolean; detail: string }> {
  const ai = getSettings().ai;
  if (ai.provider === 'mock') return { ok: true, detail: 'Built-in improviser (offline).' };
  if (ai.provider === 'webgpu') {
    const supported = typeof navigator !== 'undefined' && 'gpu' in navigator;
    return {
      ok: true,
      detail: supported
        ? `WebGPU available — model ${ai.webgpu.chatModel} loads on demand.`
        : `navigator.gpu missing: falling back to WASM is slower but works.`,
    };
  }
  const base = normalizeBaseUrl(ai.baseUrl);
  if (!base) return { ok: false, detail: 'No base URL configured.' };
  try {
    const response = await fetchWithTimeout(
      `${base}/models`,
      { method: 'GET', headers: authHeaders(ai.apiKey, ai.provider) },
      15_000,
    );
    if (!response.ok) {
      return { ok: false, detail: `${response.status} ${await response.text()}` };
    }
    const json: any = await response.json().catch(() => null);
    const models = json?.data ?? json?.models;
    const list = Array.isArray(models)
      ? models.map((m: any) => m.id ?? m.name).slice(0, 25)
      : [];
    return {
      ok: true,
      detail: list.length ? `${list.length} models: ${list.join(', ')}` : 'Reachable.',
    };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

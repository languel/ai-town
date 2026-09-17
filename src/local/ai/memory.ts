import { localDB } from '../db/local';
import type { MemoryDoc } from '../db/schema';
import { C } from '../constants';
import { getSettings } from '../db/settings';
import { chatCompletion } from './chat';
import { fetchEmbedding } from './embeddings';
import { cosineSimilarity } from './providers';
import { renderPromptKey } from './prompts';

/**
 * Agent memory: insert, retrieve (relevance + recency + importance) and reflect.
 * Ported from `convex/agent/memory.ts`; the Convex vector index is replaced by a
 * cosine scan, which is the right call for a few thousand rows in a tab.
 */

const MEMORY_ACCESS_THROTTLE = 300_000;
const MEMORY_OVERFETCH = 10;

export type RankedMemory = { memory: MemoryDoc; score: number; relevance: number };

export async function insertMemory(input: {
  playerId: string;
  description: string;
  importance: number;
  lastAccess: number;
  data: MemoryDoc['data'];
  embedding?: number[];
}): Promise<MemoryDoc> {
  const embedding = input.embedding ?? (await embed(input.description));
  const doc = localDB.put<MemoryDoc>('memories', {
    _id: `mem-${input.playerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    _creationTime: Date.now(),
    playerId: input.playerId,
    description: input.description,
    importance: input.importance,
    lastAccess: input.lastAccess,
    data: input.data,
    embedding,
  } as MemoryDoc);
  vacuumOldMemories(input.playerId);
  return doc;
}

async function embed(text: string): Promise<number[]> {
  if (!getSettings().ai.useFor.memories) return [];
  try {
    return await fetchEmbedding(text);
  } catch (e: any) {
    console.warn(`Embedding failed, memories degrade to recency ranking: ${e?.message}`);
    return [];
  }
}

export async function searchMemories(
  playerId: string,
  query: string,
  n = C.NUM_MEMORIES_TO_SEARCH,
): Promise<RankedMemory[]> {
  const all = localDB.all<MemoryDoc>('memories').filter((m) => m.playerId === playerId);
  if (all.length === 0) return [];

  const queryEmbedding = await embed(query);
  const hasEmbeddings = queryEmbedding.length > 0 && all.some((m) => m.embedding?.length);

  const ts = Date.now();
  const scored = all.map((memory) => {
    const relevance = hasEmbeddings
      ? cosineSimilarity(queryEmbedding, memory.embedding ?? [])
      : 0.5;
    const hoursSinceAccess = (ts - (memory.lastAccess ?? memory._creationTime)) / 3_600_000;
    const recency = 0.99 ** Math.floor(hoursSinceAccess);
    return { memory, relevance, recency, importance: memory.importance ?? 5 };
  });

  const overfetch = scored.slice().sort((a, b) => b.relevance - a.relevance).slice(0, n * MEMORY_OVERFETCH);
  const range = (get: (m: (typeof scored)[number]) => number) => {
    const values = overfetch.map(get);
    return [Math.min(...values), Math.max(...values)] as const;
  };
  const relevanceRange = range((m) => m.relevance);
  const importanceRange = range((m) => m.importance);
  const recencyRange = range((m) => m.recency);
  const norm = (value: number, [min, max]: readonly [number, number]) =>
    max - min < 1e-9 ? 0.5 : (value - min) / (max - min);

  const ranked = overfetch.map((m) => ({
    memory: m.memory,
    relevance: m.relevance,
    score:
      norm(m.relevance, relevanceRange) +
      norm(m.importance, importanceRange) +
      norm(m.recency, recencyRange),
  }));
  ranked.sort((a, b) => b.score - a.score);
  const accessed = ranked.slice(0, n);
  for (const { memory } of accessed) {
    if (memory.lastAccess < ts - MEMORY_ACCESS_THROTTLE) {
      localDB.patch('memories', memory._id, { lastAccess: ts });
    }
  }
  return accessed;
}

export async function calculateImportance(description: string): Promise<number> {
  const ai = getSettings().ai;
  if (!ai.enabled || !ai.useFor.importance) return 5;
  try {
    const content = await chatCompletion({
      messages: [{ role: 'user', content: renderPromptKey('memory.importance', { description }) }],
      temperature: 0,
      maxTokens: 4,
      context: { kind: 'importance', input: description },
    });
    let importance = parseFloat(content);
    if (isNaN(importance)) importance = +(content.match(/\d+/)?.[0] ?? NaN);
    if (isNaN(importance)) return 5;
    // The prompt asks for 0-9; older configs asked for 0-100. Normalize both.
    return importance <= 10 ? importance * 10 : importance;
  } catch (e: any) {
    console.warn(`Importance scoring failed: ${e?.message}`);
    return 5;
  }
}

/** Turns the freshest memories into self-insights, like the original paper. */
export async function reflectOnMemories(playerId: string, name: string): Promise<boolean> {
  const ai = getSettings().ai;
  if (!ai.enabled || !ai.useFor.reflections) return false;
  const memories = localDB
    .all<MemoryDoc>('memories')
    .filter((m) => m.playerId === playerId)
    .slice(-100);
  const lastReflection = localDB
    .all<MemoryDoc>('memories')
    .filter((m) => m.playerId === playerId && m.data?.type === 'reflection')
    .at(-1);
  const fresh = memories.filter((m) => m._creationTime > (lastReflection?._creationTime ?? 0));
  const sumImportance = fresh.reduce((acc, m) => acc + (m.importance ?? 0), 0);
  if (sumImportance <= 500 || fresh.length < 4) return false;

  const statements = fresh
    .map((m, idx) => `Statement ${idx + 1}: ${m.description}`)
    .join('\n');
  try {
    const reflection = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: renderPromptKey('memory.reflect', { name, statements }),
        },
      ],
      context: { kind: 'reflect', speaker: name, input: statements },
      maxTokens: 400,
    });
    const jsonStart = reflection.indexOf('[');
    const jsonEnd = reflection.lastIndexOf(']');
    if (jsonStart < 0 || jsonEnd <= jsonStart) return false;
    const insights = JSON.parse(reflection.slice(jsonStart, jsonEnd + 1));
    if (!Array.isArray(insights) || insights.length === 0) return false;
    for (const item of insights) {
      const insight = String(item?.insight ?? '').trim();
      if (!insight) continue;
      const statementIds: number[] = Array.isArray(item?.statementIds)
        ? item.statementIds.map((n: number) => Number(n)).filter((n: number) => !isNaN(n))
        : [];
      const relatedMemoryIds = statementIds
        .map((idx) => fresh[idx]?._id)
        .filter(Boolean) ;
      const importance = await calculateImportance(insight);
      await insertMemory({
        playerId,
        description: insight,
        importance,
        lastAccess: Date.now(),
        data: { type: 'reflection', relatedMemoryIds },
      });
    }
    return true;
  } catch (e: any) {
    console.warn(`Reflection failed: ${e?.message}`);
    return false;
  }
}

/** Keep the local database bounded: forget memories past VACUUM_MAX_AGE. */
export function vacuumOldMemories(playerId?: string) {
  const cutoff = Date.now() - C.VACUUM_MAX_AGE;
  for (const memory of localDB.all<MemoryDoc>('memories')) {
    if (playerId && memory.playerId !== playerId) continue;
    if (memory._creationTime < cutoff) localDB.delete('memories', memory._id);
  }
}

export function memoriesFor(playerId: string): MemoryDoc[] {
  return localDB.all<MemoryDoc>('memories').filter((m) => m.playerId === playerId);
}

export function memoryCount(playerId?: string): number {
  return playerId ? memoriesFor(playerId).length : localDB.count('memories');
}

export function formatMemoriesForPrompt(memories: RankedMemory[]): string {
  if (memories.length === 0) return '';
  return [
    'Here are some related memories in decreasing relevance order:',
    ...memories.map((m) => ` - ${m.memory.description}`),
  ].join('\n');
}

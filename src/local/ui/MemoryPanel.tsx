import { useMemo, useState } from 'react';
import { localDB } from '../db/local.ts';
import { memoriesFor, memoryCount, reflectOnMemories, searchMemories, vacuumOldMemories } from '../ai/memory.ts';
import { useTable } from '../state.tsx';
import type { CharacterDoc } from '../db/schema.ts';
import type { MemoryDoc } from '../db/schema.ts';

/**
 * The memory panel: what each agent currently has in its context window, plus a
 * live retrieval search so you can see why an agent would (or wouldn't) remember
 * something you said.
 */
export default function MemoryPanel() {
  const cast = useTable<CharacterDoc>('characters');
  const [agentId, setAgentId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ memory: MemoryDoc; score: number }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const logs = (localDB.all<any>('logs') )
    .slice(-120)
    .sort((a, b) => b._creationTime - a._creationTime);
  const archived = useTable<any>('conversations')
    .slice()
    .sort((a, b) => b.ended - a.ended)
    .slice(0, 12);

  const selectedId = agentId || cast[0]?.id || '';
  const memories = useMemo(() => memoriesFor(selectedId), [selectedId, localDB.revision]);

  return (
    <div className="mx-auto grid max-w-[1200px] gap-4 p-4 lg:grid-cols-[280px_1fr]">
      <aside className="flex flex-col gap-2">
        <h2 className="font-display text-lg">Agents</h2>
        {cast.map((c) => (
          <button
            key={c.id}
            onClick={() => setAgentId(c.id)}
            className={`flex items-center justify-between rounded px-2 py-1 text-left ${
              selectedId === c.id ? 'bg-clay-500' : 'bg-brown-900/60 hover:bg-brown-900'
            }`}
          >
            <span className="text-sm">{c.name}</span>
            <span className="text-[11px] opacity-70">{memoryCount(c.id)}</span>
          </button>
        ))}
        <div className="mt-2 flex flex-col gap-2">
          <button
            className="btn"
            onClick={() => {
              vacuumOldMemories(selectedId);
              setAgentId((id) => id);
            }}
          >
            🧹 vacuum old memories
          </button>
          <button
            className="btn"
            onClick={() =>
              void reflectOnMemories(
                selectedId,
                cast.find((c) => c.id === selectedId)?.name ?? 'Agent',
              ).then((r: boolean) =>
                alert(
                  r
                    ? '✓ a reflection was summarized and stored'
                    : 'nothing to reflect on yet (needs enough memories + a working model)',
                ),
              )
            }
          >
            💭 force reflection
          </button>
        </div>
      </aside>

      <section className="flex flex-col gap-4">
        <div className="rounded border border-brown-700 bg-brown-900/50 p-3">
          <h2 className="mb-2 font-display text-lg">Retrieval test</h2>
          <p className="mb-2 text-[11px] opacity-70">
            Runs the same scoring the agent uses: cosine relevance + recency + LLM-rated
            importance, then sorts by combined score.
          </p>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="what did people talk about near the lake?"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void run()}
            />
            <button className="btn btn-primary" disabled={searching} onClick={() => void run()}>
              {searching ? '…' : 'search'}
            </button>
          </div>
          {results && (
            <ul className="mt-2 flex flex-col gap-1 text-xs">
              {results.length === 0 && <li className="opacity-70">no memories matched</li>}
              {results.map(({ memory, score }) => (
                <li key={memory._id} className="rounded bg-brown-900/60 px-2 py-1">
                  <span className="opacity-60">{score.toFixed(3)}</span> · {memory.description}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded border border-brown-700 bg-brown-900/50 p-3">
          <h2 className="mb-2 font-display text-lg">
            {cast.find((c) => c.id === selectedId)?.name ?? 'Agent'} remembers ({memories.length})
          </h2>
          <ul className="flex max-h-[380px] flex-col gap-1 overflow-auto text-xs">
            {memories
              .slice()
              .sort((a, b) => b.lastAccess - a.lastAccess)
              .map((m) => (
                <li key={m._id} className="rounded bg-brown-900/60 px-2 py-1">
                  <span className="mr-1 rounded bg-black/40 px-1 text-[10px] uppercase opacity-80">
                    {m.data.type}
                  </span>
                  {m.description}
                  <span className="ml-1 opacity-50">
                    imp {m.importance.toFixed(2)} ·{' '}
                    {new Date(m.lastAccess).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: 'numeric',
                    })}
                  </span>
                </li>
              ))}
            {memories.length === 0 && <li className="opacity-70">nothing yet</li>}
          </ul>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded border border-brown-700 bg-brown-900/50 p-3">
            <h2 className="mb-2 font-display text-lg">Recent conversations</h2>
            <ul className="flex flex-col gap-1 text-xs">
              {archived.map((c: any) => (
                <li key={c._id} className="rounded bg-brown-900/60 px-2 py-1">
                  {c.numMessages} msgs · {new Date(c.created).toLocaleTimeString()} ·{' '}
                  {c.participants
                    .map((p: string) => cast.find((c2) => c2.id === p)?.name ?? p.slice(-3))
                    .join(', ')}
                </li>
              ))}
              {archived.length === 0 && <li className="opacity-70">none archived yet</li>}
            </ul>
          </div>
          <div className="rounded border border-brown-700 bg-brown-900/50 p-3">
            <h2 className="mb-2 font-display text-lg">Event log</h2>
            <ul className="flex max-h-56 flex-col gap-1 overflow-auto text-[11px]">
              {logs.map((l) => (
                <li key={l._id} className="font-system">
                  <span className="opacity-50">{new Date(l._creationTime).toLocaleTimeString()}</span>{' '}
                  <span
                    className={
                      l.level === 'error'
                        ? 'text-red-300'
                        : l.level === 'warn'
                          ? 'text-amber-300'
                          : 'opacity-80'
                    }
                  >
                    [{l.source}] {l.message}
                  </span>
                </li>
              ))}
              {logs.length === 0 && <li className="opacity-70">quiet so far…</li>}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );

  async function run() {
    if (!selectedId || !query.trim()) return;
    setSearching(true);
    try {
      const found = await searchMemories(selectedId, query, 8);
      setResults(found.map((f) => ({ memory: f.memory, score: f.score })));
    } finally {
      setSearching(false);
    }
  }
}



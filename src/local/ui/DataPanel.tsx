import { useMemo, useState } from 'react';
import { localDB } from '../db/local.ts';
import { STORE_NAMES, type StoreName } from '../db/schema.ts';
import {
  applyBundle,
  downloadBundle,
  downloadSettings,
  downloadText,
  importBundleFromFile,
  parseBundle,
  serializeBundle,
} from '../db/transfer.ts';
import { useDbRevision, useRuntime } from '../state.tsx';
import { promptStore } from '../ai/prompts.ts';

/**
 * The database panel: browse what's stored locally, and move a whole world
 * between browsers with a single JSON file.
 */
export default function DataPanel() {
  useDbRevision();
  const runtime = useRuntime();
  const [busy, setBusy] = useState<string | null>(null);
  const [table, setTable] = useState<StoreName>('world');
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [paste, setPaste] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const counts = useMemo(
    () => Object.fromEntries(STORE_NAMES.map((name) => [name, localDB.count(name)])) as Record<string, number>,
    [useDbRevision()],
  );
  const rows = localDB.all(table).slice(-40);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      setMessage(`✗ ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto grid max-w-[1200px] gap-4 p-4 md:grid-cols-2">
      <section className="rounded border border-brown-700 bg-brown-900/50 p-3">
        <h2 className="mb-2 font-display text-lg">Local database</h2>
        <p className="mb-2 text-xs opacity-80">
          {localDB.persistent
            ? 'Persisted in IndexedDB (database "ai-town-local"). Settings + prompts live in localStorage.'
            : '⚠ IndexedDB unavailable — this session is memory-only and will not survive a reload.'}
        </p>
        <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
          {STORE_NAMES.map((name) => (
            <button
              key={name}
              onClick={() => setTable(name)}
              className={`flex items-center justify-between rounded px-2 py-1 ${
                table === name ? 'bg-clay-500' : 'bg-brown-900/60 hover:bg-brown-900'
              }`}
            >
              <span>{name}</span>
              <span className="opacity-70">{counts[name] ?? 0}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] opacity-70">
          {total} rows · last flush{' '}
          {localDB.lastFlushAt ? new Date(localDB.lastFlushAt).toLocaleTimeString() : 'never'}
          {estimate
            ? ` · ${(estimate.usage / 1024 / 1024).toFixed(2)} MiB used of ${(
                estimate.quota / 1024 / 1024 / 1024
              ).toFixed(2)} GiB quota`
            : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className="btn"
            onClick={() =>
              void localDB.storageEstimate().then((e) => {
                if (e) setEstimate(e);
              })
            }
          >
            📊 storage estimate
          </button>
          <button className="btn" onClick={() => void run('persist', () => runtime.persist())}>
            💾 flush now
          </button>
        </div>
        <div className="mt-3 max-h-[420px] overflow-auto rounded bg-black/50 p-2 font-system text-[11px]">
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(rows, null, 1).slice(0, 20000)}
          </pre>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded border border-brown-700 bg-brown-900/50 p-3">
        <div>
          <h2 className="mb-1 font-display text-lg">Export</h2>
          <p className="mb-2 text-[11px] opacity-70">
            One JSON file with every table plus settings and prompt overrides. Redact the API key if
            you're sharing a world.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={!!busy}
              onClick={() => void run('export', async () => {
                const bundle = await downloadBundle({ includeSecrets: true });
                setMessage(`✓ exported ${serializeBundle(bundle).length.toLocaleString()} bytes`);
              })}
            >
              ⬇ download world (with key)
            </button>
            <button
              className="btn"
              disabled={!!busy}
              onClick={() => void run('export-safe', async () => {
                await downloadBundle({ includeSecrets: false });
                setMessage('✓ exported (secrets redacted)');
              })}
            >
              ⬇ shareable (no key)
            </button>
            <button className="btn" onClick={() => downloadSettings()}>
              ⬇ settings only
            </button>
            <button
              className="btn"
              onClick={() => {
                void runtime.persist();
                downloadText(
                  JSON.stringify(runtime.currentMap(), null, 2),
                  'aifavella-map.json',
                  'application/json',
                );
              }}
            >
              ⬇ map only
            </button>
            <button
              className="btn"
              onClick={() =>
                downloadText(
                  JSON.stringify({ prompts: promptStore.get(), characters: localDB.all('characters') }, null, 2),
                  'aifavella-cast.json',
                  'application/json',
                )
              }
            >
              ⬇ cast + prompts
            </button>
          </div>
        </div>

        <div>
          <h2 className="mb-1 font-display text-lg">Import</h2>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn cursor-pointer">
              ⬆ choose file…
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void run('import', async () => {
                    const summary = await importBundleFromFile(file, { replace: true, reload: false });
                    await runtime.init();
                    setMessage(
                      `✓ imported (${Object.entries(summary.counts)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(' ')})`,
                    );
                  });
                }}
              />
            </label>
            <button
              className="btn"
              disabled={!paste.trim()}
              onClick={() =>
                void run('paste', async () => {
                  const bundle = parseBundle(paste);
                  await applyBundle(bundle, { replace: true, reload: false });
                  await runtime.init();
                  setPaste('');
                  setMessage('✓ imported from clipboard text');
                })
              }
            >
              ⬆ import pasted JSON
            </button>
          </div>
          <textarea
            className="input mt-2 min-h-[90px] font-system text-[11px]"
            placeholder='…or paste a {"app":"ai-town-local","tables":{…}} document'
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <p className="mt-1 text-[11px] opacity-70">
            Import replaces the tables in this browser. Cast + prompts files are merged in-place
            without wiping messages.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              className="btn"
              onClick={() =>
                void run('cast', async () => {
                  const json = JSON.parse(paste || '{}');
                  if (Array.isArray(json.characters)) {
                    for (const doc of json.characters) localDB.put('characters', doc);
                  }
                  await runtime.syncCastFromDb();
                  setMessage('✓ reloaded cast');
                })
              }
            >
              ⟳ reload cast from paste
            </button>
          </div>
        </div>

        <div>
          <h2 className="mb-1 font-display text-lg">Danger zone</h2>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn"
              onClick={() =>
                void run('reset', async () => {
                  await runtime.resetWorld({ keepMemories: true });
                  setMessage('✓ world reset (memories kept)');
                })
              }
            >
              ♻️ reset world
            </button>
            <button
              className="btn text-red-300"
              onClick={() =>
                void run('wipe', async () => {
                  if (!confirm('Delete every local table (world, messages, memories, maps, cast)?'))
                    return;
                  await localDB.wipeAll();
                  await runtime.init();
                  setMessage('✓ wiped local database');
                })
              }
            >
              🗑 wipe everything
            </button>
          </div>
        </div>

        {message && <p className="text-xs">{message}</p>}
        <details>
          <summary className="cursor-pointer text-xs opacity-80">effective prompt templates</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap bg-black/40 p-2 font-system text-[11px]">
            {JSON.stringify(promptStore.get(), null, 1).slice(0, 4000)}
          </pre>
        </details>
      </section>
    </div>
  );
}

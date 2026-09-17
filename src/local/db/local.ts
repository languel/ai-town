import {
  ensureDatabase,
  idbBulkPut,
  idbClear,
  idbDelete,
  idbGetAll,
  isIndexedDbAvailable,
} from './idb';
import { STORE_NAMES, StoreName, Doc } from './schema';
import { uuid } from '../engine/object';

export type ExportBundle = {
  app: 'ai-town-local';
  version: 1;
  exportedAt: string;
  /** Table name -> rows. `_id`/`_creationTime` are preserved. */
  tables: Partial<Record<StoreName, Doc[]>>;
  /** Raw localStorage mirror (settings, prompts, profile). */
  local: Record<string, string>;
};

type Change = { type: 'put'; doc: Doc } | { type: 'delete'; id: string };

/**
 * A reactive, browser-only document database.
 *
 * - Reads are synchronous against an in-memory mirror (so the 60Hz simulation and
 *   React never await).
 * - Writes are queued and flushed to IndexedDB on a timer (and on unload).
 * - Every write bumps a revision counter that `useSyncExternalStore` watches.
 * - If IndexedDB is unavailable (private windows, some embedded webviews) it
 *   degrades to a session-only memory store and says so in the UI.
 */
export class LocalDatabase {
  private docs = new Map<StoreName, Map<string, Doc>>();
  private pending = new Map<StoreName, Map<string, Change>>();
  private listeners = new Set<() => void>();
  private snapshots = new Map<StoreName, Doc[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  revision = 0;
  ready = false;
  persistent = false;
  lastFlushAt = 0;
  lastError: string | null = null;

  constructor(private stores: readonly StoreName[] = STORE_NAMES) {
    for (const store of this.stores) {
      this.docs.set(store, new Map());
      this.pending.set(store, new Map());
      this.snapshots.set(store, []);
    }
  }

  async init() {
    for (const store of this.stores) {
      this.docs.set(store, new Map());
    }
    if (isIndexedDbAvailable()) {
      try {
        await ensureDatabase(this.stores);
        this.persistent = true;
        for (const store of this.stores) {
          const rows = await idbGetAll<Doc>(store);
          const map = new Map<string, Doc>();
          for (const row of rows) {
            if (row && typeof row._id === 'string') map.set(row._id, row);
          }
          this.docs.set(store, map);
        }
      } catch (e: any) {
        this.lastError = e?.message ?? String(e);
        console.warn(`IndexedDB unavailable, running in-memory: ${this.lastError}`);
        this.persistent = false;
      }
    }
    this.ready = true;
    this.reindex();
    this.notify();
  }

  /** Force any queued writes to disk. */
  async flush() {
    if (!this.persistent) {
      this.pending.forEach((m) => m.clear());
      return;
    }
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const store of this.stores) {
        const queue = this.pending.get(store)!;
        if (queue.size === 0) continue;
        const entries = [...queue.entries()];
        queue.clear();
        const puts = entries.filter(([, c]) => c.type === 'put').map(([, c]) => (c as any).doc);
        const deletes = entries.filter(([, c]) => c.type === 'delete').map(([id]) => id);
        try {
          await idbBulkPut(store, puts);
          for (const id of deletes) {
            await this.safeDelete(store, id);
          }
        } catch (e: any) {
          this.lastError = e?.message ?? String(e);
          console.error(`Failed to persist ${store}`, e);
        }
      }
      this.lastFlushAt = Date.now();
    } finally {
      this.flushing = false;
    }
  }

  private async safeDelete(store: StoreName, id: string) {
    try {
      await idbDelete(store, id);
    } catch (e) {
      console.warn('delete failed', e);
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 250);
  }

  private reindex(store?: StoreName) {
    const stores = store ? [store] : this.stores;
    for (const s of stores) {
      const rows = [...(this.docs.get(s)?.values() ?? [])];
      rows.sort((a, b) => (a._creationTime ?? 0) - (b._creationTime ?? 0));
      this.snapshots.set(s, rows);
    }
  }

  private notify() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision = () => this.revision;

  all<T = Doc>(store: StoreName): T[] {
    return this.snapshots.get(store) as T[];
  }

  get<T = Doc>(store: StoreName, id: string): T | undefined {
    return this.docs.get(store)?.get(id) as T | undefined;
  }

  find<T = Doc>(store: StoreName, predicate: (doc: T) => boolean): T[] {
    return this.all<T>(store).filter(predicate);
  }

  first<T = Doc>(store: StoreName, predicate: (doc: T) => boolean): T | undefined {
    return this.all<T>(store).find(predicate);
  }

  count(store: StoreName) {
    return this.docs.get(store)?.size ?? 0;
  }

  put<T extends Record<string, any>>(
    store: StoreName,
    doc: T & { _id?: string; _creationTime?: number },
  ): T & Doc {
    const map = this.docs.get(store)!;
    const id = doc._id ?? uuid();
    const existing = map.get(id);
    const next = {
      ...doc,
      _id: id,
      _creationTime: (doc as any)._creationTime ?? existing?._creationTime ?? Date.now(),
    } as Doc;
    map.set(id, next);
    this.pending.get(store)!.set(id, { type: 'put', doc: next });
    this.reindex(store);
    this.scheduleFlush();
    this.notify();
    return next as T & Doc;
  }

  patch<T extends Record<string, any>>(
    store: StoreName,
    id: string,
    changes: T,
  ): (T & Doc) | undefined {
    const existing = this.docs.get(store)?.get(id);
    if (!existing) return undefined;
    return this.put(store, { ...existing, ...changes, _id: id });
  }

  delete(store: StoreName, id: string) {
    const map = this.docs.get(store)!;
    if (!map.delete(id)) return;
    this.pending.get(store)!.set(id, { type: 'delete', id });
    this.reindex(store);
    this.scheduleFlush();
    this.notify();
  }

  /** Replace the entire contents of a table (used by import + reset). */
  replaceAll(store: StoreName, docs: Doc[]) {
    const map = new Map<string, Doc>();
    const queue = this.pending.get(store)!;
    for (const id of this.docs.get(store)!.keys()) {
      queue.set(id, { type: 'delete', id });
    }
    for (const doc of docs) {
      const withId = { ...doc, _id: doc._id ?? uuid() } as Doc;
      map.set(withId._id, withId);
      queue.set(withId._id, { type: 'put', doc: withId });
    }
    this.docs.set(store, map);
    this.reindex(store);
    this.scheduleFlush();
    this.notify();
  }

  clear(store: StoreName) {
    this.replaceAll(store, []);
    if (this.persistent) void idbClear(store);
  }

  async wipeAll() {
    for (const store of this.stores) this.clear(store);
    await this.flush();
  }

  localSnapshot(): Record<string, Doc[]> {
    const out: Record<string, Doc[]> = {};
    for (const store of this.stores) {
      out[store] = this.all(store).map((doc) => JSON.parse(JSON.stringify(doc)));
    }
    return out;
  }

  async exportBundle(): Promise<ExportBundle> {
    await this.flush();
    const tables: ExportBundle['tables'] = {};
    for (const store of this.stores) {
      tables[store] = this.all(store).map((doc) => JSON.parse(JSON.stringify(doc)) as Doc);
    }
    const local: Record<string, string> = {};
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (key.startsWith('aifavella.') || key.startsWith('ai-town')) {
          local[key] = localStorage.getItem(key) ?? '';
        }
      }
    }
    return {
      app: 'ai-town-local',
      version: 1,
      exportedAt: new Date().toISOString(),
      tables,
      local,
    };
  }

  async importBundle(bundle: ExportBundle, options: { replace?: boolean } = {}) {
    if (!bundle || bundle.app !== 'ai-town-local') {
      throw new Error('Not an AI-Town-local export file (missing `app: ai-town-local`).');
    }
    const replace = options.replace ?? true;
    if (!replace) {
      for (const store of this.stores) {
        const incoming = (bundle.tables as any)[store] as Doc[] | undefined;
        if (!incoming?.length) continue;
        for (const doc of incoming) {
          if (!this.docs.get(store)!.has(doc._id)) this.put(store, doc);
        }
      }
    } else {
      for (const store of this.stores) {
        this.replaceAll(store, ((bundle.tables as any)[store] as Doc[]) ?? []);
      }
      if (bundle.local) {
        for (const [key, value] of Object.entries(bundle.local)) {
          try {
            localStorage.setItem(key, value);
          } catch {
            /* ignore quota errors on import */
          }
        }
      }
    }
    await this.flush();
  }

  async storageEstimate(): Promise<{ usage: number; quota: number } | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  }
}

/** Shared singleton used by the app. */
export const localDB = new LocalDatabase();

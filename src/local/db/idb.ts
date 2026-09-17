/**
 * A tiny promise-based IndexedDB wrapper. One object store per table, keyed by
 * `_id`. The store list has to be known before the first connection is opened
 * (that's when `onupgradeneeded` runs), so `ensureDatabase()` is called once by
 * `LocalDatabase.init()`.
 */

const DB_NAME = 'ai-town-local';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;
let knownStores: string[] = [];

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function ensureDatabase(stores: readonly string[]): Promise<IDBDatabase> {
  knownStores = [...stores];
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB is unavailable (private mode?).'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of knownStores) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: '_id' });
        }
      }
      // Drop stores from older experiments.
      for (const name of Array.from(db.objectStoreNames)) {
        if (!knownStores.includes(name)) {
          db.deleteObjectStore(name);
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await ensureDatabase(knownStores);
  return new Promise<T>((resolve, reject) => {
    let request: IDBRequest;
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(store, mode);
      request = run(transaction.objectStore(store));
    } catch (e) {
      reject(e);
      return;
    }
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB ${mode} failed`));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB tx aborted'));
  });
}

export function idbGetAll<T>(store: string): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll());
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const value = await tx<T | undefined>(store, 'readonly', (s) => s.get(key));
  return value ?? undefined;
}

export async function idbBulkPut(store: string, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  const db = await ensureDatabase(knownStores);
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    const objectStore = transaction.objectStore(store);
    for (const value of values) {
      objectStore.put(value);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function idbPut(store: string, value: unknown): Promise<void> {
  return tx(store, 'readwrite', (s) => s.put(value)).then(() => undefined);
}

export function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  return tx(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
}

export function idbClear(store: string): Promise<void> {
  return tx(store, 'readwrite', (s) => s.clear()).then(() => undefined);
}

export function idbCount(store: string): Promise<number> {
  return tx<number>(store, 'readonly', (s) => s.count());
}

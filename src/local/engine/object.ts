/** Small helpers shared by the engine + the editors. */

export function parseMap<Id, Serialized, Parsed>(
  records: Serialized[],
  constructor: new (r: Serialized) => Parsed,
  getId: (r: Parsed) => Id,
): Map<Id, Parsed> {
  const out = new Map<Id, Parsed>();
  for (const record of records) {
    const parsed = new constructor(record);
    const id = getId(parsed);
    if (out.has(id)) {
      throw new Error(`Duplicate ID ${String(id)}`);
    }
    out.set(id, parsed);
  }
  return out;
}

export function serializeMap<Serialized, T extends { serialize(): Serialized }>(
  map: Map<string, T>,
): Serialized[] {
  return [...map.values()].map((v) => v.serialize());
}

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Random integer in [0, max). */
export function randInt(max: number) {
  return Math.floor(Math.random() * max);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** uuid with a fallback for non-secure contexts. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `x${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

export async function asyncMap<From, To>(
  list: Iterable<From>,
  fn: (item: From, index: number) => Promise<To>,
): Promise<To[]> {
  const promises: Promise<To>[] = [];
  let idx = 0;
  for (const item of list) {
    promises.push(fn(item, idx));
    idx += 1;
  }
  return Promise.all(promises);
}

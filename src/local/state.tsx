import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { SimRuntime } from './sim/runtime';
import { localDB } from './db/local';
import { getSettings, subscribeSettings, type Settings } from './db/settings';

/**
 * React bindings for the in-browser simulation.
 *
 * There's no query client and no socket: `SimRuntime` ticks in this process and
 * bumps a revision counter, which is all `useSyncExternalStore` needs.
 */

const RuntimeContext = createContext<SimRuntime | null>(null);

export function useRuntime(): SimRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useRuntime must be used inside <TownProvider>');
  return runtime;
}

/** Re-renders on every simulation notify (throttled to ~one per frame). */
export function useRevision(): number {
  const runtime = useRuntime();
  return useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision);
}

export function useGameRevision() {
  const runtime = useRuntime();
  return useRevision(), runtime.game.revision;
}

export function useTown() {
  const runtime = useRuntime();
  useRevision();
  return {
    runtime,
    game: runtime.game,
    world: runtime.game.world,
    worldMap: runtime.game.worldMap,
    playerDescriptions: runtime.game.playerDescriptions,
    agentDescriptions: runtime.game.agentDescriptions,
    status: runtime.status(),
  };
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      const unsubscribe = subscribeSettings(cb);
      return () => {
        unsubscribe();
      };
    },
    () => getSettings(),
    () => getSettings(),
  );
}

export function useDbRevision(): number {
  return useSyncExternalStore(localDB.subscribe, localDB.getRevision, localDB.getRevision);
}

/** Reactive table read: re-renders whenever the store changes. */
export function useTable<T = any>(table: Parameters<typeof localDB.all>[0]): T[] {
  const revision = useDbRevision();
  return useMemo(() => localDB.all<T>(table) , [table, revision]);
}

export function useMessages(conversationId: string | undefined) {
  const revision = useDbRevision();
  return useMemo(() => {
    if (!conversationId) return [];
    return (localDB.all<any>('messages') )
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a._creationTime - b._creationTime);
  }, [conversationId, revision]);
}

export function useInterval(callback: () => void, delay: number | null) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

/** Debounced "value changed" signal, for polling engine stats without a re-render storm. */
export function usePolled<T>(compute: () => T, intervalMs = 500): T {
  const [value, setValue] = useState(() => compute());
  const computeRef = useRef(compute);
  computeRef.current = compute;
  useEffect(() => {
    const id = setInterval(() => setValue(computeRef.current()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return value;
}

export function TownProvider({
  runtime,
  children,
}: {
  runtime: SimRuntime;
  children: React.ReactNode;
}) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

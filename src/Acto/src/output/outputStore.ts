import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';

export type Level = 'info' | 'ok' | 'warn' | 'error';
export interface OutputLine { at: string; text: string; level: Level }

const ORDER_KEY = 'acto.outputNewestFirst';

const clockNow = (): string => new Date().toTimeString().slice(0, 8);

export interface OutputStore {
  lines(): OutputLine[];
  log(text: string, level?: Level): void;
  clear(): void;
  newestFirst(): boolean;
  setNewestFirst(b: boolean): void;
  subscribe(fn: () => void): () => void;
}

export function createOutputStore(storage: Storage | null, clock: () => string = clockNow): OutputStore {
  let lines: OutputLine[] = [];
  let newestFirst = false;
  try { newestFirst = storage?.getItem(ORDER_KEY) === 'true'; } catch { /* no persistence */ }
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  return {
    lines: () => lines,
    log(text, level = 'info') { lines = [...lines, { at: clock(), text, level }]; emit(); },
    clear() { lines = []; emit(); },
    newestFirst: () => newestFirst,
    setNewestFirst(b) {
      newestFirst = b;
      try { storage?.setItem(ORDER_KEY, String(b)); } catch { /* no persistence */ }
      emit();
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

const OutputContext = createContext<OutputStore | null>(null);

export function OutputProvider({ store, children }: { store: OutputStore; children: ReactNode }) {
  return createElement(OutputContext.Provider, { value: store }, children);
}

export function useOutput(): OutputStore {
  const s = useContext(OutputContext);
  if (!s) throw new Error('useOutput needs an OutputProvider');
  return s;
}

/** Re-renders when lines or the order change. */
export function useOutputState(): { lines: OutputLine[]; newestFirst: boolean; store: OutputStore } {
  const store = useOutput();
  // lines() is a stable reference between changes; the order is a primitive.
  const lines = useSyncExternalStore(store.subscribe, store.lines);
  const newestFirst = useSyncExternalStore(store.subscribe, store.newestFirst);
  return { lines, newestFirst, store };
}

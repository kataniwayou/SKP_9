import { useSyncExternalStore } from 'react';

/**
 * The highlighted workflows, outside React's tree: the dock renders the document through its own host, which a page
 * re-render does not reach, so the document subscribes here (as SKP Studio's panels do to its store).
 */
export interface Highlights {
  get(): readonly string[];
  set(ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
}

export function createHighlights(initial: readonly string[]): Highlights {
  let ids = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => ids,
    set(next) { ids = next; for (const l of listeners) l(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export function useHighlights(store: Highlights): readonly string[] {
  return useSyncExternalStore(store.subscribe, store.get);
}

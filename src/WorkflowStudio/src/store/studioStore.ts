import { createContext, useContext, useSyncExternalStore } from 'react';
import { INITIAL_STATE, reduce, type StudioAction, type StudioState } from './studioState';

/** A minimal external store around `reduce`: one state, one dispatch, change listeners. */
export interface StudioStore {
  getState(): StudioState;
  dispatch(action: StudioAction): void;
  subscribe(listener: () => void): () => void;
}

export function createStudioStore(initial: StudioState = INITIAL_STATE): StudioStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const StoreContext = createContext<StudioStore | null>(null);

/** Provides the store to the page. Dock panels are React portals, so they see it too. */
export const StudioStoreProvider = StoreContext.Provider;

export function useStudioStore(): StudioStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStudioStore needs a StudioStoreProvider above it.');
  return store;
}

/**
 * Reads a slice of the state and re-renders when it changes. The selector must return a value
 * that is stable while the state is unchanged (a slice, an existing object or a primitive), never
 * a fresh object or array: useSyncExternalStore compares with Object.is.
 */
export function useStudio<T>(selector: (state: StudioState) => T): T {
  const store = useStudioStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

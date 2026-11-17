import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { HealthOf } from '../api/liveness';
import type { LiveStatus } from '../api/liveStatus';
import type { LiveStore } from './liveClient';
import { healthFn, INITIAL_LIVE, statusOf, type LiveState, type ProcessorLive } from './liveState';

/** No store above (a test of one panel): nothing known yet, nothing changes. */
const STILL: LiveStore = {
  getState: () => INITIAL_LIVE,
  subscribe: () => () => undefined,
  onWorkflowChange: () => () => undefined,
  start: () => undefined,
  stop: () => undefined,
};

const LiveContext = createContext<LiveStore>(STILL);

/** Provides the app's one liveness store. Dock panels are React portals, so they see it too. */
export const LiveStoreProvider = LiveContext.Provider;

export const useLiveStore = (): LiveStore => useContext(LiveContext);

/** A slice of the liveness state; the selector must return a stable value (see useStudio). */
export function useLive<T>(selector: (state: LiveState) => T): T {
  const store = useLiveStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

/** A workflow's run status, from the one store (whether or not its tab is shown). */
export const useWorkflowStatus = (workflowId: string): LiveStatus => useLive((s) => statusOf(s, workflowId));

/** Every processor's health, for the art: a new function only when the processors change. */
export function useHealthOf(): HealthOf {
  const processors = useLive((s) => s.processors);
  const known = useLive((s) => s.processorsKnown);
  const store = useLiveStore();
  return useMemo(() => healthFn(store.getState()), [store, processors, known]);
}

/** One processor's liveness as last reported, or null (not known, or not listed). */
export function useProcessorLive(processorId: string): { known: LiveState['processorsKnown']; processor: ProcessorLive | null } {
  const known = useLive((s) => s.processorsKnown);
  const processor = useLive((s) => s.processors.get(processorId.toLowerCase()) ?? null);
  return { known, processor };
}

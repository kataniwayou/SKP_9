import type { LiveStore } from '../live/liveClient';
import { INITIAL_LIVE, type LiveState, type ProcessorLive } from '../live/liveState';

/** A liveness store a test sets by hand: `known(running, processors)`, `unknown()`, or any part of the state. */
export interface LiveStub extends LiveStore {
  set(change: Partial<LiveState>): void;
  /** The hub's answer: these workflows run (ids as given), these processors are live (true) or not (false). */
  known(running: string[], processors?: Record<string, boolean | ProcessorLive>): void;
  unknown(): void;
}

export function liveStub(initial: Partial<LiveState> = {}): LiveStub {
  let state: LiveState = { ...INITIAL_LIVE, connection: 'connected', ...initial };
  const listeners = new Set<() => void>();
  const set = (change: Partial<LiveState>) => {
    state = { ...state, ...change };
    for (const l of [...listeners]) l();
  };
  return {
    getState: () => state,
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    onWorkflowChange: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    set,
    known(running, processors = {}) {
      set({
        workflows: 'known', running: new Set(running.map((id) => id.toLowerCase())), processorsKnown: 'known',
        processors: new Map(Object.entries(processors).map(([id, p]) => [id.toLowerCase(), typeof p === 'boolean'
          ? { live: p, healthy: p ? 1 : 0, replicas: 1, reason: p ? null : 'no healthy replica (1 checked: 0 absent, 0 unhealthy, 1 stale, 0 malformed)' }
          : p])),
      });
    },
    unknown() { set({ workflows: 'unknown', processorsKnown: 'unknown' }); },
  };
}

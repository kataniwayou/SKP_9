/** A workflow's run status as its toolbar shows it (spec §6.1); the liveness store (live/liveState.ts) says which. */
export type LiveStatus = 'checking' | 'running' | 'stopped' | 'unknown';

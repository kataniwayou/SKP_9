import type { ApiResult, StudioApi } from '../api/client';
import { INITIAL_LIVE, liveReduce, type Connection, type HubSnapshot, type LiveEvent, type LiveState, type WorkflowChange } from './liveState';

/** The part of a SignalR `HubConnection` the client uses (tests pass a fake). */
export interface HubConnectionLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(method: string, handler: (arg: unknown) => void): void;
  invoke<T>(method: string): Promise<T>;
  onreconnecting(callback: () => void): void;
  onreconnected(callback: () => void): void;
  onclose(callback: () => void): void;
}

/** A new, not yet started hub connection (each start gets its own). */
export type HubFactory = () => HubConnectionLike;

export interface Timers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The app's one liveness store: its state, change listeners, and the connection it owns. */
export interface LiveStore {
  getState(): LiveState;
  subscribe(listener: () => void): () => void;
  /** Workflows that started or stopped (not the first answer, never a processor). */
  onWorkflowChange(listener: (changes: WorkflowChange[]) => void): () => void;
  /** Opens the hub connection (or, with no hub, polls). Again after stop: a fresh connection. */
  start(): void;
  stop(): void;
}

/** The fallback poll's period while the hub is not connected (the old per-document period). */
export const POLL_MS = 5000;

/** Waits before a failed connection is tried again: quick at first, then every 30 s, never giving up. */
export const RETRY_MS: readonly number[] = [0, 1000, 2000, 5000, 10_000, 20_000, 30_000];
export const retryDelay = (attempt: number): number => RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;

const BROWSER_TIMERS: Timers = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Sequenced = Extract<LiveEvent, { sequence: number }>;

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** A hub message as an event, read defensively; null when it is not one (no sequence number). */
function eventOf(method: string, arg: unknown): Sequenced | null {
  const a = asRecord(arg);
  if (typeof a.sequence !== 'number') return null;
  switch (method) {
    case 'workflowLive': return typeof a.workflowId === 'string' && typeof a.running === 'boolean'
      ? { type: 'workflowLive', workflowId: a.workflowId, running: a.running, sequence: a.sequence } : null;
    case 'processorLiveness': return typeof a.processorId === 'string' && typeof a.live === 'boolean'
      ? { type: 'processorLiveness', processorId: a.processorId, live: a.live, healthy: num(a.healthy), replicas: num(a.replicas), reason: typeof a.reason === 'string' ? a.reason : null, removed: a.removed === true, sequence: a.sequence } : null;
    case 'monitorStatus': return typeof a.known === 'boolean' ? { type: 'monitorStatus', known: a.known, sequence: a.sequence } : null;
    default: return null;
  }
}

function snapshotOf(value: unknown): HubSnapshot | null {
  const s = asRecord(value);
  if (typeof s.sequence !== 'number' || typeof s.known !== 'boolean' || !Array.isArray(s.runningWorkflowIds) || !Array.isArray(s.processors)) return null;
  return {
    sequence: s.sequence, known: s.known,
    runningWorkflowIds: s.runningWorkflowIds.filter((x): x is string => typeof x === 'string'),
    processors: s.processors.map(asRecord).filter((p) => typeof p.processorId === 'string' && typeof p.live === 'boolean')
      .map((p) => ({ processorId: str(p.processorId), live: p.live as boolean, healthy: num(p.healthy), replicas: num(p.replicas), reason: typeof p.reason === 'string' ? p.reason : null })),
  };
}

const network = (e: unknown): ApiResult<unknown> => ({ ok: false, error: { kind: 'network', message: String(e) } });

/**
 * The liveness store and its connection (2026-10-10). One SignalR connection for the whole app, opened at start and
 * independent of documents: on connect and reconnect it takes the hub's snapshot, then applies each change whose sequence
 * number is the next one; a gap (or a change while a snapshot is on its way) is held and a snapshot taken. While not
 * connected, one poll of `GET /orchestration/live` and `GET /processors/liveness` every POLL_MS feeds the same state; a
 * poll answer that lands once connected is dropped, and the next snapshot replaces what polls said.
 */
export function createLiveStore({ api, hub, timers = BROWSER_TIMERS, pollMs = POLL_MS }: {
  api: Pick<StudioApi, 'listLive' | 'listLiveness'>;
  /** Null: no hub (the studio polls only). */
  hub: HubFactory | null;
  timers?: Timers;
  pollMs?: number;
}): LiveStore {
  let state = INITIAL_LIVE;
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(changes: WorkflowChange[]) => void>();

  // one generation per start(): callbacks of a stopped connection, timer or request find a newer one and do nothing
  let generation = 0;
  let running = false;
  let connection: HubConnectionLike | null = null;
  let retryTimer: unknown = null;
  let pollTimer: unknown = null;
  let polling = false;
  let attempts = 0;
  let snapshotting = false;
  let snapshotAgain = false;
  let held: Sequenced[] = [];

  const dispatch = (event: LiveEvent) => {
    const { state: next, changes } = liveReduce(state, event);
    if (next !== state) {
      state = next;
      for (const l of [...listeners]) l();
    }
    if (changes.length > 0) for (const l of [...changeListeners]) l(changes);
  };

  const setConnection = (c: Connection) => {
    dispatch({ type: 'connection', connection: c });
    if (c === 'connected') stopPolling(); else startPolling();
  };

  // --- the fallback poll ---------------------------------------------------------------------------------------------
  const startPolling = () => {
    if (polling || !running) return;
    polling = true;
    const gen = generation;
    const poll = async () => {
      const [live, liveness] = await Promise.all([
        Promise.resolve().then(() => api.listLive()).catch(network),
        Promise.resolve().then(() => api.listLiveness()).catch(network),
      ]);
      if (gen !== generation || !polling) return;
      // connected meanwhile: the hub's snapshot is what counts
      if (state.connection !== 'connected') dispatch({ type: 'poll', live, liveness });
      pollTimer = timers.setTimeout(() => void poll(), pollMs);
    };
    void poll();
  };
  const stopPolling = () => {
    polling = false;
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  };

  // --- the hub ---------------------------------------------------------------------------------------------------------
  const apply = (event: Sequenced) => {
    dispatch(event);
    // the monitor reads Redis again: what it holds now comes with a snapshot
    if (event.type === 'monitorStatus' && event.known) takeSnapshot();
  };

  /** Applies held changes in order once a snapshot has landed; a remaining gap takes another snapshot. */
  const drain = () => {
    held.sort((a, b) => a.sequence - b.sequence);
    while (held.length > 0 && !snapshotting) {
      const next = held[0]!;
      const seq = state.seq;
      if (seq === null) return;
      if (next.sequence <= seq) { held.shift(); continue; }
      if (next.sequence !== seq + 1) { takeSnapshot(); return; }
      held.shift();
      apply(next);
    }
  };

  const takeSnapshot = () => {
    const conn = connection;
    if (conn === null) return;
    if (snapshotting) { snapshotAgain = true; return; }
    snapshotting = true;
    const gen = generation;
    void conn.invoke<unknown>('Snapshot').then((value) => {
      if (gen !== generation || conn !== connection) return;
      snapshotting = false;
      const snapshot = snapshotOf(value);
      if (snapshot !== null) dispatch({ type: 'snapshot', snapshot });
      if (snapshotAgain) { snapshotAgain = false; takeSnapshot(); return; }
      drain();
    }, () => {
      if (gen !== generation || conn !== connection) return;
      snapshotting = false;
      snapshotAgain = false;
      // the connection is likely going down; if it stays up, ask again shortly
      timers.setTimeout(() => { if (gen === generation && conn === connection && state.connection === 'connected') takeSnapshot(); }, 1000);
    });
  };

  const onEvent = (method: string) => (arg: unknown) => {
    const event = eventOf(method, arg);
    if (event === null || state.connection !== 'connected') return;
    if (snapshotting || state.seq === null) { held.push(event); return; }
    if (event.sequence <= state.seq) return;
    if (event.sequence === state.seq + 1) { apply(event); return; }
    held.push(event);
    takeSnapshot();
  };

  const connect = () => {
    if (!running || hub === null) return;
    const gen = generation;
    const conn = hub();
    connection = conn;
    held = [];
    snapshotting = false;
    snapshotAgain = false;
    for (const method of ['workflowLive', 'processorLiveness', 'monitorStatus']) conn.on(method, onEvent(method));
    conn.onreconnecting(() => { if (gen === generation && conn === connection) { held = []; setConnection('reconnecting'); } });
    conn.onreconnected(() => {
      if (gen !== generation || conn !== connection) return;
      setConnection('connected');
      takeSnapshot();
    });
    // automatic reconnect gave up (or the server closed): a new connection after a wait
    conn.onclose(() => { if (gen === generation && conn === connection) retry(state.connection === 'connected' || state.connection === 'reconnecting' ? 'reconnecting' : 'offline'); });
    conn.start().then(() => {
      if (gen !== generation || conn !== connection) { void conn.stop(); return; }
      attempts = 0;
      setConnection('connected');
      takeSnapshot();
    }, () => {
      if (gen !== generation || conn !== connection) return;
      retry(state.connection === 'connecting' ? 'offline' : state.connection);
    });
  };

  const retry = (shown: Connection) => {
    connection = null;
    setConnection(shown === 'connected' ? 'reconnecting' : shown);
    const gen = generation;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => { retryTimer = null; if (gen === generation) connect(); }, retryDelay(++attempts));
  };

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onWorkflowChange(listener) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
    start() {
      if (running) return;
      running = true;
      generation++;
      attempts = 0;
      if (hub === null) { setConnection('offline'); return; }
      setConnection(state.connection === 'connected' ? 'reconnecting' : 'connecting');
      connect();
    },
    stop() {
      if (!running) return;
      running = false;
      generation++;
      stopPolling();
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      const conn = connection;
      connection = null;
      held = [];
      snapshotting = false;
      if (conn) void conn.stop().catch(() => undefined);
    },
  };
}

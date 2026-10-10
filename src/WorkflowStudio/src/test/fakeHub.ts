import type { HubConnectionLike, HubFactory } from '../live/liveClient';
import type { HubSnapshot } from '../live/liveState';

/** A hand-driven SignalR connection: the test settles start and Snapshot, fires messages and connection events. */
export class FakeConnection implements HubConnectionLike {
  handlers = new Map<string, (arg: unknown) => void>();
  starting!: { resolve: () => void; reject: (e: unknown) => void };
  snapshots: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  stopped = false;
  private reconnecting = () => {};
  private reconnected = () => {};
  private closed = () => {};
  start() { return new Promise<void>((resolve, reject) => { this.starting = { resolve, reject }; }); }
  stop() { this.stopped = true; return Promise.resolve(); }
  on(method: string, handler: (arg: unknown) => void) { this.handlers.set(method, handler); }
  invoke<T>(method: string): Promise<T> {
    if (method !== 'Snapshot') throw new Error(`unexpected hub method ${method}`);
    return new Promise<T>((resolve, reject) => { this.snapshots.push({ resolve: resolve as (v: unknown) => void, reject }); });
  }
  onreconnecting(cb: () => void) { this.reconnecting = cb; }
  onreconnected(cb: () => void) { this.reconnected = cb; }
  onclose(cb: () => void) { this.closed = cb; }
  emit(method: string, arg: unknown) { this.handlers.get(method)!(arg); }
  lose() { this.reconnecting(); }
  regain() { this.reconnected(); }
  close() { this.closed(); }
}

/** A hub factory that records every connection it makes. */
export function fakeHub(): { factory: HubFactory; conns: FakeConnection[]; last: () => FakeConnection } {
  const conns: FakeConnection[] = [];
  return { factory: () => { const c = new FakeConnection(); conns.push(c); return c; }, conns, last: () => conns.at(-1)! };
}

export const snap = (sequence: number, running: string[] = [], known = true, processors: HubSnapshot['processors'] = []): HubSnapshot =>
  ({ sequence, known, runningWorkflowIds: running, processors });

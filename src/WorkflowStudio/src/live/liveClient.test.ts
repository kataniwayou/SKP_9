import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client';
import { FakeConnection, snap } from '../test/fakeHub';
import { createLiveStore, POLL_MS, RETRY_MS } from './liveClient';
import { statusOf } from './liveState';

const flush = () => vi.advanceTimersByTimeAsync(0);
const wf = (workflowId: string, running: boolean, sequence: number) => ({ workflowId, running, sequence });

function setup({ live = [] as string[], hub = true } = {}) {
  const conns: FakeConnection[] = [];
  const answer = { live: { ok: true, value: live } as ApiResult<unknown> };
  const api = {
    listLive: vi.fn(async () => answer.live),
    listLiveness: vi.fn(async (): Promise<ApiResult<unknown>> => ({ ok: true, value: [] })),
  };
  const store = createLiveStore({ api, hub: hub ? () => { const c = new FakeConnection(); conns.push(c); return c; } : null });
  const changes: { workflowId: string; running: boolean }[] = [];
  store.onWorkflowChange((c) => changes.push(...c));
  return { store, conns, api, answer, changes, conn: () => conns.at(-1)! };
}

/** Started, connected, the first snapshot answered. */
async function connected(running: string[] = [], seq = 5) {
  const t = setup();
  t.store.start();
  t.conn().starting.resolve();
  await flush();
  t.conn().snapshots.shift()!.resolve(snap(seq, running));
  await flush();
  return t;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the liveness store and its hub connection (2026-10-10)', () => {
  it('connects at start, takes a snapshot, and applies changes in sequence; it does not poll while connected', async () => {
    const t = await connected(['a']);
    expect(t.store.getState().connection).toBe('connected');
    expect(statusOf(t.store.getState(), 'a')).toBe('running');
    t.conn().emit('workflowLive', wf('b', true, 6));
    t.conn().emit('workflowLive', wf('a', false, 7));
    expect(t.store.getState().seq).toBe(7);
    expect(t.changes).toEqual([{ workflowId: 'b', running: true }, { workflowId: 'a', running: false }]);
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(t.api.listLive).toHaveBeenCalledTimes(1);   // only the one poll while it was connecting
  });

  it('ignores a change it already has (sequence at or below its own)', async () => {
    const t = await connected(['a']);
    t.conn().emit('workflowLive', wf('a', false, 5));
    expect(statusOf(t.store.getState(), 'a')).toBe('running');
    expect(t.conn().snapshots).toHaveLength(0);
  });

  it('a gap in the sequence takes a snapshot; held changes after it are applied in order, older ones skipped', async () => {
    const t = await connected(['a']);
    t.conn().emit('workflowLive', wf('b', true, 8));   // 6 and 7 missed
    expect(t.conn().snapshots).toHaveLength(1);
    expect(statusOf(t.store.getState(), 'b')).toBe('stopped');
    t.conn().emit('workflowLive', wf('c', true, 10));
    t.conn().emit('workflowLive', wf('d', true, 9));
    t.conn().snapshots.shift()!.resolve(snap(8, ['a', 'b']));   // includes 8
    await flush();
    const s = t.store.getState();
    expect(s.seq).toBe(10);
    expect(['a', 'b', 'c', 'd'].map((id) => statusOf(s, id))).toEqual(['running', 'running', 'running', 'running']);
    expect(t.changes).toEqual([{ workflowId: 'b', running: true }, { workflowId: 'd', running: true }, { workflowId: 'c', running: true }]);
  });

  it('a gap still open after the snapshot takes another', async () => {
    const t = await connected();
    t.conn().emit('workflowLive', wf('b', true, 9));
    t.conn().snapshots.shift()!.resolve(snap(7));
    await flush();
    expect(t.conn().snapshots).toHaveLength(1);
    t.conn().snapshots.shift()!.resolve(snap(9, ['b']));
    await flush();
    expect(statusOf(t.store.getState(), 'b')).toBe('running');
  });

  it('the monitor known again takes a snapshot; unknown shows unknown', async () => {
    const t = await connected(['a']);
    t.conn().emit('monitorStatus', { known: false, reason: 'redis', sequence: 6 });
    expect(statusOf(t.store.getState(), 'a')).toBe('unknown');
    t.conn().emit('monitorStatus', { known: true, reason: null, sequence: 7 });
    expect(t.conn().snapshots).toHaveLength(1);
    t.conn().snapshots.shift()!.resolve(snap(7, []));
    await flush();
    expect(statusOf(t.store.getState(), 'a')).toBe('stopped');
    expect(t.changes).toEqual([{ workflowId: 'a', running: false }]);
  });

  it('falls back to one poll every 5 s while reconnecting, logs changes from polls, and a fresh snapshot replaces polled state on reconnect', async () => {
    const t = await connected(['a']);
    const before = t.api.listLive.mock.calls.length;
    t.conn().lose();
    expect(t.store.getState().connection).toBe('reconnecting');
    t.answer.live = { ok: true, value: ['a', 'b'] };
    await flush();
    expect(t.api.listLive.mock.calls.length).toBe(before + 1);
    expect(statusOf(t.store.getState(), 'b')).toBe('running');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.api.listLive.mock.calls.length).toBe(before + 2);
    expect(t.api.listLiveness.mock.calls.length).toBe(t.api.listLive.mock.calls.length);
    expect(t.changes).toEqual([{ workflowId: 'b', running: true }]);

    t.conn().regain();
    expect(t.store.getState().connection).toBe('connected');
    t.conn().snapshots.shift()!.resolve(snap(20, ['b']));
    await flush();
    expect(statusOf(t.store.getState(), 'a')).toBe('stopped');
    expect(t.store.getState().seq).toBe(20);
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(t.api.listLive.mock.calls.length).toBe(before + 2);   // polling stopped
  });

  it('a poll answer that lands once connected is dropped', async () => {
    const t = setup();
    let release!: (v: ApiResult<unknown>) => void;
    t.api.listLive.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    t.store.start();
    t.conn().starting.resolve();
    await flush();
    t.conn().snapshots.shift()!.resolve(snap(3, ['a']));
    await flush();
    release({ ok: true, value: [] });
    await flush();
    expect(statusOf(t.store.getState(), 'a')).toBe('running');
  });

  it('a failed start is offline: it polls, and tries again with backoff until it connects', async () => {
    const t = setup({ live: ['a'] });
    t.store.start();
    t.conn().starting.reject(new Error('refused'));
    await flush();
    expect(t.store.getState().connection).toBe('offline');
    expect(statusOf(t.store.getState(), 'a')).toBe('running');   // from the poll
    expect(t.conns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS[1]!);
    expect(t.conns).toHaveLength(2);
    t.conn().starting.reject(new Error('refused'));
    await flush();
    await vi.advanceTimersByTimeAsync(RETRY_MS[2]! - 1);
    expect(t.conns).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.conns).toHaveLength(3);
    t.conn().starting.resolve();
    await flush();
    expect(t.store.getState().connection).toBe('connected');
    expect(t.conn().snapshots).toHaveLength(1);
  });

  it('a closed connection (reconnect gave up, or the server went away) opens a new one after a wait', async () => {
    const t = await connected();
    t.conn().close();
    expect(t.store.getState().connection).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(RETRY_MS[1]!);
    expect(t.conns).toHaveLength(2);
  });

  it('changes while reconnecting are not applied; changes before the first snapshot are held for it', async () => {
    const t = setup();
    t.store.start();
    t.conn().starting.resolve();
    await flush();
    t.conn().emit('workflowLive', wf('a', true, 6));   // the snapshot is on its way
    t.conn().snapshots.shift()!.resolve(snap(5));
    await flush();
    expect(statusOf(t.store.getState(), 'a')).toBe('running');
    t.conn().lose();
    t.conn().emit('workflowLive', wf('a', false, 7));
    expect(statusOf(t.store.getState(), 'a')).toBe('running');
  });

  it('with no hub it only polls, offline; stop ends polling and a late answer changes nothing', async () => {
    const t = setup({ hub: false, live: ['a'] });
    t.store.start();
    await flush();
    expect(t.store.getState().connection).toBe('offline');
    expect(statusOf(t.store.getState(), 'a')).toBe('running');
    t.store.stop();
    t.answer.live = { ok: true, value: [] };
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(t.api.listLive).toHaveBeenCalledTimes(1);
    expect(statusOf(t.store.getState(), 'a')).toBe('running');
  });

  it('stop closes the connection; start again opens a fresh one (StrictMode)', async () => {
    const t = await connected();
    const first = t.conn();
    t.store.stop();
    expect(first.stopped).toBe(true);
    t.store.start();
    expect(t.conns).toHaveLength(2);
    first.emit('workflowLive', wf('z', true, 6));   // the old connection's message
    expect(statusOf(t.store.getState(), 'z')).not.toBe('running');
  });

  it('reads hub messages defensively: no sequence, or the wrong shape, is ignored', async () => {
    const t = await connected();
    t.conn().emit('workflowLive', { workflowId: 'a', running: true });
    t.conn().emit('workflowLive', { workflowId: 7, running: true, sequence: 6 });
    t.conn().emit('processorLiveness', 'nonsense');
    expect(t.store.getState().seq).toBe(5);
    expect(t.conn().snapshots).toHaveLength(0);
  });
});

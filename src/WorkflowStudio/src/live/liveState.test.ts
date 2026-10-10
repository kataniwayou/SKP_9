import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client';
import { healthFn, healthIn, INITIAL_LIVE, liveReduce, processorsOf, runningOf, statusOf, type HubSnapshot, type LiveEvent, type LiveState } from './liveState';

const W = '1A56B3CA-E276-4815-87FA-5C2F48AB6DAD';
const ok = (value: unknown): ApiResult<unknown> => ({ ok: true, value });
const failed: ApiResult<unknown> = { ok: false, error: { kind: 'http', status: 500, detail: 'Redis down' } };
const snapshot = (over: Partial<HubSnapshot> = {}): LiveEvent => ({
  type: 'snapshot', snapshot: { sequence: 7, known: true, runningWorkflowIds: [], processors: [], ...over },
});
const run = (state: LiveState, ...events: LiveEvent[]) => events.reduce(
  (acc, e) => { const r = liveReduce(acc.state, e); return { state: r.state, changes: [...acc.changes, ...r.changes] }; },
  { state, changes: [] as { workflowId: string; running: boolean }[] },
);

describe('the liveness state (2026-10-10)', () => {
  it('says checking before any answer: no status, every processor undetermined', () => {
    expect(statusOf(INITIAL_LIVE, W)).toBe('checking');
    expect(healthIn(INITIAL_LIVE, 'p1')).toBe('undetermined');
  });

  it('a snapshot is the whole state, ids without case; the first answer is no change', () => {
    const { state, changes } = run(INITIAL_LIVE, snapshot({ runningWorkflowIds: [W], processors: [{ processorId: 'P1', live: true, healthy: 2, replicas: 2, reason: null }] }));
    expect(changes).toEqual([]);
    expect(state.seq).toBe(7);
    expect(statusOf(state, W.toLowerCase())).toBe('running');
    expect(statusOf(state, 'other')).toBe('stopped');
    expect(healthIn(state, 'p1')).toBe('healthy');
    expect(healthIn(state, 'p2')).toBe('undetermined');
  });

  it('workflow changes after a baseline are reported, a processor change never', () => {
    const base = run(INITIAL_LIVE, snapshot({ runningWorkflowIds: ['a'] })).state;
    const { state, changes } = run(base,
      { type: 'workflowLive', workflowId: 'B', running: true, sequence: 8 },
      { type: 'workflowLive', workflowId: 'a', running: false, sequence: 9 },
      { type: 'processorLiveness', processorId: 'p1', live: false, healthy: 0, replicas: 1, reason: 'stale', removed: false, sequence: 10 });
    expect(changes).toEqual([{ workflowId: 'b', running: true }, { workflowId: 'a', running: false }]);
    expect(state.seq).toBe(10);
    expect(healthIn(state, 'P1')).toBe('unhealthy');
    expect(state.processors.get('p1')!.reason).toBe('stale');
  });

  it('a repeated change (already running) is no change; a removed processor is forgotten', () => {
    const base = run(INITIAL_LIVE, snapshot({ runningWorkflowIds: ['a'], processors: [{ processorId: 'p1', live: true, healthy: 1, replicas: 1, reason: null }] })).state;
    const { state, changes } = run(base,
      { type: 'workflowLive', workflowId: 'a', running: true, sequence: 8 },
      { type: 'processorLiveness', processorId: 'p1', live: false, healthy: 0, replicas: 0, reason: null, removed: true, sequence: 9 });
    expect(changes).toEqual([]);
    expect(healthIn(state, 'p1')).toBe('undetermined');
  });

  it('before any snapshot a workflow change is not applied (the snapshot gives the baseline)', () => {
    const { state, changes } = run(INITIAL_LIVE, { type: 'workflowLive', workflowId: 'a', running: true, sequence: 1 });
    expect(changes).toEqual([]);
    expect(statusOf(state, 'a')).toBe('checking');
  });

  it('the monitor losing Redis is unknown, keeping the baseline: what changed meanwhile is reported when known again', () => {
    const base = run(INITIAL_LIVE, snapshot({ runningWorkflowIds: ['a'], processors: [{ processorId: 'p1', live: true, healthy: 1, replicas: 1, reason: null }] })).state;
    const lost = run(base, { type: 'monitorStatus', known: false, sequence: 8 }).state;
    expect(statusOf(lost, 'a')).toBe('unknown');
    expect(healthIn(lost, 'p1')).toBe('undetermined');
    // an unknown snapshot does not replace the baseline with its (stale or empty) lists
    const still = run(lost, snapshot({ known: false, sequence: 8, runningWorkflowIds: [] })).state;
    expect(still.running).toEqual(new Set(['a']));
    const { state, changes } = run(still, snapshot({ sequence: 11, runningWorkflowIds: ['b'] }));
    expect(changes).toEqual([{ workflowId: 'b', running: true }, { workflowId: 'a', running: false }]);
    expect(statusOf(state, 'a')).toBe('stopped');
  });

  it('a poll is read defensively: odd entries skipped, a failure is unknown and keeps the baseline, a later answer reports the change', () => {
    const first = run(INITIAL_LIVE, { type: 'poll', live: ok([null, 7, { id: W }, 'A']), liveness: ok([{ processorId: 'p1', live: false, replicas: 2, absent: 1, stale: 1 }]) });
    expect(first.changes).toEqual([]);
    expect(statusOf(first.state, 'a')).toBe('running');
    expect(first.state.processors.get('p1')).toEqual({ live: false, healthy: 0, replicas: 2, reason: 'no healthy replica (2 checked: 1 absent, 0 unhealthy, 1 stale, 0 malformed)' });

    const down = run(first.state, { type: 'poll', live: failed, liveness: ok({ not: 'a list' }) });
    expect(down.changes).toEqual([]);
    expect(statusOf(down.state, 'a')).toBe('unknown');
    expect(healthIn(down.state, 'p1')).toBe('undetermined');

    const back = run(down.state, { type: 'poll', live: ok([]), liveness: ok([]) });
    expect(back.changes).toEqual([{ workflowId: 'a', running: false }]);
  });

  it('runningOf and processorsOf say null for anything that is not a list', () => {
    for (const r of [failed, ok(null), ok('x'), ok({ live: [W] })]) {
      expect(runningOf(r)).toBeNull();
      expect(processorsOf(r)).toBeNull();
    }
    expect(processorsOf(ok([null, 'p1', { processorId: 7, live: true }, { processorId: 'p1', live: 'yes' }, { processorId: 'p2', live: true, healthy: 1, replicas: 1 }])))
      .toEqual(new Map([['p2', { live: true, healthy: 1, replicas: 1, reason: null }]]));
  });

  it('healthFn is undetermined for everyone until the processors are known', () => {
    expect(healthFn(INITIAL_LIVE)('p1')).toBe('undetermined');
    const known = run(INITIAL_LIVE, snapshot({ processors: [{ processorId: 'p1', live: false, healthy: 0, replicas: 1, reason: 'x' }] })).state;
    expect(healthFn(known)('P1')).toBe('unhealthy');
  });

  it('losing the connection forgets the sequence; the next snapshot gives it again', () => {
    const base = run(INITIAL_LIVE, { type: 'connection', connection: 'connected' }, snapshot()).state;
    expect(base.seq).toBe(7);
    expect(run(base, { type: 'connection', connection: 'reconnecting' }).state.seq).toBeNull();
  });
});

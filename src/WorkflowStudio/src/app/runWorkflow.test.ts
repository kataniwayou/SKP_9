import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto } from '../api/fixtures';
import type { LiveStatus } from '../api/liveStatus';
import { EMPTY_DRAFT } from '../design/draft';
import { RUN_TIMEOUT_MS, runBlocked } from '../store/run';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { runWorkflow } from './runWorkflow';

const NOW = () => new Date('2026-10-09T09:00:00Z');
const accepted = { ok: true, value: null } as const;
const refused = { ok: false, error: { kind: 'unprocessable', status: 422, detail: 'Processor p is not live.' } } as const;

/** A store with wf1 open, and the liveness store's say about it (2026-10-10), changed as the hub would. */
async function storeWith(initial: LiveStatus) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto()) });
  let status = initial;
  const liveOf = () => status;
  /** The workflow starts or stops: the liveness store's status, and its Output line. */
  const change = (running: boolean) => {
    status = running ? 'running' : 'stopped';
    store.dispatch({ type: 'liveChanged', workflowId: 'wf1', name: 'orders', running, at: '2026-10-09T09:00:05Z' });
  };
  return { store, liveOf, change };
}
const apiWith = (start: unknown, stop: unknown = accepted) =>
  ({ startWorkflow: vi.fn().mockResolvedValue(start), stopWorkflow: vi.fn().mockResolvedValue(stop) }) as unknown as StudioApi;
const doc = (store: ReturnType<typeof createStudioStore>) => store.getState().docs[0]!;
const texts = (store: ReturnType<typeof createStudioStore>) => store.getState().output.map((l) => [l.level, l.text]);

describe('Start and Stop follow the live status (2026-10-09; the liveness store, 2026-10-10)', () => {
  it('Start only while stopped, Stop only while running; neither while checking, unknown or a press is in progress', async () => {
    const base = { status: { kind: 'ready' }, run: null, saving: false };
    expect([runBlocked(base, 'stopped', 'start'), runBlocked(base, 'stopped', 'stop')]).toEqual([null, 'It is not running']);
    expect([runBlocked(base, 'running', 'start'), runBlocked(base, 'running', 'stop')]).toEqual(['It is running', null]);
    expect(runBlocked(base, 'checking', 'start')).toBe('Checking whether it runs…');
    expect(runBlocked(base, 'unknown', 'stop')).toBe('BaseApi could not say whether it runs');
    expect(runBlocked({ ...base, run: { op: 'start', phase: 'waiting', token: 't' } }, 'stopped', 'start')).toBe('Starting…');
    expect(runBlocked({ status: { kind: 'loading' }, run: null, saving: false }, 'stopped', 'start')).toBe('The workflow is not loaded');
    // a Save in flight blocks both (review 2026-10-09)
    expect(runBlocked({ ...base, saving: true }, 'stopped', 'start')).toBe('Saving…');
    expect(runBlocked({ ...base, saving: true }, 'running', 'stop')).toBe('Saving…');
  });

  it('Start: request, accepted, then "running" once the live set lists it; Output logs each step', async () => {
    const { store, liveOf, change } = await storeWith('stopped');
    const api = apiWith(accepted);
    const later = vi.fn();

    await runWorkflow(api, store, 'wf1', 'start', liveOf, NOW, later);

    expect(api.startWorkflow).toHaveBeenCalledWith('wf1');
    expect(doc(store).run).toMatchObject({ op: 'start', phase: 'waiting' });
    expect(runBlocked(doc(store), liveOf(), 'start')).toBe('Starting…');
    expect(later).toHaveBeenCalledWith(expect.any(Function), RUN_TIMEOUT_MS);
    change(true);
    expect(doc(store).run).toBeNull();
    expect(texts(store)).toEqual([
      ['info', 'Start requested: POST /orchestration/start for the workflow BaseApi holds'],
      ['info', 'Start accepted by BaseApi (202): starting… waiting for the workflow to appear in the live set'],
      ['info', 'running'],
    ]);
    // the timeout of a press that is done changes nothing
    const before = store.getState();
    later.mock.calls[0]![0]();
    expect(store.getState()).toBe(before);
    expect([runBlocked(doc(store), liveOf(), 'start'), runBlocked(doc(store), liveOf(), 'stop')]).toEqual(['It is running', null]);
  });

  it('Start with an unsaved design says the design is not part of the run, and still starts', async () => {
    const { store, liveOf } = await storeWith('stopped');
    store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } });
    const api = apiWith(accepted);

    await runWorkflow(api, store, 'wf1', 'start', liveOf, NOW, vi.fn());

    expect(api.startWorkflow).toHaveBeenCalledTimes(1);
    expect(texts(store)[0]).toEqual(['info', 'Started the saved workflow; your unsaved design is not part of this run']);
  });

  it('a refusal is red with BaseApi\'s reason, and Start can be pressed again', async () => {
    const { store, liveOf } = await storeWith('stopped');

    await runWorkflow(apiWith(refused), store, 'wf1', 'start', liveOf, NOW, vi.fn());

    expect(doc(store).run).toBeNull();
    expect(texts(store).at(-1)).toEqual(['error', 'Start refused by BaseApi: 422: Processor p is not live.']);
    expect(runBlocked(doc(store), liveOf(), 'start')).toBeNull();
  });

  it('an accepted Start the live set never lists (a parked message) ends in red after the timeout', async () => {
    const { store, liveOf } = await storeWith('stopped');
    const later = vi.fn();

    await runWorkflow(apiWith(accepted), store, 'wf1', 'start', liveOf, NOW, later);
    expect(doc(store).run).not.toBeNull();
    later.mock.calls[0]![0]();

    expect(doc(store).run).toBeNull();
    expect(texts(store).at(-1)![0]).toBe('error');
    expect(texts(store).at(-1)![1]).toMatch(/^Start accepted, but the workflow is not in the live set after 30 s: its start message may have been parked/);
    expect(runBlocked(doc(store), liveOf(), 'start')).toBeNull();
  });

  it('Stop: request, accepted, then "stopped" once the live set drops it; a press not allowed sends nothing', async () => {
    const { store, liveOf, change } = await storeWith('running');
    const api = apiWith(accepted);

    await runWorkflow(api, store, 'wf1', 'start', liveOf, NOW, vi.fn());
    expect(api.startWorkflow).not.toHaveBeenCalled();
    await runWorkflow(api, store, 'wf1', 'stop', liveOf, NOW, vi.fn());
    change(false);

    expect(api.stopWorkflow).toHaveBeenCalledWith('wf1');
    expect(doc(store).run).toBeNull();
    expect(texts(store)).toEqual([
      ['info', 'Stop requested: POST /orchestration/stop for the workflow BaseApi holds'],
      ['info', 'Stop accepted by BaseApi (202): stopping… waiting for the workflow to leave the live set'],
      ['info', 'stopped'],
    ]);
  });

  it('a change seen while the request was on its way is logged once, and the answer finishes the press', async () => {
    const { store, liveOf, change } = await storeWith('stopped');
    const api = { startWorkflow: vi.fn().mockImplementation(async () => { change(true); return accepted; }) } as unknown as StudioApi;

    await runWorkflow(api, store, 'wf1', 'start', liveOf, NOW, vi.fn());

    expect(doc(store).run).toBeNull();
    expect(texts(store)).toEqual([
      ['info', 'Start requested: POST /orchestration/start for the workflow BaseApi holds'],
      ['info', 'running'],
      ['info', 'Start accepted by BaseApi (202)'],
    ]);
  });

  it('a change that disagrees with the press is logged and the press keeps waiting', async () => {
    const { store, liveOf, change } = await storeWith('running');
    await runWorkflow(apiWith(accepted), store, 'wf1', 'stop', liveOf, NOW, vi.fn());
    change(true);   // "running" again: not this Stop's answer
    expect(doc(store).run).toMatchObject({ op: 'stop', phase: 'waiting' });
    expect(texts(store).at(-1)).toEqual(['info', 'running']);
  });

  it('a change of a workflow that is not open is logged under the name given', () => {
    const store = createStudioStore();
    store.dispatch({ type: 'liveChanged', workflowId: 'wf9', name: 'billing', running: true, at: '2026-10-09T09:00:05Z' });
    expect(store.getState().output).toEqual([{ at: '2026-10-09T09:00:05Z', workflowId: 'wf9', name: 'billing', text: 'running', level: 'info' }]);
  });
});

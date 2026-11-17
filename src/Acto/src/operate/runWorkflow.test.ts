import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import type { BoardStore } from '../design/boardStore';
import { liveStub } from '../test/liveStub';
import { createOutputStore } from '../output/outputStore';
import { RUN_TIMEOUT_MS, runWorkflow } from './runWorkflow';

const entry = (name: string, base: object | null, unsaved = false) => ({ base, unsaved, history: { present: { fields: { name } } } });
const storeOf = (e: unknown) => ({ entry: () => e }) as unknown as BoardStore;
const apiOf = (answer: ApiResult<null>) => {
  const call = vi.fn(async () => answer);
  return { api: { startWorkflow: call, stopWorkflow: call } as unknown as StudioApi, call };
};
const ok: ApiResult<null> = { ok: true, value: null };
const texts = (o: ReturnType<typeof createOutputStore>) => o.lines().map((l) => [l.level, l.text]);

describe('runWorkflow', () => {
  it('refuses a never-saved workflow without a request', async () => {
    const { api, call } = apiOf(ok); const o = createOutputStore(null);
    expect(await runWorkflow(api, storeOf(entry('new-workflow-1', null)), o, liveStub(), 'w1', 'start')).toBe('refused');
    expect(call).not.toHaveBeenCalled();
    expect(o.lines()[0]!.text).toBe('new-workflow-1: not saved yet — BaseAPI has no such workflow');
  });
  it('an unsaved Start says so first, then requests', async () => {
    const { api, call } = apiOf(ok); const o = createOutputStore(null);
    expect(await runWorkflow(api, storeOf(entry('orders', {}, true)), o, liveStub(), 'w1', 'start', () => undefined)).toBe('requested');
    expect(call).toHaveBeenCalledWith('w1');
    expect(o.lines().map((l) => l.text)).toEqual([
      'orders: started the saved workflow; your unsaved changes are not part of this run', 'orders: Start requested']);
  });
  it('a 422 is a failure with the reason BaseAPI gave', async () => {
    const { api } = apiOf({ ok: false, error: { kind: 'unprocessable', status: 422, detail: 'processor liveness: x is not live' } });
    const o = createOutputStore(null);
    expect(await runWorkflow(api, storeOf(entry('orders', {})), o, liveStub(), 'w1', 'start')).toBe('failed');
    expect(texts(o).at(-1)).toEqual(['error', 'orders: Start refused — processor liveness: x is not live']);
  });
  it('a network error is a failure', async () => {
    const { api } = apiOf({ ok: false, error: { kind: 'network', message: 'down' } });
    const o = createOutputStore(null);
    expect(await runWorkflow(api, storeOf(entry('orders', {})), o, liveStub(), 'w1', 'stop')).toBe('failed');
    expect(texts(o).at(-1)).toEqual(['error', 'orders: Stop failed — Network error: down']);
  });
  it('reports an accepted start that is still not running after the timeout', async () => {
    const live = liveStub(); live.known([]);
    const { api } = apiOf(ok); const o = createOutputStore(null);
    let run: () => void = () => undefined; let ms = 0;
    await runWorkflow(api, storeOf(entry('orders', {})), o, live, 'w1', 'start', (r, m) => { run = r; ms = m; });
    expect(ms).toBe(RUN_TIMEOUT_MS);
    run();
    expect(texts(o).at(-1)).toEqual(['error', 'orders: Start accepted, but it is still not running after 30 s']);
  });
  it('says nothing when the live state agreed by then', async () => {
    const live = liveStub(); live.known([]);
    const { api } = apiOf(ok); const o = createOutputStore(null);
    let run: () => void = () => undefined;
    await runWorkflow(api, storeOf(entry('orders', {})), o, live, 'w1', 'start', (r) => { run = r; });
    live.known(['w1']); run();
    expect(o.lines().map((l) => l.text)).toEqual(['orders: Start requested']);
  });
  it('a stop that is still running is reported', async () => {
    const live = liveStub(); live.known(['w1']);
    const { api } = apiOf(ok); const o = createOutputStore(null);
    let run: () => void = () => undefined;
    await runWorkflow(api, storeOf(entry('orders', {})), o, live, 'w1', 'stop', (r) => { run = r; });
    run();
    expect(texts(o).at(-1)).toEqual(['error', 'orders: Stop accepted, but it is still not stopped after 30 s']);
  });
  it('a Start overtaken by a Stop before its timer says nothing about the Start', async () => {
    const live = liveStub(); live.known([]);
    const { api } = apiOf(ok); const o = createOutputStore(null);
    const runs: (() => void)[] = [];
    await runWorkflow(api, storeOf(entry('orders', {})), o, live, 'w1', 'start', (r) => { runs.push(r); });
    await runWorkflow(api, storeOf(entry('orders', {})), o, live, 'w1', 'stop', (r) => { runs.push(r); });
    runs.forEach((r) => r());
    expect(texts(o).filter(([level]) => level === 'error')).toEqual([]);
  });
  it('a press on another workflow does not silence this one', async () => {
    const live = liveStub(); live.known([]);
    const { api } = apiOf(ok); const o = createOutputStore(null);
    const runs: (() => void)[] = [];
    await runWorkflow(api, storeOf(entry('orders', {})), o, live, 'w1', 'start', (r) => { runs.push(r); });
    await runWorkflow(api, storeOf(entry('billing', {})), o, live, 'w2', 'stop', (r) => { runs.push(r); });
    runs.forEach((r) => r());
    expect(texts(o).filter(([level]) => level === 'error')).toEqual([['error', 'orders: Start accepted, but it is still not running after 30 s']]);
  });
  it.each([['checking'], ['unknown']] as const)('a live set still %s by then says it could not be confirmed', async (k) => {
    const live = liveStub(); live.known([]);
    const { api } = apiOf(ok); const o = createOutputStore(null);
    let run: () => void = () => undefined;
    await runWorkflow(api, storeOf(entry('orders', {})), o, live, 'w1', 'start', (r) => { run = r; });
    live.set({ workflows: k }); run();
    expect(texts(o).at(-1)).toEqual(['error', 'orders: Start accepted, but it could not be confirmed after 30 s']);
  });
});

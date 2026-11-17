import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { fakeApi, graphWith } from '../board/testApi';
import { createOutputStore } from '../output/outputStore';
import { createBoardStore } from './boardStore';
import { bwFull, proc } from './fixtures';
import { moveStep, removeStep } from './state';
import { saveWorkflow } from './saveWorkflow';

function setup(opts: { applied?: boolean; problems?: { title: string; detail: string }[]; layout?: unknown } = {}) {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  store.load({ listed: true, workflows: [bwFull()], failures: [] }, [proc('p1', 'Analyst')]);
  const api = fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] }, layout: opts.layout ?? null }) });
  Object.assign(api, {
    saveDesign: vi.fn().mockResolvedValue({
      ok: true,
      value: opts.applied === false ? { applied: false, errors: [{ kind: 'step', id: 'a', message: 'bad entry' }] } : { applied: true, errors: [] },
    }),
    validateWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { valid: !opts.problems, problems: opts.problems ?? [] } }),
  });
  store.edit('w1', (s) => moveStep(s, 'a', { x: 99, y: 99 }));
  return { api: api as StudioApi, store, output, texts: () => output.lines().map((l) => `${l.level}:${l.text}`) };
}

describe('saveWorkflow', () => {
  it('sends one request, re-reads, publishes an svg and logs saved', async () => {
    const { api, store, output, texts } = setup();
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    expect(api.publishDiagram).toHaveBeenCalledWith('w1', expect.stringContaining('<svg'));
    expect(store.entry('w1')!.unsaved).toBe(false);
    expect(store.entry('w1')!.problems).toBe(0);
    expect(texts()).toContain('ok:orders saved');
    expect(texts()).toContain('ok:orders: Kibana diagram published');
  });
  it('keeps unsaved and logs each error when not applied', async () => {
    const { api, store, output, texts } = setup({ applied: false });
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('refused');
    expect(store.entry('w1')!.unsaved).toBe(true);
    expect(texts()).toContain('error:orders: a-name — bad entry');
    expect(api.publishDiagram).not.toHaveBeenCalled();
  });
  it('warns first when the stored layout changed elsewhere', async () => {
    const { api, store, output, texts } = setup({ layout: { board: { x: 1, y: 1, w: 9, h: 9 } } });
    await saveWorkflow(api, store, output, 'w1');
    expect(texts()[0]).toBe('warn:orders changed elsewhere since it was loaded; saving over it');
  });
  it('logs validation problems and sets the count', async () => {
    const { api, store, output, texts } = setup({ problems: [{ title: 'Cycle', detail: 'a loops' }] });
    await saveWorkflow(api, store, output, 'w1');
    expect(texts()).toContain('warn:orders: Cycle — a loops');
    expect(store.entry('w1')!.problems).toBe(1);
  });
  it('reports an HTTP failure', async () => {
    const { api, store, output, texts } = setup();
    (api.saveDesign as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('failed');
    expect(texts()).toContain('error:orders: Network error: down');
  });
  it('names an assignment error and a deleted step from the base', async () => {
    const { api, store, output, texts } = setup({ applied: false });
    store.edit('w1', (s) => removeStep(s, 'b'));
    (api.saveDesign as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, value: { applied: false, errors: [{ kind: 'assignment', id: 'as0', message: 'm1' }, { kind: 'step', id: 'b', message: 'm2' }] },
    });
    await saveWorkflow(api, store, output, 'w1');
    expect(texts()).toContain('error:orders: a-name-assignment — m1');
    expect(texts()).toContain('error:orders: b-name — m2');
  });
  it('adopts the present state when the re-read fails', async () => {
    const { api, store, output, texts } = setup();
    const get = api.getGraph as ReturnType<typeof vi.fn>;
    const first = get.getMockImplementation()!;
    get.mockImplementationOnce(first).mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    expect(store.entry('w1')!.unsaved).toBe(false);
    expect(texts()).toContain('error:orders saved, but could not be read back: Network error: down. Reload before editing it again');
    expect(api.validateWorkflow).not.toHaveBeenCalled();
    expect(api.publishDiagram).not.toHaveBeenCalled();
  });
  it('refuses a second save while one is in flight', async () => {
    const { api, store, output, texts } = setup();
    const [a, b] = await Promise.all([saveWorkflow(api, store, output, 'w1'), saveWorkflow(api, store, output, 'w1')]);
    expect([a, b]).toEqual(['saved', 'refused']);
    expect(api.saveDesign).toHaveBeenCalledTimes(1);
    expect(texts()).toContain('info:orders is already saving');
    expect(store.entry('w1')!.saving).toBe(false);
  });
  it('refuses an edit during a save', async () => {
    const { api, store, output, texts } = setup();
    const p = saveWorkflow(api, store, output, 'w1');
    const before = store.entry('w1')!.history;
    store.edit('w1', (s) => moveStep(s, 'a', { x: 1, y: 1 }));
    expect(store.entry('w1')!.history).toBe(before);
    expect(texts()).toContain('warn:orders is saving — wait for it to finish');
    await p;
  });
});

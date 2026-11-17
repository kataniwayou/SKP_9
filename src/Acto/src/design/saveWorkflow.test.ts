import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { fakeApi, graphWith, wf } from '../board/testApi';
import type { DesignSaveRequest } from './request';
import { createOutputStore } from '../output/outputStore';
import { createBoardStore } from './boardStore';
import { bwFull, proc } from './fixtures';
import { moveStep, removeStep, setProcessorField, setSlotField, setStepField } from './state';
import { processorDto, schemaDto } from '../api/fixtures';
import { AUDIT } from '../model/fixtures';
import { bw } from '../board/fixtures';
import { saveWorkflow } from './saveWorkflow';
import { memoryStorage } from '../test/memoryStorage';

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
  // BaseAPI stores the layout before its dry run, so the next save must compare against what was sent
  const sentLayout = (api: StudioApi, call = 0) => ((api.saveDesign as ReturnType<typeof vi.fn>).mock.calls[call]![1] as DesignSaveRequest).layout;
  const serveLayout = (api: StudioApi, layout: unknown) =>
    (api.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] }, layout }) });
  const elsewhere = 'warn:orders changed elsewhere since it was loaded; saving over it';
  it('does not warn of a change elsewhere when retrying after a refused save', async () => {
    const { api, store, output, texts } = setup({ applied: false });
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('refused');
    serveLayout(api, sentLayout(api));
    await saveWorkflow(api, store, output, 'w1');
    expect(texts()).not.toContain(elsewhere);
    expect(sentLayout(api, 1)).toEqual(sentLayout(api, 0));
  });
  it('does not warn of a change elsewhere when saving again after a failed re-read', async () => {
    const { api, store, output, texts } = setup();
    const get = api.getGraph as ReturnType<typeof vi.fn>;
    get.mockImplementationOnce(get.getMockImplementation()!).mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    store.edit('w1', (s) => moveStep(s, 'a', { x: 120, y: 120 }));
    serveLayout(api, sentLayout(api));
    await saveWorkflow(api, store, output, 'w1');
    expect(texts()).not.toContain(elsewhere);
  });
  it('does not warn of a change elsewhere when retrying after a 409', async () => {
    const { api, store, output, texts } = setup();
    (api.saveDesign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: { kind: 'conflict', status: 409, detail: 'stale', entity: null } });
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('failed');
    serveLayout(api, sentLayout(api));
    await saveWorkflow(api, store, output, 'w1');
    expect(texts()).not.toContain(elsewhere);
  });
  it('keeps the step positions it saved instead of the re-read defaults', async () => {
    const { api, store, output } = setup();
    store.edit('w1', (s) => moveStep(s, 'a', { x: 150, y: 80 }));
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    expect(store.entry('w1')!.base!.steps.a!.at).toEqual({ x: 150, y: 80 });
    expect(store.boards()[0]!.stepAt.get('a')).toEqual({ x: 150, y: 80 });
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

describe('re-reading the workflows that share what a save changed', () => {
  /** w1 'orders' [a → b], w2 'billing' [a] shares step a, w3 'audit' [z] shares nothing. */
  function sharing(graphError?: Record<string, { kind: 'network'; message: string }>, session: Storage | null = null) {
    const output = createOutputStore(null, () => '00:00:00');
    const store = createBoardStore(output, session);
    const w2 = bw('w2', ['a']);
    w2.graph.workflow = { ...w2.graph.workflow, name: 'billing' };
    const w3 = bw('w3', ['z']);
    w3.graph.workflow = { ...w3.graph.workflow, name: 'audit' };
    store.load({ listed: true, workflows: [bwFull(), w2, w3], failures: [] }, [proc('p1', 'Analyst')]);
    const renamedA = graphWith({ entry: ['a'], steps: { a: [] } });
    renamedA.steps = renamedA.steps!.map((s) => ({ ...s, name: 'renamed' }));
    const api = fakeApi({
      workflows: [{ ...wf('w1'), name: 'orders' }, { ...wf('w2'), name: 'billing' }],
      graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }),
      graphs: { w2: renamedA },
      graphError,
    });
    Object.assign(api, {
      saveDesign: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [] } }),
      validateWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }),
    });
    return { api: api as StudioApi, store, output, texts: () => output.lines().map((l) => `${l.level}:${l.text}`) };
  }
  const reads = (api: StudioApi) => (api.getGraph as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

  it('an applied save of a shared-step change re-reads the sharer only', async () => {
    const { api, store, output, texts } = sharing();
    store.edit('w1', (s) => setStepField(s, 'a', 'name', 'renamed'));
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    expect(reads(api)).toEqual(['w1', 'w1', 'w2']);
    expect(texts()).toContain('info:billing: re-read after orders saved');
    expect(store.entry('w2')!.history.present.steps.a!.name).toBe('renamed');
    expect(store.entry('w3')!.history.present.steps.z!.name).toBe('z-name');
  });
  it('re-reads nobody when only a move was saved', async () => {
    const { api, store, output } = sharing();
    store.edit('w1', (s) => moveStep(s, 'a', { x: 300, y: 300 }));
    await saveWorkflow(api, store, output, 'w1');
    expect(reads(api)).toEqual(['w1', 'w1']);
  });
  it('re-reads nobody when the save was not applied', async () => {
    const { api, store, output } = sharing();
    (api.saveDesign as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: { applied: false, errors: [] } });
    store.edit('w1', (s) => setStepField(s, 'a', 'name', 'renamed'));
    await saveWorkflow(api, store, output, 'w1');
    expect(reads(api)).toEqual(['w1']);
  });
  it('the saved workflow is editable again while its sharers are still being re-read', async () => {
    const { api, store, output } = sharing();
    const get = api.getGraph as ReturnType<typeof vi.fn>;
    const real = get.getMockImplementation()! as (id: string) => unknown;
    let release: () => void = () => {};
    get.mockImplementation((id: string) => (id === 'w2' ? new Promise((res) => { release = () => res(real(id)); }) : real(id)));
    store.edit('w1', (s) => setStepField(s, 'a', 'name', 'renamed'));
    const saving = saveWorkflow(api, store, output, 'w1');
    await vi.waitFor(() => expect(reads(api)).toContain('w2'));
    expect(store.entry('w1')!.saving).toBe(false);
    store.edit('w1', (s) => moveStep(s, 'a', { x: 321, y: 123 }));
    expect(store.entry('w1')!.history.present.steps.a!.at).toEqual({ x: 321, y: 123 });
    release();
    expect(await saving).toBe('saved');
  });
  it('says so when the sharer had its own unsaved change to what was saved, which the save replaced', async () => {
    // drafts brought back both workflows renaming step a (the lock lets neither block the other)
    const draftOf = (wfId: string, name: string) => {
      const session = memoryStorage();
      const { store } = sharing(undefined, session);
      store.edit(wfId, (s) => setStepField(s, 'a', 'name', name));
      return JSON.parse(session.getItem('acto.drafts')!) as Record<string, unknown>;
    };
    const session = memoryStorage({ 'acto.drafts': JSON.stringify({ ...draftOf('w1', 'renamed'), ...draftOf('w2', 'mine') }) });
    const { api, store, output, texts } = sharing(undefined, session);
    expect(store.entry('w2')!.history.present.steps.a!.name).toBe('mine');
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    expect(store.entry('w2')!.history.present.steps.a!.name).toBe('renamed');
    expect(texts()).toContain('warn:billing: step renamed was saved by orders; your unsaved change to it was replaced');
  });
  it('says nothing more when the sharer had no change of its own to what was saved', async () => {
    const { api, store, output, texts } = sharing();
    store.edit('w1', (s) => setStepField(s, 'a', 'name', 'renamed'));
    await saveWorkflow(api, store, output, 'w1');
    expect(texts().filter((t) => t.includes('your unsaved change'))).toEqual([]);
  });
  it('a sharer that cannot be re-read stays as it was, with a warning', async () => {
    const { api, store, output, texts } = sharing({ w2: { kind: 'network', message: 'down' } });
    const before = store.entry('w2');
    store.edit('w1', (s) => setStepField(s, 'a', 'name', 'renamed'));
    await saveWorkflow(api, store, output, 'w1');
    expect(texts()).toContain('warn:billing: could not re-read after orders saved — Network error: down');
    expect(store.entry('w2')).toBe(before);
  });
});

describe('a saved processor change', () => {
  /** w1 'orders' [a → b] on p1 'Analyst' (input schema s0), the processor list holding the same. */
  function procSetup(stored: { name?: string; inputSchemaId?: string; schemas?: ReturnType<typeof schemaDto>[] }) {
    const output = createOutputStore(null, () => '00:00:00');
    const store = createBoardStore(output, null);
    const p1 = { ...proc('p1', 'Analyst'), inputSchemaId: 's0' };
    const w = bwFull();
    w.graph.processors = new Map([['p1', p1]]);
    w.graph.schemas = new Map([['s0', { id: 's0', name: 'in', version: '1.0.0', description: null, definition: '{"s0":1}', audit: AUDIT }]]);
    store.load({ listed: true, workflows: [w], failures: [] }, [p1]);
    const g = graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } });
    g.processors = [processorDto('p1', { name: stored.name ?? 'Analyst', inputSchemaId: stored.inputSchemaId ?? 's0' })];
    g.schemas = stored.schemas ?? [schemaDto('s0', { name: 'in', definition: '{"s0":1}' })];
    const api = fakeApi({ workflows: [{ ...wf('w1'), name: 'orders' }], graph: g });
    Object.assign(api, {
      saveDesign: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [] } }),
      validateWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }),
    });
    return { api: api as StudioApi, store, output };
  }
  const shownP1 = (store: ReturnType<typeof createBoardStore>) => store.boards().find((b) => b.graph.workflow.id === 'w1')!.graph.processors.get('p1')!;

  it('shows the saved processor in the saving workflow afterwards', async () => {
    const { api, store, output } = procSetup({ name: 'New' });
    store.edit('w1', (s) => setProcessorField(s, store.processor('p1', 'w1')!, 'name', 'New'));
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    expect(shownP1(store).name).toBe('New');
    expect(store.processor('p1', 'w1')!.name).toBe('New');
    expect(store.entry('w1')!.unsaved).toBe(false);
  });
  it('a second slot edit after a save starts from the saved copy, not the schema it replaced', async () => {
    const { api, store, output } = procSetup({ inputSchemaId: 'c1', schemas: [schemaDto('c1', { name: 'in', definition: '{"c1":1}' })] });
    const slotEdit = (key: 'definition' | 'name', v: string, id: string) => store.edit('w1', (s) => {
      const base = store.processor('p1', 'w1')!;
      return setSlotField(s, base, 'input', base.inputSchemaId ? store.schema(base.inputSchemaId, 'w1') : null, key, v, () => id);
    });
    slotEdit('definition', '{"c1":1}', 'c1');
    expect(await saveWorkflow(api, store, output, 'w1')).toBe('saved');
    expect(shownP1(store).inputSchemaId).toBe('c1');
    slotEdit('name', 'in-2', 'c2');
    const e = store.entry('w1')!.history.present.processors!.p1!.slots.input!;
    expect('copy' in e && e.copy).toMatchObject({ id: 'c2', name: 'in-2', definition: '{"c1":1}' });
  });
});

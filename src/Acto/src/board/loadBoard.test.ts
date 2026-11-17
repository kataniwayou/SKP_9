import { describe, expect, it } from 'vitest';
import { loadBoard, loadWorkflow } from './loadBoard';
import { fakeApi, graphWith, stepDto, wf } from './testApi';

describe('loadBoard', () => {
  it('loads every workflow and places them', async () => {
    const r = await loadBoard(fakeApi({ workflows: [wf('w1', '2026-01-01'), wf('w2', '2026-01-02')] }));
    expect(r.workflows.map((w) => w.graph.workflow.id)).toEqual(['w1', 'w2']);
    expect(r.failures).toEqual([]);
    expect(r.workflows[0].frame.x).toBe(0);
    expect(r.workflows[1].frame).not.toEqual(r.workflows[0].frame);
  });
  it('keeps the others when one graph fails, and names the failure', async () => {
    const r = await loadBoard(fakeApi({ workflows: [wf('w1'), wf('w2')], graphError: { w2: { kind: 'http', status: 500, detail: 'boom' } } }));
    expect(r.workflows.map((w) => w.graph.workflow.id)).toEqual(['w1']);
    expect(r.failures).toEqual([{ workflowId: 'w2', name: 'w2-name', detail: '500: boom' }]);
  });
  it('keeps the list order and honours a stored board rectangle', async () => {
    const stored = { x: 500, y: 600, w: 900, h: 700 };
    const r = await loadBoard(fakeApi({
      workflows: [wf('w1'), wf('w2')],
      graphs: { w1: graphWith({ entry: ['a'], steps: { a: [] }, layout: { board: stored } }) },
    }), 1);
    expect(r.workflows.map((w) => w.graph.workflow.id)).toEqual(['w1', 'w2']);
    expect(r.workflows[0].frame).toEqual(stored);
  });
});

describe('loadBoard as graphs arrive', () => {
  it('calls onWorkflow as each graph is placed, and the result matches the one-shot placement for stored frames', async () => {
    const stored = { x: 500, y: 600, w: 900, h: 700 };
    const mk = () => fakeApi({
      workflows: [wf('w1'), wf('w2')],
      graphs: { w1: graphWith({ entry: ['a'], steps: { a: [] }, layout: { board: stored } }), w2: graphWith({ entry: ['a'], steps: { a: [] }, layout: { board: { x: 0, y: 0, w: 400, h: 300 } } }) },
    });
    const gate = (api: ReturnType<typeof fakeApi>) => {
      const get = api.getGraph;
      const slow: Record<string, () => void> = {};
      api.getGraph = ((id: string) => id === 'w1' ? new Promise((res) => { slow.w1 = () => res(get(id)); }) : get(id)) as typeof api.getGraph;
      return slow;
    };
    const api = mk();
    const slow = gate(api);
    const seen: string[] = [];
    const p = loadBoard(api, 4, (bw) => { seen.push(bw.graph.workflow.id); if (bw.graph.workflow.id === 'w2') slow.w1!(); });
    const r = await p;
    expect(seen).toEqual(['w2', 'w1']);
    const once = await loadBoard(mk(), 4);
    expect(r).toEqual(once);
    expect(r.workflows.map((w) => w.graph.workflow.id)).toEqual(['w1', 'w2']);
    expect(r.workflows[0].frame).toEqual(stored);
  });
  it('places a frame without a stored one clear of those already on the board', async () => {
    const placedFrames: { x: number; y: number; w: number; h: number }[] = [];
    await loadBoard(fakeApi({ workflows: [wf('w1', '2026-01-01'), wf('w2', '2026-01-02')] }), 1, (bw) => placedFrames.push(bw.frame));
    expect(placedFrames).toHaveLength(2);
    expect(placedFrames[1]).not.toEqual(placedFrames[0]);
  });
});

describe('loadBoard final layout', () => {
  const g = (board?: { x: number; y: number; w: number; h: number }) => graphWith({ entry: ['a'], steps: { a: [] }, ...(board ? { layout: { board } } : {}) });
  /** Graph reads resolve in `order`, one by one. */
  async function inOrder(workflows: ReturnType<typeof wf>[], graphs: Record<string, ReturnType<typeof g>>, order: string[]) {
    const api = fakeApi({ workflows, graphs });
    const get = api.getGraph;
    const gates = new Map<string, () => void>();
    api.getGraph = ((id: string) => new Promise((res) => { gates.set(id, () => res(get(id))); })) as typeof api.getGraph;
    const p = loadBoard(api, 10);
    for (const id of order) {
      while (!gates.has(id)) await new Promise((r) => setTimeout(r, 0));
      gates.get(id)!();
      await new Promise((r) => setTimeout(r, 0));
    }
    return p;
  }
  const frames = (r: Awaited<ReturnType<typeof loadBoard>>) => Object.fromEntries(r.workflows.map((w) => [w.graph.workflow.id, w.frame]));
  const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('lays unstored frames out in creation order whatever order they arrive in', async () => {
    const wfs = [wf('w1', '2026-01-01'), wf('w2', '2026-01-02')];
    const gs = { w1: g(), w2: g() };
    const late = await inOrder(wfs, gs, ['w2', 'w1']);
    const early = await inOrder(wfs, gs, ['w1', 'w2']);
    expect(frames(late)).toEqual(frames(early));
    expect(late.workflows[0].frame.x).toBe(0);
    expect(late.workflows[1].frame.x).toBeGreaterThan(0);
  });
  it('a stored frame arriving last leaves no overlap', async () => {
    const wfs = [wf('w1', '2026-01-01'), wf('w2', '2026-01-02')];
    const r = await inOrder(wfs, { w1: g({ x: 0, y: 0, w: 600, h: 400 }), w2: g() }, ['w2', 'w1']);
    const f = frames(r);
    expect(hit(f.w1!, f.w2!)).toBe(false);
    expect(f.w1).toEqual({ x: 0, y: 0, w: 600, h: 400 });
  });
  it('reports the final frames of those whose provisional slot changed', async () => {
    const wfs = [wf('w1', '2026-01-01'), wf('w2', '2026-01-02')];
    const seen: Record<string, unknown> = {};
    const r = await inOrder(wfs, { w1: g({ x: 0, y: 0, w: 600, h: 400 }), w2: g() }, ['w2', 'w1']);
    void seen;
    expect(r.finalFrames!.get('w2')).toEqual(frames(r).w2);
    expect(r.finalFrames!.has('w1')).toBe(false);
  });
});

describe('loadWorkflow', () => {
  it('brings parked steps from the layout and drops ones that are gone', async () => {
    const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: [] }, layout: { parked: ['p', 'gone'] } }), extraSteps: { p: stepDto('p') } }), 'w1');
    expect(r.ok && r.value.stepIds).toEqual(['a', 'p']);
    expect(r.ok && r.value.roles.get('p')).toBe('parked');
    expect(r.ok && r.value.graph.steps.has('p')).toBe(true);
  });
  it('reports stored first steps that differ from the wires', async () => {
    const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a', 'b'], steps: { a: ['b'], b: [] } }) }), 'w1');
    expect(r.ok && r.value.entryDiff).toEqual({ stops: ['b'], starts: [] });
  });
  it('uses layout positions where present and defaults elsewhere', async () => {
    const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] }, layout: { steps: { a: { x: 40, y: 50 } } } }) }), 'w1');
    expect(r.ok && r.value.stepAt.get('a')).toEqual({ x: 28, y: 28 });
    expect(r.ok && r.value.stepAt.has('b')).toBe(true);
    expect(r.ok && r.value.wires.map((w) => w.id)).toEqual(['a>b']);
  });
  it('shifts stored positions so the top-left step sits at the frame padding, keeping the layout', async () => {
    const r = await loadBoard(fakeApi({
      workflows: [wf('w1')],
      graphs: { w1: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] }, layout: { steps: { a: { x: -100, y: -240 }, b: { x: 300, y: -40 } } } }) },
    }));
    const w = r.workflows[0]!;
    expect(w.stepAt.get('a')).toEqual({ x: 28, y: 28 });
    expect(w.stepAt.get('b')).toEqual({ x: 428, y: 228 });
    expect(w.frame.w).toBeGreaterThanOrEqual(428 + 210 + 28);
    expect(w.frame.h).toBeGreaterThanOrEqual(46 + 228 + 92 + 28);
  });
  it('keeps positions Acto stored (a board rectangle, nothing negative) exactly where they were', async () => {
    const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] },
      layout: { board: { x: 0, y: 0, w: 900, h: 500 }, steps: { a: { x: 150, y: 80 }, b: { x: 450, y: 80 } } } }) }), 'w1');
    expect(r.ok && r.value.stepAt.get('a')).toEqual({ x: 150, y: 80 });
    expect(r.ok && r.value.stepAt.get('b')).toEqual({ x: 450, y: 80 });
  });
  it('still shifts a layout with a board rectangle when a position is negative (WorkflowStudio canvas)', async () => {
    const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: [] },
      layout: { board: { x: 0, y: 0, w: 900, h: 500 }, steps: { a: { x: -40, y: 80 } } } }) }), 'w1');
    expect(r.ok && r.value.stepAt.get('a')).toEqual({ x: 28, y: 28 });
  });
  it('fetches the caches a stored design links that the workflow does not hold yet', async () => {
    const api = fakeApi({ graph: { ...graphWith({ entry: ['a'], steps: { a: [] } }), design: { workflow: { cacheIds: ['c9'] } } } as never });
    api.getEntity = (async (kind: string, id: string) => (kind === 'cache' && id === 'c9'
      ? { ok: true, value: { id: 'c9', name: 'shared', version: '2.0.0', description: null, root: 'real-root', items: '{"k":1}' } }
      : { ok: false, error: { kind: 'notFound', status: 404 } })) as typeof api.getEntity;
    const r = await loadWorkflow(api, 'w1');
    expect(r.ok && r.value.designCaches?.get('c9')).toMatchObject({ name: 'shared', root: 'real-root', items: '{"k":1}' });
  });
  it('puts unplaced steps below the stored ones, never on top of them', async () => {
    const r = await loadWorkflow(fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] }, layout: { steps: { b: { x: -50, y: -200 } } } }) }), 'w1');
    expect(r.ok && r.value.stepAt.get('b')).toEqual({ x: 28, y: 28 });
    const a = r.ok ? r.value.stepAt.get('a')! : { x: 0, y: 0 };
    expect(a.y).toBeGreaterThanOrEqual(28 + 92);
  });
  it('returns, never rejects, when the graph fails or the api throws', async () => {
    const bad = await loadWorkflow(fakeApi({ graphError: { w1: { kind: 'http', status: 500, detail: 'boom' } } }), 'w1');
    expect(bad).toEqual({ ok: false, error: { kind: 'http', status: 500, detail: 'boom' } });
    const api = fakeApi();
    api.getGraph = async () => { throw new Error('kaboom'); };
    const thrown = await loadWorkflow(api, 'w1');
    expect(!thrown.ok && thrown.error).toMatchObject({ kind: 'http', status: 0 });
  });
  it('does not look up a processor for a parked step with no processor id', async () => {
    const api = fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: [] }, layout: { parked: ['p'] } }), extraSteps: { p: { ...stepDto('p'), processorId: undefined } } });
    const r = await loadWorkflow(api, 'w1');
    expect(r.ok && r.value.graph.steps.get('p')?.processorId).toBeFalsy();
    expect(api.getProcessor).not.toHaveBeenCalled();
  });
  it('passes on a parked-step error other than notFound', async () => {
    const api = fakeApi({ graph: graphWith({ entry: ['a'], steps: { a: [] }, layout: { parked: ['p'] } }) });
    api.getStep = async () => ({ ok: false, error: { kind: 'network', message: 'down' } });
    expect((await loadWorkflow(api, 'w1')).ok).toBe(false);
  });
});

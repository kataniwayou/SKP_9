import { describe, expect, it } from 'vitest';
import type { BoardWorkflow } from '../board/loadBoard';
import { createOutputStore } from '../output/outputStore';
import { createBoardStore } from './boardStore';
import { bwFull, proc } from './fixtures';
import { canUndo } from './history';
import { addWire, moveMany, moveStep, newWorkflowState, removeWire, setStepField, type WorkflowState } from './state';
import { bw } from '../board/fixtures';
import { memoryStorage } from '../test/memoryStorage';

function storeWith(bw: BoardWorkflow, session: Storage | null = null) {
  const output = createOutputStore(null, () => '00:00:00');
  const st = createBoardStore(output, session);
  st.load({ listed: true, workflows: [bw], failures: [] }, [proc('p1', 'Analyst')]);
  return Object.assign(st, { output });
}
const lastLine = (st: { output: ReturnType<typeof createOutputStore> }) => {
  const l = st.output.lines(); const { text, level } = l[l.length - 1]!; return { text, level };
};

describe('board store', () => {
  it('marks unsaved and clears it by undoing back', () => {
    const st = storeWith(bwFull());
    st.edit('w1', (s) => moveStep(s, 'a', { x: 99, y: 99 }));
    expect(st.entry('w1')!.unsaved).toBe(true);
    st.undo('w1'); expect(st.entry('w1')!.unsaved).toBe(false);
  });
  it('a multi-step drag is one undo step that restores every moved step', () => {
    const st = storeWith(bwFull());
    const at = (id: string) => st.boards()[0]!.stepAt.get(id)!;
    const before = { a: { ...at('a') }, b: { ...at('b') } };
    st.edit('w1', (s) => moveMany(s, { steps: [{ id: 'a', at: { x: 500, y: 500 } }, { id: 'b', at: { x: 600, y: 500 } }], frame: { x: 40, y: 50 } }));
    expect(st.entry('w1')!.history.past).toHaveLength(1);
    st.undo('w1');
    expect({ a: at('a'), b: at('b') }).toEqual(before);
    expect(st.boards()[0]!.frame).toMatchObject({ x: 0, y: 0 });
    expect(st.entry('w1')!.history.past).toHaveLength(0);
  });
  it('logs a refused edit and records no step', () => {
    const st = storeWith(bwFull()); st.editOrRefuse('w1', (s) => addWire(s, 'a', 'a'));
    expect(lastLine(st)).toEqual({ text: 'A step cannot wire to itself', level: 'warn' });
    expect(st.entry('w1')!.history.past).toEqual([]);
  });
  it('clears history when a save replaces the base', () => {
    const st = storeWith(bwFull()); st.edit('w1', (s) => moveStep(s, 'a', { x: 1, y: 1 }));
    st.replace('w1', bwFull());
    expect(canUndo(st.entry('w1')!.history)).toBe(false); expect(st.entry('w1')!.unsaved).toBe(false);
  });
  it('restores a draft after refresh only when the workflow is unchanged', () => {
    const session = memoryStorage(); const st = storeWith(bwFull(), session);
    st.edit('w1', (s) => moveStep(s, 'a', { x: 5, y: 5 }));
    expect(storeWith(bwFull(), session).entry('w1')!.unsaved).toBe(true);
    const later = storeWith(bwFull({ updatedAt: 'later' }), session);
    expect(later.entry('w1')!.unsaved).toBe(false);
    expect(lastLine(later).text).toBe('orders: unsaved work from before the refresh was dropped because the workflow changed');
  });
  it('keeps boards() stable until something changes', () => {
    const st = storeWith(bwFull());
    const a = st.boards();
    expect(st.boards()).toBe(a);
    st.edit('w1', (s) => moveStep(s, 'a', { x: 7, y: 7 }));
    const b = st.boards();
    expect(b).not.toBe(a);
    expect(b[0]!.stepAt.get('a')).toEqual({ x: 7, y: 7 });
    expect(st.boards()).toBe(b);
  });
  it('applies a stored server design and says so', () => {
    const bw = bwFull();
    bw.graph.design = { workflow: { updatedAt: 'x', fields: { name: 'renamed' } } };
    const st = storeWith(bw);
    expect(st.entry('w1')!.history.present.fields.name).toBe('renamed');
    expect(st.entry('w1')!.unsaved).toBe(true);
    expect(lastLine(st)).toEqual({ text: 'orders: loaded unsaved work from a save that failed', level: 'warn' });
  });
  it('lets Undo go back from a stored server design to the saved workflow', () => {
    const bw = bwFull();
    bw.graph.design = { workflow: { updatedAt: 'x', fields: { name: 'renamed' } } };
    const st = storeWith(bw);
    expect(canUndo(st.entry('w1')!.history)).toBe(true);
    st.undo('w1');
    expect(st.entry('w1')!.history.present.fields.name).toBe('orders');
    expect(st.entry('w1')!.unsaved).toBe(false);
  });
  it('says once when unsaved work can no longer be kept across a refresh', () => {
    const full = memoryStorage();
    full.setItem = () => { throw new Error('QuotaExceededError'); };
    const st = storeWith(bwFull(), full);
    st.edit('w1', (s) => moveStep(s, 'a', { x: 5, y: 5 }));
    st.edit('w1', (s) => moveStep(s, 'a', { x: 6, y: 6 }));
    const warned = st.output.lines().filter((l) => l.text.startsWith('Unsaved work is no longer kept across refresh'));
    expect(warned.map((l) => [l.level, l.text])).toEqual([['warn', 'Unsaved work is no longer kept across refresh: QuotaExceededError']]);
  });
  it('a new workflow is unsaved and notifies subscribers', () => {
    const st = storeWith(bwFull()); let n = 0; st.subscribe(() => n++);
    st.addWorkflow(newWorkflowState('w2', 'fresh', { x: 0, y: 0 }));
    expect(st.entry('w2')!.unsaved).toBe(true); expect(n).toBe(1); expect(st.boards()).toHaveLength(2);
  });
  it('remove drops the workflow and its draft', () => {
    const session = memoryStorage(); const st = storeWith(bwFull(), session);
    st.edit('w1', (s) => moveStep(s, 'a', { x: 5, y: 5 }));
    expect(session.getItem('acto.drafts')).not.toBeNull();
    let n = 0; st.subscribe(() => n++);
    st.remove('w1');
    expect(st.entry('w1')).toBeNull(); expect(st.boards()).toHaveLength(0); expect(n).toBe(1);
    expect(session.getItem('acto.drafts')).toBeNull();
  });
  it('keeps the draft of a workflow a partial load did not bring back, and restores it on a later load', () => {
    const session = memoryStorage();
    storeWith(bwFull(), session).edit('w1', (s) => moveStep(s, 'a', { x: 5, y: 5 }));
    const partial = createBoardStore(createOutputStore(null, () => '00:00:00'), session);
    partial.load({ listed: true, workflows: [], failures: [{ workflowId: 'w1', name: 'orders', detail: 'x' }] }, []);
    expect(Object.keys(JSON.parse(session.getItem('acto.drafts')!))).toEqual(['w1']);
    expect(storeWith(bwFull(), session).entry('w1')!.unsaved).toBe(true);
  });
});

describe('the shared-entity lock', () => {
  /** w1 'orders' and w2 'billing' both reach step s1 'extract'; w3 'audit' too when asked. */
  function shared(withAudit = false) {
    const mk = (id: string, name: string, steps: string[]) => {
      const b = bw(id, steps);
      b.graph.workflow = { ...b.graph.workflow, name };
      b.graph.steps.set('s1', { ...b.graph.steps.get('s1')!, name: 'extract' });
      return b;
    };
    const ws = [mk('w1', 'orders', ['s1', 't', 'u']), mk('w2', 'billing', ['s1'])];
    if (withAudit) ws.push(mk('w3', 'audit', ['s1']));
    const output = createOutputStore(null, () => '00:00:00');
    const st = createBoardStore(output, null);
    st.load({ listed: true, workflows: ws, failures: [] }, []);
    return Object.assign(st, { output });
  }
  const rename = (v: string) => (s: WorkflowState) => setStepField(s, 's1', 'name', v);

  it('refuses a change to a step another workflow is changing, and records nothing', () => {
    const st = shared();
    st.edit('w1', rename('one'));
    st.edit('w2', rename('two'));
    expect(lastLine(st)).toEqual({ text: 'step extract is being changed in orders — save or undo it there first', level: 'warn' });
    expect(st.entry('w2')!.history.past).toEqual([]);
    expect(st.entry('w2')!.history.present.steps.s1!.name).toBe('extract');
    expect(st.lockedBy('step:s1', 'w2')).toBe('w1');
    expect(st.lockedBy('step:s1', 'w1')).toBeNull();
  });
  it('lets the other workflow change it once the first undoes back', () => {
    const st = shared();
    st.edit('w1', rename('one'));
    st.undo('w1');
    expect(st.lockedBy('step:s1', 'w2')).toBeNull();
    st.edit('w2', rename('two'));
    expect(st.entry('w2')!.history.present.steps.s1!.name).toBe('two');
  });
  it('refuses a redo that would change what another workflow now holds', () => {
    const st = shared();
    st.edit('w1', rename('one'));
    st.undo('w1');
    st.edit('w2', rename('two'));
    st.redo('w1');
    expect(lastLine(st)).toEqual({ text: 'step extract is being changed in billing — save or undo it there first', level: 'warn' });
    expect(st.entry('w1')!.history.present.steps.s1!.name).toBe('extract');
    expect(st.entry('w1')!.history.future).toHaveLength(1);
  });
  it('refuses editOrRefuse the same way', () => {
    const st = shared();
    st.edit('w1', rename('one'));
    st.editOrRefuse('w2', (s) => ({ state: rename('two')(s) }));
    expect(st.entry('w2')!.history.past).toEqual([]);
    expect(lastLine(st).text).toBe('step extract is being changed in orders — save or undo it there first');
  });
  it('refuses an undo that would change what another workflow now holds', () => {
    const st = shared();
    st.edit('w2', rename('two'));
    st.edit('w2', rename('extract'));
    st.edit('w1', rename('one'));
    st.undo('w2');
    expect(lastLine(st).text).toBe('step extract is being changed in orders — save or undo it there first');
    expect(st.entry('w2')!.history.past).toHaveLength(2);
  });
  it('a move of a shared step is never locked', () => {
    const st = shared();
    st.edit('w1', rename('one'));
    st.edit('w2', (s) => moveStep(s, 's1', { x: 300, y: 300 }));
    expect(st.entry('w2')!.history.past).toHaveLength(1);
  });
  it('says once that wiring a shared step changes what the other workflow runs', () => {
    const st = shared();
    st.editOrRefuse('w1', (s) => addWire(s, 's1', 't'));
    st.editOrRefuse('w1', (s) => addWire(s, 's1', 'u'));
    st.edit('w1', (s) => removeWire(s, 's1', 'u'));
    const said = st.output.lines().filter((l) => l.text.includes('is shared with'));
    expect(said.map((l) => l.text)).toEqual(['extract is shared with billing: changing its wires changes what billing runs too']);
  });
  it('names every other workflow, and says it again after undoing back', () => {
    const st = shared(true);
    st.editOrRefuse('w1', (s) => addWire(s, 's1', 't'));
    st.undo('w1');
    st.editOrRefuse('w1', (s) => addWire(s, 's1', 't'));
    const said = st.output.lines().filter((l) => l.text.includes('is shared with')).map((l) => l.text);
    expect(said).toEqual([
      'extract is shared with billing, audit: changing its wires changes what billing, audit run too',
      'extract is shared with billing, audit: changing its wires changes what billing, audit run too',
    ]);
  });
  it('never strands two workflows that both came back holding a change to it', () => {
    const draftOf = (id: 'w1' | 'w2', name: string) => {
      const session = memoryStorage();
      const st = createBoardStore(createOutputStore(null, () => '00:00:00'), session);
      st.load({ listed: true, workflows: shared().boards(), failures: [] }, []);
      st.edit(id, rename(name));
      return JSON.parse(session.getItem('acto.drafts')!) as Record<string, unknown>;
    };
    const both = memoryStorage();
    both.setItem('acto.drafts', JSON.stringify({ ...draftOf('w1', 'one'), ...draftOf('w2', 'two') }));
    const st = createBoardStore(createOutputStore(null, () => '00:00:00'), both);
    st.load({ listed: true, workflows: shared().boards(), failures: [] }, []);
    expect([st.entry('w1')!.unsaved, st.entry('w2')!.unsaved]).toEqual([true, true]);
    st.undo('w2');
    st.undo('w1');
    expect([st.entry('w1')!.unsaved, st.entry('w2')!.unsaved]).toEqual([false, false]);
  });
});

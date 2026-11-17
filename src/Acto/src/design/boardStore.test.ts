import { describe, expect, it } from 'vitest';
import type { BoardWorkflow } from '../board/loadBoard';
import { createOutputStore } from '../output/outputStore';
import { createBoardStore } from './boardStore';
import { bwFull, proc } from './fixtures';
import { canUndo } from './history';
import { addWire, moveMany, moveStep, newWorkflowState } from './state';
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

import { act, fireEvent, renderHook } from '@testing-library/react';
import type { Node, NodeChange } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import type { StudioDocument } from '../app/document';
import { loadedDocument } from '../app/fixtures';
import { LAYOUT_GAP, snap, STEP_H, STEP_W } from '../layout/geometry';
import type { Pick } from '../store/picks';
import type { DesignProps } from './designProps';
import { addCircuitWire } from '../circuit/circuit';
import { applyDraft, applyEdits } from './apply';
import { EMPTY_EDITS } from './design';
import { dropTool } from './toolDrop';
import { circuitOf, EMPTY_DRAFT, withCircuit, type Draft } from './draft';
import { carried, useBlockDrag, type Held } from './useBlockDrag';

const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }));
const designOf = (picks: Pick[], draft: Draft = EMPTY_DRAFT): DesignProps => ({ draft, picks, onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() });

function setup(doc: StudioDocument, picks: Pick[], zoom = 1, draft: Draft = EMPTY_DRAFT) {
  const design = designOf(picks, draft);
  const setHeld = vi.fn<(h: Held | null) => void>();
  const setGuides = vi.fn();
  const onSelect = vi.fn();
  const suppress = { current: false };
  const { result, rerender, unmount } = renderHook(({ on }: { on: boolean }) => useBlockDrag(doc, { current: applyDraft(doc, draft) }, on ? design : undefined, setHeld, setGuides, onSelect, suppress, () => zoom), { initialProps: { on: true } });
  const blocks = new Map<string, HTMLElement>();
  const blockOf = (id: string) => {
    if (!blocks.has(id)) {
      const el = document.createElement('div');
      el.className = 'react-flow__node';
      el.setAttribute('data-id', id);
      el.appendChild(document.createElement('span'));
      document.body.appendChild(el);
      blocks.set(id, el);
    }
    return blocks.get(id)!.firstElementChild!;
  };
  const target = document.body;
  const node = (id: string): Node => ({ id, type: 'step', position: doc.placement.steps.get(id)!, data: {} });
  // React Flow hands over the first move past its threshold, whose target may be the window
  // `press`: where the button went down; `begin`: where the pointer was when React Flow started the drag (past its threshold)
  const start = (id: string, press?: { x: number; y: number }, begin?: { x: number; y: number }) => act(() => {
    result.current.notePress(blockOf(id), press);
    result.current.onNodeDragStart!({ target: window, ...(begin ? { clientX: begin.x, clientY: begin.y } : {}) } as unknown as MouseEvent, node(id), []);
  });
  const move = (id: string, x: number, y: number) => act(() => result.current.onNodesChange!([{ type: 'position', id, position: { x, y }, dragging: true } as NodeChange]));
  const stop = (id: string) => act(() => result.current.onNodeDragStop!({ target: window } as unknown as MouseEvent, node(id), []));
  return { design, setHeld, setGuides, onSelect, suppress, start, move, stop, target, rerender, unmount };
}

describe('dragging blocks', () => {
  it('moves the picked blocks together on the 8 px grid, and the drop is one step', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const t = setup(doc, [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }, { kind: 'node', id: 'gone' }]);
    t.start('s1');
    expect(t.design.onPick).not.toHaveBeenCalled();
    t.move('s1', s1.x + 1003, s1.y + 4005);
    const preview = t.setHeld.mock.lastCall![0]!.draft;
    const dx = preview.steps.s1!.x - s1.x, dy = preview.steps.s1!.y - s1.y;
    expect(preview.steps.s2).toEqual({ x: s2.x + dx, y: s2.y + dy });
    expect(Object.keys(preview.steps).sort()).toEqual(['s1', 's2']);
    expect(dx % 8).toBe(0);
    expect(dy % 8).toBe(0);
    expect(Math.abs(dx - snap(1003))).toBeLessThanOrEqual(8);
    t.stop('s1');
    expect(t.design.onCommit).toHaveBeenCalledTimes(1);
    expect(t.design.onCommit).toHaveBeenCalledWith(preview);
    expect(t.setHeld).toHaveBeenLastCalledWith(null);
    expect(t.setGuides).toHaveBeenLastCalledWith({ lines: [], gaps: [] });
    expect(t.onSelect).not.toHaveBeenCalled();
    expect(t.suppress.current).toBe(true);
  });

  it('a block that was not picked is picked alone and moves alone; the Inspector follows after the drop', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, [{ kind: 'node', id: 's2' }]);
    t.start('s1');
    expect(t.design.onPick).toHaveBeenCalledWith([{ kind: 'node', id: 's1' }]);
    // React Flow drags every selected node too: only the grabbed block's change counts
    t.move('s1', s1.x + 1003, s1.y + 4005);
    const preview = t.setHeld.mock.lastCall![0]!.draft;
    expect(Object.keys(preview.steps)).toEqual(['s1']);
    t.stop('s1');
    expect(t.design.onCommit).toHaveBeenCalledWith(preview);
    expect(t.onSelect).toHaveBeenCalledWith({ kind: 'step', stepId: 's1' }, [{ kind: 'node', id: 's1' }]);
  });

  it('snaps onto a guide: processor middles within 8 px line up and the line is drawn', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const t = setup(doc, []);
    t.start('s1');
    // a column away from both, with s1's processor middle 8 px below s2's
    t.move('s1', s1.x + 2000 + 4, s2.y + 8);
    const preview = t.setHeld.mock.lastCall![0]!.draft;
    expect(preview.steps.s1!.y).toBe(s2.y);
    expect(t.setGuides.mock.lastCall![0].lines).toContainEqual(expect.objectContaining({ y1: s2.y + 96, y2: s2.y + 96 }));
    t.stop('s1');
  });

  it('the reach is 12 screen px at any zoom, matched before grid rounding (plan 10): 5 flow px off at 200% snaps', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const t = setup(doc, [], 2);
    t.start('s1');
    t.move('s1', s1.x + 2000 + 4, s2.y + 5);
    expect(t.setHeld.mock.lastCall![0]!.draft.steps.s1!.y).toBe(s2.y);
    t.stop('s1');
  });

  it('16 screen px off at 100% does not snap: the block is rounded to the grid', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const t = setup(doc, [], 1);
    t.start('s1');
    // 48 below s2's top: the nearest pair (s1's processor middle at 144 against s2's bottom at 160) is 16 away
    t.move('s1', s1.x + 2000 + 4, s2.y + 48);
    expect(t.setHeld.mock.lastCall![0]!.draft.steps.s1!.y).toBe(s2.y + 48);
    expect(t.setGuides.mock.lastCall![0].lines.filter((l: { y1: number; y2: number }) => l.y1 === l.y2)).toEqual([]);
    t.stop('s1');
  });

  it('a group drag never snaps to a block of the group (only blocks that stay put are references)', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const t = setup(doc, [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }]);
    t.start('s1');
    // s1's left edge 6 px right of s2's starting one, far below everything: s2 moves with s1, so nothing lines up
    t.move('s1', s2.x + 6, s1.y + 4000);
    expect(t.setHeld.mock.lastCall![0]!.draft.steps.s1!.x).toBe(snap(s2.x + 6));
    expect(t.setGuides.mock.lastCall![0].lines).toEqual([]);
    t.stop('s1');
  });

  it('the block follows the pointer from the press, not from where React Flow started the drag (no lag; Visio)', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, [], 1);
    // pressed at (100, 3000), the drag started 12 px later; React Flow then reports moves from that start: the pointer
    // 48 px on is reported as 36 (which the grid alone would round to 40)
    t.start('s1', { x: 100, y: 3000 }, { x: 112, y: 3000 });
    t.move('s1', s1.x + 2000 + 36, s1.y + 4000);
    expect(t.setHeld.mock.lastCall![0]!.draft.steps.s1!.x).toBe(s1.x + 2000 + 48);
    t.stop('s1');
  });

  it('the press offset counts in flow px at the zoom (200%: 16 screen px are 8 flow px)', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, [], 2);
    t.start('s1', { x: 100, y: 3000 }, { x: 116, y: 3000 });
    t.move('s1', s1.x + 2000 + 8, s1.y + 4000);
    expect(t.setHeld.mock.lastCall![0]!.draft.steps.s1!.x).toBe(s1.x + 2000 + 16);
    t.stop('s1');
  });

  it("while held only a copy moves (Visio, plan 10 phase 4): the held blocks, their offset and the picked wires; the drawing's own draft is untouched until the drop", async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }]);
    t.start('s1');
    t.move('s1', s1.x + 1003, s1.y + 4005);
    const held = t.setHeld.mock.lastCall![0]!;
    expect([...held.ids].sort()).toEqual(['s1', 's2']);
    expect(held.wires).toEqual(['s1->s2']);
    expect(held.dx).toBe(held.draft.steps.s1!.x - s1.x);
    expect(held.dy).toBe(held.draft.steps.s1!.y - s1.y);
    expect(t.design.onCommit).not.toHaveBeenCalled();
    t.stop('s1');
    expect(t.design.onCommit).toHaveBeenCalledWith(held.draft);
    expect(t.setHeld).toHaveBeenLastCalledWith(null);
  });

  it('Escape cancels the drag: everything goes back and no step is made', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, [{ kind: 'node', id: 's1' }]);
    t.start('s1');
    t.move('s1', s1.x + 1003, s1.y + 4005);
    let prevented = false;
    act(() => { prevented = !fireEvent.keyDown(t.target, { key: 'Escape' }); });
    expect(prevented).toBe(true);
    expect(t.setHeld).toHaveBeenLastCalledWith(null);
    expect(t.setGuides).toHaveBeenLastCalledWith({ lines: [], gaps: [] });
    t.move('s1', s1.x + 2003, s1.y + 4005);
    expect(t.setHeld).toHaveBeenLastCalledWith(null);
    t.stop('s1');
    expect(t.design.onCommit).not.toHaveBeenCalled();
    expect(t.design.onPick).not.toHaveBeenCalled();
    // the listener is gone with the drag
    expect(fireEvent.keyDown(t.target, { key: 'Escape' })).toBe(true);
  });

  it('Escape on a drag that picked its block gives back the picks it had', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, [{ kind: 'wire', id: 's1->s2' }]);
    t.start('s1');
    expect(t.design.onPick).toHaveBeenLastCalledWith([{ kind: 'node', id: 's1' }]);
    t.move('s1', s1.x + 1003, s1.y + 4005);
    act(() => { fireEvent.keyDown(t.target, { key: 'Escape' }); });
    expect(t.design.onPick).toHaveBeenLastCalledWith([{ kind: 'wire', id: 's1->s2' }]);
    t.stop('s1');
    expect(t.design.onCommit).not.toHaveBeenCalled();
    expect(t.onSelect).not.toHaveBeenCalled();
  });

  it('a canvas unmounted mid-drag leaves no Escape listener behind', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, []);
    t.start('s1');
    t.move('s1', s1.x + 1003, s1.y + 4005);
    t.unmount();
    expect(fireEvent.keyDown(t.target, { key: 'Escape' })).toBe(true);
    expect(t.design.onPick).toHaveBeenCalledTimes(1);
  });

  it('design mode ending mid-drag ends the drag: no listener, no preview, no guides', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    const t = setup(doc, []);
    t.start('s1');
    t.move('s1', s1.x + 1003, s1.y + 4005);
    act(() => t.rerender({ on: false }));
    expect(t.setHeld).toHaveBeenLastCalledWith(null);
    expect(t.setGuides).toHaveBeenLastCalledWith({ lines: [], gaps: [] });
    expect(fireEvent.keyDown(t.target, { key: 'Escape' })).toBe(true);
    expect(t.design.onPick).toHaveBeenCalledTimes(1);
    t.unmount();
  });

  it('a drag that never moved, or came back, commits nothing', async () => {
    const doc = await two();
    const t = setup(doc, [{ kind: 'node', id: 's1' }]);
    const s1 = doc.placement.steps.get('s1')!;
    t.start('s1');
    t.stop('s1');
    t.start('s1');
    t.move('s1', s1.x + 1003, s1.y + 4005);
    t.move('s1', s1.x + 2, s1.y - 3);
    expect(t.setHeld).toHaveBeenLastCalledWith(null);
    t.stop('s1');
    expect(t.design.onCommit).not.toHaveBeenCalled();
  });
});

describe('an empty step dropped on a wire splits it (Visio, plan 10 §4.6)', () => {
  /**
   * wf -> s1 -> s2 and wf -> s4 -> s5 wired; e1 and e2 (family 2) empty steps dropped from the Toolbox far away. The
   * canvas's document has them laid over it (`applyEdits`), as the canvas's own has.
   */
  async function withEmpty() {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5')],
    }));
    let n = 0;
    const ids = () => `e${++n}`;
    const a = dropTool(base, EMPTY_EDITS, EMPTY_DRAFT, { kind: 'step' }, { x: 3000, y: 3000 }, ids)!;
    const b = dropTool(base, EMPTY_EDITS, a.draft, { kind: 'step' }, { x: 3600, y: 3000 }, ids)!;
    const blocks = { ...b.draft.blocks, steps: { ...b.draft.blocks.steps, e2: { ...b.draft.blocks.steps.e2!, entryCondition: 2 } } };
    return { doc: applyEdits(base, EMPTY_EDITS, blocks), draft: { ...b.draft, blocks } };
  }
  /** The top-left corner that centres a step on the middle of the longest run of wire `id`. */
  const onRun = (doc: StudioDocument, id: string) => {
    const pts = doc.wires.find((w) => w.id === id)!.points;
    let best = { x: 0, y: 0, len: -1 };
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!, [bx, by] = pts[i]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len > best.len) best = { x: (ax + bx) / 2, y: (ay + by) / 2, len };
    }
    return { x: best.x - STEP_W / 2, y: best.y - STEP_H / 2 };
  };

  it('held over a run it is marked "insert here"; released, the wire runs into the step and on out of it, one step', async () => {
    const { doc, draft } = await withEmpty();
    const t = setup(doc, [], 1, draft);
    const p = onRun(doc, 's1->s2');
    t.start('e1');
    t.move('e1', p.x, p.y);
    const held = t.setHeld.mock.lastCall![0]!;
    expect(held.split).toMatchObject({ wire: 's1->s2', why: 'insert' });
    t.stop('e1');
    expect(t.design.onCommit).toHaveBeenCalledTimes(1);
    const after = (t.design.onCommit as ReturnType<typeof vi.fn>).mock.lastCall![0] as Draft;
    // Visio's landing (2026-10-22): one layout gap past s1, level with it, wherever released; s2 pushed one gap past it
    const s1 = doc.placement.steps.get('s1')!;
    expect(after.steps.e1).toEqual({ x: s1.x + STEP_W + LAYOUT_GAP, y: s1.y });
    expect(after.steps.s2).toEqual({ x: s1.x + 2 * (STEP_W + LAYOUT_GAP), y: doc.placement.steps.get('s2')!.y });
    const c = circuitOf(doc, after);
    expect(c['s1->s2']!.head).toEqual({ on: 'step', step: 'e1', y: null });
    const added = Object.entries(c).filter(([k]) => k.startsWith('w:'));
    expect(added.map(([, w]) => w)).toEqual([{ tail: { on: 'step', step: 'e1', y: null }, head: { on: 'step', step: 's2', y: null } }]);
    expect(after.next).toMatchObject({ s1: ['e1'], e1: ['s2'] });
  });

  it('a step with wires, or a group, never splits: it moves as before', async () => {
    const { doc, draft } = await withEmpty();
    const p = onRun(doc, 's1->s2');
    const t = setup(doc, [], 1, draft);
    t.start('s4');
    t.move('s4', p.x, p.y);
    expect(t.setHeld.mock.lastCall![0]!.split ?? null).toBeNull();
    t.stop('s4');
    const g = setup(doc, [{ kind: 'node', id: 'e1' }, { kind: 'node', id: 'e2' }], 1, draft);
    g.start('e1');
    g.move('e1', p.x, p.y);
    expect(g.setHeld.mock.lastCall![0]!.split ?? null).toBeNull();
    g.stop('e1');
  });

  it('refused (a step of another family into a net): marked in red, and the release moves nothing', async () => {
    const { doc, draft } = await withEmpty();
    // a branch off s1 -> s2's line into s5 (family 1): e2 (family 2) split into it would short the net
    const wired = withCircuit(draft, doc, addCircuitWire(circuitOf(doc, draft), 'w:b', { tail: { on: 'wire', host: 's1->s2', at: 8 }, head: { on: 'step', step: 's5', y: null } }));
    const t = setup(doc, [], 1, wired);
    const p = onRun(applyDraft(doc, wired), 'w:b');
    t.start('e2');
    t.move('e2', p.x, p.y);
    expect(t.setHeld.mock.lastCall![0]!.split).toMatchObject({ wire: 'w:b', why: 'short' });
    t.stop('e2');
    expect(t.design.onCommit).not.toHaveBeenCalled();
    // as Escape does: the step the drag picked is unpicked again, and the Inspector does not follow it
    expect(t.design.onPick).toHaveBeenLastCalledWith([]);
    expect(t.onSelect).not.toHaveBeenCalled();
  });
});

describe('the picked wires a held drag draws dashed (review 2026-10-22)', () => {
  const held = (ids: string[], wires: string[]): Held => ({ draft: EMPTY_DRAFT, ids, wires, dx: 40, dy: 80 });
  const step = (id: string) => ({ on: 'step' as const, step: id, y: null });
  it('only those whose every end goes with the held blocks: on a held step or the hub, open, or on a carried wire', () => {
    const c = {
      inside: { tail: step('s1'), head: step('s2') },
      half: { tail: step('s1'), head: step('s3') },
      hub: { tail: { on: 'hub' as const, angle: null }, head: step('s1') },
      free: { tail: step('s2'), head: { on: 'open' as const, x: 0, y: 0 } },
      branch: { tail: { on: 'wire' as const, host: 'inside', at: 0.5 }, head: step('s2') },
      stray: { tail: { on: 'wire' as const, host: 'half', at: 0.5 }, head: step('s2') },
    };
    expect(carried(c, held(['s1', 's2', 'wf'], Object.keys(c)))).toEqual(['inside', 'hub', 'free', 'branch']);
    // the hub not held: its wire stays behind; a wire not picked is never drawn
    expect(carried(c, held(['s1', 's2'], ['inside', 'hub']))).toEqual(['inside']);
  });
});

import { act, fireEvent, renderHook } from '@testing-library/react';
import type { Node, NodeChange } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import type { StudioDocument } from '../app/document';
import { loadedDocument } from '../app/fixtures';
import { snap } from '../layout/geometry';
import type { Pick } from '../store/picks';
import type { DesignProps } from './designProps';
import { EMPTY_DRAFT, type Draft } from './draft';
import { useBlockDrag } from './useBlockDrag';

const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }));
const designOf = (picks: Pick[]): DesignProps => ({ draft: EMPTY_DRAFT, picks, onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() });

function setup(doc: StudioDocument, picks: Pick[]) {
  const design = designOf(picks);
  const setPreview = vi.fn<(d: Draft | null) => void>();
  const setGuides = vi.fn();
  const onSelect = vi.fn();
  const suppress = { current: false };
  const { result } = renderHook(() => useBlockDrag(doc, { current: doc }, design, setPreview, setGuides, onSelect, suppress));
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
  const start = (id: string) => act(() => {
    result.current.notePress(blockOf(id));
    result.current.onNodeDragStart!({ target: window } as unknown as MouseEvent, node(id), []);
  });
  const move = (id: string, x: number, y: number) => act(() => result.current.onNodesChange!([{ type: 'position', id, position: { x, y }, dragging: true } as NodeChange]));
  const stop = (id: string) => act(() => result.current.onNodeDragStop!({ target: window } as unknown as MouseEvent, node(id), []));
  return { design, setPreview, setGuides, onSelect, suppress, start, move, stop, target };
}

describe('dragging blocks', () => {
  it('moves the picked blocks together on the 8 px grid, and the drop is one step', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const t = setup(doc, [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }, { kind: 'node', id: 'gone' }]);
    t.start('s1');
    expect(t.design.onPick).not.toHaveBeenCalled();
    t.move('s1', s1.x + 1003, s1.y + 4005);
    const preview = t.setPreview.mock.lastCall![0]!;
    const dx = preview.steps.s1!.x - s1.x, dy = preview.steps.s1!.y - s1.y;
    expect(preview.steps.s2).toEqual({ x: s2.x + dx, y: s2.y + dy });
    expect(Object.keys(preview.steps).sort()).toEqual(['s1', 's2']);
    expect(dx % 8).toBe(0);
    expect(dy % 8).toBe(0);
    expect(Math.abs(dx - snap(1003))).toBeLessThanOrEqual(8);
    t.stop('s1');
    expect(t.design.onCommit).toHaveBeenCalledTimes(1);
    expect(t.design.onCommit).toHaveBeenCalledWith(preview);
    expect(t.setPreview).toHaveBeenLastCalledWith(null);
    expect(t.setGuides).toHaveBeenLastCalledWith([]);
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
    const preview = t.setPreview.mock.lastCall![0]!;
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
    const preview = t.setPreview.mock.lastCall![0]!;
    expect(preview.steps.s1!.y).toBe(s2.y);
    expect(t.setGuides.mock.lastCall![0]).toContainEqual(expect.objectContaining({ y1: s2.y + 96, y2: s2.y + 96 }));
    t.stop('s1');
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
    expect(t.setPreview).toHaveBeenLastCalledWith(null);
    expect(t.setGuides).toHaveBeenLastCalledWith([]);
    t.move('s1', s1.x + 2003, s1.y + 4005);
    expect(t.setPreview).toHaveBeenLastCalledWith(null);
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

  it('a drag that never moved, or came back, commits nothing', async () => {
    const doc = await two();
    const t = setup(doc, [{ kind: 'node', id: 's1' }]);
    const s1 = doc.placement.steps.get('s1')!;
    t.start('s1');
    t.stop('s1');
    t.start('s1');
    t.move('s1', s1.x + 1003, s1.y + 4005);
    t.move('s1', s1.x + 2, s1.y - 3);
    expect(t.setPreview).toHaveBeenLastCalledWith(null);
    t.stop('s1');
    expect(t.design.onCommit).not.toHaveBeenCalled();
  });
});

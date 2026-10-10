import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { applyDesign } from './apply';
import { EMPTY_EDITS } from './design';
import { circuitOf, EMPTY_DRAFT } from './draft';
import type { DesignProps } from './designProps';
import { nudgeWires, useDesignKeys, type WireRun } from './useDesignKeys';

function Probe({ design, saved, busy }: { design: DesignProps; saved: Awaited<ReturnType<typeof loadedDocument>>; busy?: () => boolean }) {
  const onKeyDown = useDesignKeys(saved, { current: saved }, design, busy);
  return (
    <div data-testid="c" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="docbar"><button type="button">Save</button><div className="zoom"><button type="button">+</button></div></div>
      <input aria-label="field" />
    </div>
  );
}

const designOf = (over: Partial<DesignProps> = {}): DesignProps => ({ draft: EMPTY_DRAFT, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...over });

describe('design keys', () => {
  it('nudges picked blocks 8 px as one merged step', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowRight' });
    const s1 = saved.placement.steps.get('s1')!;
    expect(design.onCommit).toHaveBeenCalledWith(expect.objectContaining({ steps: { s1: { x: s1.x + 8, y: s1.y } } }), { merge: 'nudge' });
  });

  it('Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo', async () => {
    const saved = await loadedDocument();
    const design = designOf();
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(getByTestId('c'), { key: 'y', ctrlKey: true });
    fireEvent.keyDown(getByTestId('c'), { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(design.onUndo).toHaveBeenCalledTimes(1);
    expect(design.onRedo).toHaveBeenCalledTimes(2);
  });

  it('ignores picks naming blocks that no longer exist (after an undo)', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 'gone' }, { kind: 'node', id: 's1' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowDown' });
    const s1 = saved.placement.steps.get('s1')!;
    expect(design.onCommit).toHaveBeenCalledWith(expect.objectContaining({ steps: { s1: { x: s1.x, y: s1.y + 8 } } }), { merge: 'nudge' });
    const only = designOf({ picks: [{ kind: 'node', id: 'gone' }] });
    const view = render(<Probe design={only} saved={saved} />);
    fireEvent.keyDown(view.getAllByTestId('c')[1]!, { key: 'ArrowDown' });
    expect(only.onCommit).not.toHaveBeenCalled();
  });

  it('Delete removes the picked wires in one step and drops them from the picks; blocks stay', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'Delete' });
    expect(design.onCommit).toHaveBeenCalledWith(expect.objectContaining({ next: { s1: [] } }), { picks: [{ kind: 'node', id: 's1' }] });
    const blocks = designOf({ picks: [{ kind: 'node', id: 's1' }] });
    const view = render(<Probe design={blocks} saved={saved} />);
    fireEvent.keyDown(view.getAllByTestId('c')[1]!, { key: 'Delete' });
    expect(blocks.onCommit).not.toHaveBeenCalled();
  });

  it('Delete removes the picked wires and keeps the picked blocks', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }, { kind: 'node', id: 's2' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'Delete' });
    expect(design.onCommit).toHaveBeenCalledWith(expect.objectContaining({ next: { s1: [] } }), { picks: [{ kind: 'node', id: 's2' }] });
  });

  it('no key acts while a gesture runs: the drop would overwrite it', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }] });
    let busy = true;
    const { getByTestId } = render(<Probe design={design} saved={saved} busy={() => busy} />);
    for (const key of ['ArrowRight', 'Delete', 'Backspace']) fireEvent.keyDown(getByTestId('c'), { key });
    fireEvent.keyDown(getByTestId('c'), { key: 'z', ctrlKey: true });
    fireEvent.keyDown(getByTestId('c'), { key: 'y', ctrlKey: true });
    expect(design.onCommit).not.toHaveBeenCalled();
    expect(design.onUndo).not.toHaveBeenCalled();
    expect(design.onRedo).not.toHaveBeenCalled();
    busy = false; // the gesture ended: keys act again
    fireEvent.keyDown(getByTestId('c'), { key: 'z', ctrlKey: true });
    expect(design.onUndo).toHaveBeenCalledTimes(1);
  });

  it('keys aimed at the capsule toolbar and its zoom inside the canvas are not for the canvas', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }] });
    const { getByRole } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByRole('button', { name: 'Save' }), { key: 'ArrowRight' });
    fireEvent.keyDown(getByRole('button', { name: '+' }), { key: 'ArrowLeft' });
    fireEvent.keyDown(getByRole('button', { name: 'Save' }), { key: 'z', ctrlKey: true });
    expect(design.onCommit).not.toHaveBeenCalled();
    expect(design.onUndo).not.toHaveBeenCalled();
  });

  it('Ctrl+C copies, Ctrl+V pastes, Delete deletes (Cmd too, 2026-10-10); Backspace does nothing', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }], onCopy: vi.fn(), onPaste: vi.fn(), onDelete: vi.fn() });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    const c = getByTestId('c');
    fireEvent.keyDown(c, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(c, { key: 'v', metaKey: true });
    fireEvent.keyDown(c, { key: 'C', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(c, { key: 'Backspace' });
    expect([design.onCopy, design.onPaste, design.onDelete].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 0]);
    fireEvent.keyDown(c, { key: 'Delete' });
    expect(design.onDelete).toHaveBeenCalledTimes(1);
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('keys typed in a text field never copy, paste or delete', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }], onCopy: vi.fn(), onPaste: vi.fn(), onDelete: vi.fn() });
    const { getByRole } = render(<Probe design={design} saved={saved} />);
    const field = getByRole('textbox', { name: 'field' });
    fireEvent.keyDown(field, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(field, { key: 'v', ctrlKey: true });
    fireEvent.keyDown(field, { key: 'Delete' });
    expect(design.onCopy).not.toHaveBeenCalled();
    expect(design.onPaste).not.toHaveBeenCalled();
    expect(design.onDelete).not.toHaveBeenCalled();
  });

  it('an arrow nudge moves the picked wires with the picked blocks (decision 8)', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const { setBends } = await import('../circuit/circuit');
    const { circuitOf, withCircuit } = await import('./draft');
    const draft = withCircuit(EMPTY_DRAFT, saved, setBends(circuitOf(saved, EMPTY_DRAFT), 's1->s2', { xs: [400], ys: [] }));
    const design = designOf({ draft, picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowDown' });
    const committed = (design.onCommit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(committed.wires['s1->s2'].bends).toEqual({ xs: [400], ys: [] });
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowRight' });
    expect((design.onCommit as ReturnType<typeof vi.fn>).mock.calls[1]![0].wires['s1->s2'].bends).toEqual({ xs: [408], ys: [] });
  });

  it('Delete with no wire picked changes nothing (review focus 4)', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'Delete' });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('arrows with only a wire picked move it as the closed hand does: an end pulled back onto its own step holds it there, nothing committed (2026-10-10)', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    // left: its tail would go into s1, which takes it back onto its side, as a drag 8 px left does
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowLeft' });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a run of presses is one move from where it began: far down it is detached and grey, its links gone; back up it is exactly as it was', async () => {
    const saved = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    for (const id of ['s1->s2', 'wf->s1']) {
      const was = saved.wires.find((x) => x.id === id)!.points;
      let draft = EMPTY_DRAFT, run: WireRun | null = null;
      const press = (dy: number) => {
        const next = nudgeWires(saved, applyDesign(saved, draft, EMPTY_EDITS), draft, [id], 0, dy, run)!;
        draft = next.draft;
        run = next.run;
      };
      for (let i = 0; i < 40; i++) press(8);
      const w = circuitOf(saved, draft)[id]!;
      expect([w.tail.on, w.head.on]).toEqual(['open', 'open']);
      const shown = applyDesign(saved, draft, EMPTY_EDITS);
      expect(shown.wires.find((x) => x.id === id)!.points).toEqual(was.map(([x, y]) => [x, y + 320]));
      expect(shown.graph.steps.get('s1')!.nextStepIds).toEqual(id === 's1->s2' ? [] : ['s2']);
      // back up the same 40 presses: the draft it began from, the wire automatic and connected again
      for (let i = 0; i < 40; i++) press(-8);
      expect(draft).toBe(EMPTY_DRAFT);
      // one down and one up (the user's case): the same
      press(8);
      press(-8);
      expect(draft).toBe(EMPTY_DRAFT);
    }
  });

  it('a press after any other change (an undo) starts a new run from the wire as it is then', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    let draft = EMPTY_DRAFT, run: WireRun | null = null;
    for (let i = 0; i < 40; i++) ({ draft, run } = nudgeWires(saved, applyDesign(saved, draft, EMPTY_EDITS), draft, ['s1->s2'], 0, 8, run)!);
    // undone: the draft is the one the run began from, not the one it left
    const next = nudgeWires(saved, saved, EMPTY_DRAFT, ['s1->s2'], 0, 8, run)!;
    expect([next.run.dx, next.run.dy]).toEqual([0, 8]);
    expect(next.run.base).toBe(EMPTY_DRAFT);
  });

  it('with no wire or block picked an arrow does nothing', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 'gone' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowUp' });
    expect(design.onCommit).not.toHaveBeenCalled();
  });
});

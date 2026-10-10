import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { EMPTY_DRAFT } from './draft';
import type { DesignProps } from './designProps';
import { useDesignKeys, type WireKeys } from './useDesignKeys';

function Probe({ design, saved, busy }: { design: DesignProps; saved: Awaited<ReturnType<typeof loadedDocument>>; busy?: () => boolean }) {
  const onKeyDown = useDesignKeys(saved, { current: saved }, design, busy);
  return (
    <div data-testid="c" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="docbar"><button type="button">Save</button><div className="zoom"><button type="button">+</button></div></div>
      <input aria-label="field" />
    </div>
  );
}

function ProbeWith({ design, saved, wires }: { design: DesignProps; saved: Awaited<ReturnType<typeof loadedDocument>>; wires: WireKeys }) {
  const onKeyDown = useDesignKeys(saved, { current: saved }, design, () => false, wires);
  return <div data-testid="c" tabIndex={0} onKeyDown={onKeyDown} />;
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

  it('arrows with only wires picked go to the closed-hand drag (its hints, its release); any other key lets go first; Escape drops a held move (2026-10-10)', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const wires = { move: vi.fn(() => true), release: vi.fn(), cancel: vi.fn(() => true) };
    const { getByTestId } = render(<ProbeWith design={design} saved={saved} wires={wires} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowDown' });
    expect(wires.move).toHaveBeenCalledWith(['s1->s2'], 0, 8);
    expect(design.onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(getByTestId('c'), { key: 'Escape' });
    expect(wires.cancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByTestId('c'), { key: 'z', ctrlKey: true });
    expect(wires.release).toHaveBeenCalled();
    expect(design.onUndo).toHaveBeenCalledTimes(1);
    // with a block picked as well the group moves as before, the wire with it, committed at once
    const group = designOf({ picks: [{ kind: 'node', id: 's1' }, { kind: 'wire', id: 's1->s2' }] });
    const view = render(<ProbeWith design={group} saved={saved} wires={wires} />);
    fireEvent.keyDown(view.getAllByTestId('c')[1]!, { key: 'ArrowDown' });
    expect(wires.move).toHaveBeenCalledTimes(1);
    expect(group.onCommit).toHaveBeenCalledWith(expect.anything(), { merge: 'nudge' });
  });

  it('with no wire or block picked an arrow does nothing', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 'gone' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'ArrowUp' });
    expect(design.onCommit).not.toHaveBeenCalled();
  });
});

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { EMPTY_DRAFT } from './draft';
import type { DesignProps } from './designProps';
import { useDesignKeys } from './useDesignKeys';

function Probe({ design, saved, busy }: { design: DesignProps; saved: Awaited<ReturnType<typeof loadedDocument>>; busy?: () => boolean }) {
  const onKeyDown = useDesignKeys(saved, { current: saved }, design, busy);
  return (
    <div data-testid="c" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="docbar"><button type="button">Save</button><div className="zoom"><button type="button">+</button></div></div>
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

  it('Delete with no wire picked changes nothing (review focus 4)', async () => {
    const saved = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const design = designOf({ picks: [{ kind: 'node', id: 's1' }] });
    const { getByTestId } = render(<Probe design={design} saved={saved} />);
    fireEvent.keyDown(getByTestId('c'), { key: 'Delete' });
    expect(design.onCommit).not.toHaveBeenCalled();
  });
});

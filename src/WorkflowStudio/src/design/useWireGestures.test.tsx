import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { EMPTY_DRAFT, setShape } from './draft';
import type { DesignProps } from './designProps';

const fitter = createTextFitter((t) => t.length * 7);
const designOf = (over: Partial<DesignProps> = {}): DesignProps => ({ draft: EMPTY_DRAFT, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...over });
const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));

describe('wire gestures', () => {
  it('a picked wire shows its end dots and run handles', async () => {
    const doc = await two();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] })} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.design-handle.end')).toHaveLength(2);
    expect(container.querySelectorAll('.design-handle.seg').length).toBeGreaterThan(0);
  });

  it('a wire that is not picked, or a pick naming a wire that is gone, shows no handles', async () => {
    const doc = await two();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'wire', id: 'gone->s2' }] })} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.design-handle')).toHaveLength(0);
  });

  it('dragging a run makes the wire manual: one step, with its bends', async () => {
    const doc = await two();
    const onSelect = vi.fn();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={onSelect} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture')).toBe(true);
    fireEvent.pointerMove(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].routes['s1->s2']!.bends).not.toBeNull();
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture')).toBe(false);
    // a press on a handle is not a rectangle on empty canvas: the picks stay
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a press on a handle that does not move makes no step', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 101, clientY: 100, pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('Escape during a run drag cancels it: no step, and the Escape goes no further', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    const outside = vi.fn();
    document.body.addEventListener('keydown', outside);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.body.removeEventListener('keydown', outside);
    expect(outside).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture')).toBe(false);
  });

  it('a pointer cancel ends the drag with no step', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    fireEvent.pointerCancel(handle.ownerDocument, { pointerId: 1 });
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a canvas unmounted mid-drag leaves no listeners behind', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container, unmount } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 164, pointerId: 1 });
    unmount();
    const outside = vi.fn();
    document.body.addEventListener('keydown', outside);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.body.removeEventListener('keydown', outside);
    expect(outside).toHaveBeenCalled();
    fireEvent.pointerUp(document, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('pressing a picked wire\'s body drags a run; an unpicked wire\'s body does nothing', async () => {
    const doc = await two();
    const picked = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const view = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={picked} onSelect={vi.fn()} />);
    const hit = view.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!;
    fireEvent.pointerDown(hit, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 164, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(picked.onCommit).toHaveBeenCalledTimes(1);
    view.unmount();

    const none = designOf();
    const other = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={none} onSelect={vi.fn()} />);
    const hit2 = other.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!;
    fireEvent.pointerDown(hit2, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 164, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(none.onCommit).not.toHaveBeenCalled();
  });

  it('right-click → Reset route makes a manual wire automatic again; an automatic wire has it disabled', async () => {
    const doc = await two();
    const shaped = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [400], ys: [] }, landing: 96 });
    const onSelect = vi.fn();
    const design = designOf({ draft: shaped });
    const view = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={onSelect} />);
    fireEvent.contextMenu(view.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!, { clientX: 50, clientY: 50 });
    expect(onSelect).toHaveBeenCalledWith(null, [{ kind: 'wire', id: 's1->s2' }]);
    fireEvent.click(view.getByRole('menuitem', { name: /Reset route/ }));
    expect(design.onCommit).toHaveBeenCalledWith(EMPTY_DRAFT);
    expect(view.queryByRole('menuitem', { name: /Reset route/ })).toBeNull();
    view.unmount();

    const auto = designOf();
    const other = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={auto} onSelect={vi.fn()} />);
    fireEvent.contextMenu(other.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!, { clientX: 50, clientY: 50 });
    const item = other.getByRole('menuitem', { name: /Reset route/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });
});

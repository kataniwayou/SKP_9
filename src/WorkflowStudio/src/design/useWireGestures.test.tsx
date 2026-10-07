import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import type { StudioDocument } from '../app/document';
import { STEP_H, STEP_W, type Point } from '../layout/geometry';
import { EMPTY_DRAFT, addWire, reattach, setShape } from './draft';
import type { DesignProps } from './designProps';

const fitter = createTextFitter((t) => t.length * 7);
const designOf = (over: Partial<DesignProps> = {}): DesignProps => ({ draft: EMPTY_DRAFT, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...over });
const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
const three = () => loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')] }));

/** A flow point on screen, through React Flow's viewport transform (jsdom has no layout: the pane sits at 0, 0). */
function screenOf(container: HTMLElement, p: Point): { clientX: number; clientY: number } {
  const t = (container.querySelector('.react-flow__viewport') as HTMLElement).style.transform;
  const [, x, y, z] = /translate\(([-\d.e]+)px, ?([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { clientX: p.x * Number(z) + Number(x), clientY: p.y * Number(z) + Number(y) };
}
const middleOf = (doc: StudioDocument, id: string): Point => {
  const at = doc.placement.steps.get(id)!;
  return { x: at.x + STEP_W / 2, y: at.y + STEP_H / 2 };
};
const nodeClass = (container: HTMLElement, id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`)!.getAttribute('class') ?? '';
const tick = () => new Promise((r) => setTimeout(r, 0));

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

  it('a run square shows the way its run moves, and keeps that double arrow while it is dragged', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    // a manual wire with one vertical run, landing below the processor middle so the run has length
    const draft = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [(s1.x + STEP_W + s2.x) / 2], ys: [] }, landing: 128 });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const canvas = container.querySelector('.studio-canvas')!;
    const across = container.querySelector('.design-handle.seg[data-k="0"]')!;
    const upright = container.querySelector('.design-handle.seg[data-k="1"]')!;
    expect(across.getAttribute('class')).toContain('seg h');
    expect(upright.getAttribute('class')).toContain('seg v');

    fireEvent.pointerDown(upright, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-ew')).toBe(true);
    fireEvent.pointerUp(upright.ownerDocument, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-ew')).toBe(false);

    fireEvent.pointerDown(across, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-ns')).toBe(true);
    fireEvent.pointerUp(across.ownerDocument, { clientX: 100, clientY: 100, pointerId: 1 });

    // an end drag keeps the closed hand: no double arrow left over from the run drag
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture')).toBe(true);
    expect(canvas.className).not.toMatch(/gesture-(ns|ew)/);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
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
  it('a step offers a connection point only in design mode', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} />);
    expect(container.querySelector('.nx-port')).toBeNull();
    rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.nx-port').length).toBe(2); // the hub's and the step's
  });

  it('dragging the arrow head onto another step re-targets the wire: green outline, a ghost, one step, the new wire picked', async () => {
    const doc = await three();
    const onSelect = vi.fn();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={onSelect} />);
    const head = container.querySelector('.design-handle.end[data-end="target"]')!;
    fireEvent.pointerDown(head, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(nodeClass(container, 's3')).toContain('drop-ok');
    expect(container.querySelector('.design-ghost')).not.toBeNull();
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    expect(design.onCommit).toHaveBeenCalledWith(reattach(EMPTY_DRAFT, doc, 's1->s2', 'target', 's3'), { picks: [{ kind: 'wire', id: 's1->s3' }] });
    expect(container.querySelector('.design-ghost')).toBeNull();
    expect(nodeClass(container, 's3')).not.toContain('drop-');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a refused drop (a cycle) outlines red and snaps back; so do its own block and empty canvas', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const head = () => container.querySelector('.design-handle.end[data-end="target"]')!;
    // the head of s2->s3 on s1 would make s1 -> s2 -> s1
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(nodeClass(container, 's1')).toContain('drop-no');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    // back on its own block: no outline, no step
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(nodeClass(container, 's3')).not.toContain('drop-');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    // empty canvas
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('dragging the start dot onto the hub makes the wire an entry wire', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const dot = container.querySelector('.design-handle.end[data-end="source"]')!;
    const hub = { x: doc.placement.sphere.cx, y: doc.placement.sphere.cy };
    fireEvent.pointerDown(dot, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, hub), pointerId: 1 });
    expect(nodeClass(container, 'wf')).toContain('drop-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, hub), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledWith(reattach(EMPTY_DRAFT, doc, 's2->s3', 'source', 'wf'), { picks: [{ kind: 'wire', id: 'wf->s3' }] });
  });

  it('dragging from a step\'s connection point to a step adds a wire; onto nothing adds none', async () => {
    const doc = await three();
    const onSelect = vi.fn();
    const design = designOf();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={onSelect} />);
    const port = container.querySelector('.react-flow__node[data-id="s1"] .nx-port')!;
    fireEvent.pointerDown(port, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture')).toBe(true);
    fireEvent.pointerMove(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    expect(container.ownerDocument.querySelector('.design-band')).toBeNull();
    fireEvent.pointerUp(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
    fireEvent.pointerDown(port, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(nodeClass(container, 's3')).toContain('drop-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledWith(addWire(EMPTY_DRAFT, doc, 's1', 's3'), { picks: [{ kind: 'wire', id: 's1->s3' }] });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Escape during an end drag puts everything back, and the release that follows keeps the picks', async () => {
    const doc = await three();
    const onSelect = vi.fn();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={onSelect} />);
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(container.querySelector('.design-ghost')).toBeNull();
    expect(nodeClass(container, 's3')).not.toContain('drop-');
    // the button is still down a while after the Escape; its release ends on the pane
    await tick();
    fireEvent.pointerUp(document, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.click(container.querySelector('.react-flow__pane')!);
    expect(design.onCommit).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    // and the next click is an ordinary one again
    await tick();
    fireEvent.click(container.querySelector('.react-flow__pane')!);
    expect(onSelect).toHaveBeenCalledWith(null, []);
  });

  it('the run squares of a manual wire follow the drag', async () => {
    const doc = await two();
    const shaped = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [528, 560], ys: [400] }, landing: null });
    const design = designOf({ draft: shaped, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const run = () => container.querySelector('.design-handle.seg[data-k="1"]')!;
    expect(run().getAttribute('x')).toBe('524');
    const y = Number(run().getAttribute('y')) + 4;
    // the zoom is small in jsdom: the press is far off so the move counts as a drag
    fireEvent.pointerDown(run(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: 544, y }), pointerId: 1 });
    expect(run().getAttribute('x')).toBe('540');
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });
});

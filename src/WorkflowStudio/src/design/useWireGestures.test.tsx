import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import type { StudioDocument } from '../app/document';
import { clampLanding, LANDING_MAX, LANDING_MIN, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { EMPTY_DRAFT, addWire, reattach, setShape } from './draft';
import { endsOf, pointsOfShape } from '../layout/shape';
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
const pointsOfD = (d: string): [number, number][] => [...d.matchAll(/[ML]([-\d.e]+) ([-\d.e]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const rightAngled = (pts: readonly (readonly [number, number])[]) => pts.length >= 2 && pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
/** A wire as drawn: its trace's points. */
const wirePath = (container: HTMLElement, id: string) => pointsOfD(container.querySelector(`[data-testid="rf__edge-${id}"] path.w`)!.getAttribute('d')!);
/** 100 % zoom: jsdom's fit is so small that a short run's square would hide under its end dots (as it does on screen). */
const AT_100 = { x: 0, y: 0, zoom: 1, followFit: false };

describe('wire gestures', () => {
  it('a picked wire shows its end dots and run handles', async () => {
    const doc = await two();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] })} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.design-handle.end')).toHaveLength(2);
    expect(container.querySelectorAll('.design-handle.seg').length).toBeGreaterThan(0);
    // only the end squares and the run squares: no mark on a bend
    expect(container.querySelectorAll('.design-handle:not(.end):not(.seg)')).toHaveLength(0);
  });

  it('a wire that is not picked, or a pick naming a wire that is gone, shows no handles', async () => {
    const doc = await two();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={designOf({ picks: [{ kind: 'wire', id: 'gone->s2' }] })} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.design-handle')).toHaveLength(0);
  });

  it('dragging a run makes the wire manual: one step, with its bends', async () => {
    const doc = await two();
    const onSelect = vi.fn();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
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

  it('a run dragged onto a step is pushed off it: the wire goes around the step, never through it', async () => {
    const doc = await three();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    // s1 -> s2 drops below both steps and comes back up just before s2
    const draft = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [s1.x + STEP_W + 16, s2.x - 16], ys: [s1.y + STEP_H + 48] }, landing: null });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const ends = endsOf(wirePath(container, 's1->s2'));
    // the run that comes back up, dragged into the middle of s2
    const handle = container.querySelector('.design-handle.seg[data-k="3"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's2')), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's2')), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    const bends = vi.mocked(design.onCommit).mock.calls[0]![0].routes['s1->s2']!.bends!;
    const pts = pointsOfShape(ends, bends);
    expect(rightAngled(pts)).toBe(true);
    // no run lies inside s2 (its landing touches the border, from outside)
    const into = pts.some((a, i) => {
      const c = pts[i + 1];
      return c !== undefined && Math.max(a[0], c[0]) > s2.x && Math.min(a[0], c[0]) < s2.x + STEP_W && Math.max(a[1], c[1]) > s2.y && Math.min(a[1], c[1]) < s2.y + STEP_H;
    });
    expect(into).toBe(false);
  });

  it('a run square shows the way its run moves, and keeps that double arrow while it is dragged', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    // a manual wire with one vertical run, landing below the processor middle so the run has length
    const draft = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [(s1.x + STEP_W + s2.x) / 2], ys: [] }, landing: 128 });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
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

    // an end drag shows the sideways double arrow (an end leaves its block sideways), not the run's up-down one
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-ew')).toBe(true);
    expect(canvas.classList.contains('gesture-ns')).toBe(false);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-ew')).toBe(false);
  });

  it('a press on the branch of a joined wire never drags a run; its own line still does (plan 7)', async () => {
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4', { entryCondition: 2 })],
    }));
    const draft = setShape(EMPTY_DRAFT, 's3->s4', { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const edge = container.querySelector('[data-testid="rf__edge-s3->s4"]')!;
    const branch = edge.querySelector('path.nx-hit.branch')!;
    expect(branch).not.toBeNull();
    const at = screenOf(container, middleOf(doc, 's3'));
    fireEvent.pointerDown(branch, { button: 0, ...at, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: at.clientX + 40, clientY: at.clientY, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: at.clientX + 40, clientY: at.clientY, pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();

    const own = edge.querySelector('path.nx-hit:not(.branch)')!;
    fireEvent.pointerDown(own, { button: 0, ...at, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: at.clientX + 40, clientY: at.clientY + 40, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: at.clientX + 40, clientY: at.clientY + 40, pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
  });

  it('handles, outline and ghost keep their size on screen whatever the zoom', async () => {
    const doc = await two();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] })} onSelect={vi.fn()} />);
    const zoom = Number(/scale\(([-\d.e]+)\)/.exec((container.querySelector('.react-flow__viewport') as HTMLElement).style.transform)![1]);
    const end = container.querySelector('.design-handle.end')!;
    expect(end.tagName).toBe('rect');
    expect(Number(end.getAttribute('width')) * zoom).toBeCloseTo(9);
    const square = container.querySelector('.design-handle.seg')!;
    expect(Number(square.getAttribute('width')) * zoom).toBeCloseTo(9);
    // the node outline (CSS) scales by the canvas's --inv
    expect(Number((container.querySelector('.studio-canvas') as HTMLElement).style.getPropertyValue('--inv')) * zoom).toBeCloseTo(1);
  });

  it('a run too short on screen to keep its square clear of an end square shows no square (the end wins)', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    // the first run is one grid step long: at any zoom below 2 its square would sit under the start dot
    const draft = setShape(EMPTY_DRAFT, 's1->s2', { bends: { xs: [s1.x + STEP_W + 8], ys: [] }, landing: 128 });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] })} onSelect={vi.fn()} />);
    expect(container.querySelector('.design-handle.seg[data-k="0"]')).toBeNull();
    expect(container.querySelector('.design-handle.seg[data-k="1"]')).not.toBeNull();
  });

  it('a press on a handle that does not move makes no step', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 101, clientY: 100, pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('Escape during a run drag cancels it: no step, and the Escape goes no further', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
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
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
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
    const { container, unmount } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
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
    const view = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={picked} onSelect={vi.fn()} />);
    const hit = view.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!;
    fireEvent.pointerDown(hit, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 100, clientY: 164, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 100, clientY: 164, pointerId: 1 });
    expect(picked.onCommit).toHaveBeenCalledTimes(1);
    view.unmount();

    const none = designOf();
    const other = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={none} onSelect={vi.fn()} />);
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
    const view = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
    fireEvent.contextMenu(view.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!, { clientX: 50, clientY: 50 });
    expect(onSelect).toHaveBeenCalledWith(null, [{ kind: 'wire', id: 's1->s2' }]);
    fireEvent.click(view.getByRole('menuitem', { name: /Reset route/ }));
    expect(design.onCommit).toHaveBeenCalledWith(EMPTY_DRAFT);
    expect(view.queryByRole('menuitem', { name: /Reset route/ })).toBeNull();
    view.unmount();

    const auto = designOf();
    const other = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={auto} onSelect={vi.fn()} />);
    fireEvent.contextMenu(other.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!, { clientX: 50, clientY: 50 });
    const item = other.getByRole('menuitem', { name: /Reset route/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });
  it('a step offers a connection point only in design mode', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} />);
    expect(container.querySelector('.nx-port')).toBeNull();
    rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={designOf()} onSelect={vi.fn()} />);
    expect(container.querySelectorAll('.nx-port').length).toBe(2); // the hub's and the step's
  });

  it('dragging the arrow head onto another step re-targets the wire: green outline, the wire follows right-angled, one step, the new wire picked', async () => {
    const doc = await three();
    const onSelect = vi.fn();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
    const head = container.querySelector('.design-handle.end[data-end="target"]')!;
    fireEvent.pointerDown(head, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    const before = wirePath(container, 's1->s2');
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(nodeClass(container, 's3')).toContain('drop-ok');
    // no sloped ghost line: the wire itself runs to the pointer, every run level or upright
    expect(container.querySelector('.design-ghost')).toBeNull();
    const moving = wirePath(container, 's1->s2');
    expect(moving).not.toEqual(before);
    expect(rightAngled(moving)).toBe(true);
    // over a step, the arrow lands on its border (its landing band), never inside it
    const s3 = doc.placement.steps.get('s3')!;
    const landing = clampLanding(middleOf(doc, 's3').y - s3.y);
    expect(moving[moving.length - 1]).toEqual([s3.x, s3.y + landing]);
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    // the arrow stays where it was dropped
    expect(design.onCommit).toHaveBeenCalledWith(setShape(reattach(EMPTY_DRAFT, doc, 's1->s2', 'target', 's3'), 's1->s3', { bends: null, landing }), { picks: [{ kind: 'wire', id: 's1->s3' }] });
    expect(container.querySelector('.design-ghost')).toBeNull();
    expect(nodeClass(container, 's3')).not.toContain('drop-');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a refused drop (a cycle) outlines red and snaps back; so does empty canvas', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const head = () => container.querySelector('.design-handle.end[data-end="target"]')!;
    // the head of s2->s3 on s1 would make s1 -> s2 -> s1
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(nodeClass(container, 's1')).toContain('drop-no');
    // the reason is said next to the pointer, at a size that does not shrink with the zoom
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('would make a loop');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')).toBeNull();
    // empty canvas
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('an arrow dropped back on its own step moves its contact point there; at the same height, no step', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const head = () => container.querySelector('.design-handle.end[data-end="target"]')!;
    const s3 = doc.placement.steps.get('s3')!;
    const now = endsOf(wirePath(container, 's2->s3')).ty - s3.y;
    // the same height: nothing changes
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: s3.x + 40, y: s3.y + now }), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('move contact here');
    fireEvent.pointerUp(document, { ...screenOf(container, { x: s3.x + 40, y: s3.y + now }), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
    // another height in the landing band
    const to = now === LANDING_MIN ? LANDING_MAX : LANDING_MIN;
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: s3.x + 40, y: s3.y + to }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: s3.x + 40, y: s3.y + to }), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledWith(setShape(EMPTY_DRAFT, 's2->s3', { bends: null, landing: to }), { picks: [{ kind: 'wire', id: 's2->s3' }] });
  });

  it('dragging the start dot onto the hub makes the wire an entry wire', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
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
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
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
    expect(rightAngled(pointsOfD(container.querySelector('.design-ghost')!.getAttribute('d')!))).toBe(true);
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledWith(addWire(EMPTY_DRAFT, doc, 's1', 's3'), { picks: [{ kind: 'wire', id: 's1->s3' }] });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Escape during an end drag puts everything back, and the release that follows keeps the picks', async () => {
    const doc = await three();
    const onSelect = vi.fn();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
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
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const run = () => container.querySelector('.design-handle.seg[data-k="1"]')!;
    // a square's centre (its size is in screen pixels, so its corner moves with the zoom)
    const centre = (axis: 'x' | 'y', size: 'width' | 'height') => Number(run().getAttribute(axis)) + Number(run().getAttribute(size)) / 2;
    expect(centre('x', 'width')).toBeCloseTo(528);
    const y = centre('y', 'height');
    // the zoom is small in jsdom: the press is far off so the move counts as a drag
    fireEvent.pointerDown(run(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: 544, y }), pointerId: 1 });
    expect(centre('x', 'width')).toBeCloseTo(544);
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });
});

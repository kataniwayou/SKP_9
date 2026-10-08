import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cacheDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import type { StudioDocument } from '../app/document';
import { CACHE_H, CACHE_W, clampLanding, LANDING_MAX, LANDING_MIN, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { EMPTY_DRAFT, addLoose, addWire, attachLoose, moveBlocks, reattach, resetRoute, resourceLoose, setShape } from './draft';
import { endsOf, pointsOfShape } from '../layout/shape';
import { simplify } from '../layout/router';
import type { DesignProps } from './designProps';
import { applyDraft } from './apply';

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

  it('a drop that closes a loop outlines green and re-attaches; empty canvas makes the wire loose (plan 8 §5)', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const head = () => container.querySelector('.design-handle.end[data-end="target"]')!;
    // the head of s2->s3 on s1 makes s1 -> s2 -> s1: cycles are allowed
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(nodeClass(container, 's1')).toContain('drop-ok');
    // the label is said next to the pointer, at a size that does not shrink with the zoom
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('re-attach here');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')).toBeNull();
    // empty canvas
    fireEvent.pointerDown(head(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('loose wire');
    fireEvent.pointerUp(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(2);
    const loose = vi.mocked(design.onCommit).mock.calls[1]![0];
    expect(loose.next['s2']).toEqual([]);
    expect(Object.values(loose.loose)).toEqual([{ source: 's2', end: { x: -4000, y: -4000 } }]);
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

  it('dragging from a step\'s connection point to a step adds a wire; onto nothing adds a loose wire', async () => {
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
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    expect(Object.values(vi.mocked(design.onCommit).mock.calls[0]![0].loose)).toEqual([{ source: 's1', end: { x: -4000, y: -4000 } }]);
    fireEvent.pointerDown(port, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(nodeClass(container, 's3')).toContain('drop-ok');
    expect(rightAngled(pointsOfD(container.querySelector('.design-ghost')!.getAttribute('d')!))).toBe(true);
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
    expect(design.onCommit).toHaveBeenLastCalledWith(addWire(EMPTY_DRAFT, doc, 's1', 's3'), { picks: [{ kind: 'wire', id: 's1->s3' }] });
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

  const joinable = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3', { nextStepIds: ['s4', 's5'] }), stepDto('s4', { entryCondition: 2 }), stepDto('s5', { entryCondition: 1 })],
  }));
  /** A point on a wire's first long horizontal run, in flow coordinates. */
  const onLine = (doc: StudioDocument, id: string): Point => {
    const pts = doc.wires.find((w) => w.id === id)!.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
      if (ay === by && Math.abs(bx - ax) >= 48) return { x: (ax + bx) / 2, y: ay };
    }
    throw new Error(`no horizontal run on ${id}`);
  };

  it('dropping an arrow on a same-colour line joins it: green halo, "join here", one step, the contact written', async () => {
    const doc = await joinable();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const target = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('join here');
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] .wire')!.getAttribute('class')).toContain('halo-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    const shape = vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!;
    expect(shape.contact!.host).toBe('s1->s2');
    expect(shape.bends).toBeNull();
    // drawing only: the wiring is untouched
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].next).toEqual({});
  });

  it('another colour says "loose wire" with a grey halo, and the release leaves the wire loose there (plan 8 §5)', async () => {
    const doc = await joinable();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s5' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const target = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s5"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('loose wire');
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] .wire')!.getAttribute('class')).toContain('halo-loose');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    const draft = vi.mocked(design.onCommit).mock.calls[0]![0];
    expect(draft.next['s3']).toEqual(['s4']);
    expect(Object.values(draft.loose).map((l) => l.source)).toEqual(['s3']);
  });

  it('a start square over a line says "start stays on a block"; a new wire ignores lines and says "loose wire"', async () => {
    const doc = await joinable();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const target = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('start stays on a block');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
    fireEvent.pointerDown(container.querySelector('.react-flow__node[data-id="s3"] .nx-port')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, target), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('loose wire');
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] .wire')!.getAttribute('class')).not.toContain('halo-');
    fireEvent.pointerUp(document, { ...screenOf(container, target), pointerId: 1 });
    expect(Object.values(vi.mocked(design.onCommit).mock.calls[0]![0].loose).map((l) => l.source)).toEqual(['s3']);
  });

  it('the tail over its own step says "starts here" in green, and dropping there changes nothing', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('starts here');
    expect(nodeClass(container, 's1')).toContain('drop-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('an end reaching a step border from outside is already over it: the head 5 px left of a step re-attaches there', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const s3 = doc.placement.steps.get('s3')!;
    const near = { x: s3.x - 5, y: s3.y + 96 };
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, near), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('re-attach here');
    expect(nodeClass(container, 's3')).toContain('drop-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, near), pointerId: 1 });
    expect(vi.mocked(design.onCommit).mock.calls[0]![1]).toEqual({ picks: [{ kind: 'wire', id: 's1->s3' }] });
  });

  it('a head dragged over a cache says "loose wire": the cache outlined grey, the release leaves the wire loose there (plan 8 §5)', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')], caches: [cacheDto('c1')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const c = doc.placement.caches.get('c1')!;
    const over = { x: c.x + CACHE_W / 2, y: c.y + CACHE_H / 2 };
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, over), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('loose wire');
    expect(nodeClass(container, 'cache:c1')).toContain('drop-loose');
    fireEvent.pointerUp(document, { ...screenOf(container, over), pointerId: 1 });
    const draft = vi.mocked(design.onCommit).mock.calls[0]![0];
    expect(draft.next['s1']).toEqual([]);
    expect(Object.values(draft.loose).map((l) => l.source)).toEqual(['s1']);
  });

  const joined = () => setShape(EMPTY_DRAFT, 's3->s4', { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } });

  it('a picked joined wire shows a start square, a contact square with the four-way cursor, an arrow square, and no square on its last run', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const g = container.querySelector('.design-wire[data-wire="s3->s4"]')!;
    expect(g.querySelector('.design-handle.end[data-end="source"]')).not.toBeNull();
    expect(g.querySelector('.design-handle.end.contact[data-end="target"]')).not.toBeNull();
    expect(g.querySelector('.design-handle.end[data-end="arrow"]')).not.toBeNull();
    fireEvent.pointerDown(g.querySelector('.design-handle.contact')!, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture-move')).toBe(true);
    fireEvent.pointerUp(document, { clientX: 0, clientY: 0, pointerId: 1 });
  });

  it('the contact square slides along its host, and dropped on its own step makes the wire plain', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const contact = () => container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.contact')!;
    const along = onLine(doc, 's1->s2');
    fireEvent.pointerDown(contact(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, along), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, along), pointerId: 1 });
    const slid = vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!;
    expect(slid.contact!.host).toBe('s1->s2');
    expect(slid.contact!.at).not.toBe(40);
    fireEvent.pointerDown(contact(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's4')), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's4')), pointerId: 1 });
    const plain = vi.mocked(design.onCommit).mock.calls[1]![0].routes['s3->s4'];
    expect(plain?.contact ?? null).toBeNull();
  });

  it("a run drag on a joined wire's own line keeps its contact", async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const run = container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.seg')!;
    fireEvent.pointerDown(run, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 140, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 140, clientY: 140, pointerId: 1 });
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!.contact).toEqual({ host: 's1->s2', at: 40 });
  });

  it('a dragged contact square draws the wire plain to the pointer (loose on empty canvas); the arrow square drags the branch only, its runs staying, and re-attaches keeping the contact', async () => {
    const doc = await joinable();
    // s2 and s4 spread right: the split lies well past the contact, two dots
    const draft = moveBlocks(joined(), doc, new Map([['s2', { x: 1152, y: 32 }], ['s4', { x: 864, y: 480 }]]));
    const shownDoc = applyDraft(doc, draft);
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const edge = () => container.querySelector('[data-testid="rf__edge-s3->s4"]')!;
    const g = () => container.querySelector('.design-wire[data-wire="s3->s4"]')!;
    fireEvent.pointerDown(g().querySelector('.design-handle.contact')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    expect(edge().querySelectorAll('circle.nx-joint')).toHaveLength(0);
    expect(edge().querySelector('path.w.branch')).toBeNull();
    fireEvent.pointerUp(document, { ...screenOf(container, { x: -4000, y: -4000 }), pointerId: 1 });
    // released on empty canvas the wire is loose there (plan 8 §5)
    expect(Object.values(vi.mocked(design.onCommit).mock.calls[0]![0].loose)).toEqual([{ source: 's3', end: { x: -4000, y: -4000 } }]);
    const runs = () => [...g().querySelectorAll('.design-handle.seg')].map((r) => `${r.getAttribute('x')},${r.getAttribute('y')}`);
    const before = runs();
    fireEvent.pointerDown(g().querySelector('.design-handle.end[data-end="arrow"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(shownDoc, 's2')), pointerId: 1 });
    expect(runs()).toEqual(before);
    expect(edge().querySelectorAll('circle.nx-joint')).toHaveLength(2);
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(shownDoc, 's2')), pointerId: 1 });
    const [next, picks] = vi.mocked(design.onCommit).mock.calls[1]!;
    expect(picks).toEqual({ picks: [{ kind: 'wire', id: 's3->s2' }] });
    expect(next.routes['s3->s2']!.contact).toEqual({ host: 's1->s2', at: 40 });
  });

  it('the arrow square dropped back on its own step at the same height makes no step; at another height, one step with the new landing and the contact kept', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const arrow = () => container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.end[data-end="arrow"]')!;
    const s4 = doc.placement.steps.get('s4')!;
    const branch = applyDraft(doc, joined()).wires.find((w) => w.id === 's3->s4')!.joint!.branch;
    const now = branch[branch.length - 1]![1] - s4.y;
    fireEvent.pointerDown(arrow(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: s4.x + 40, y: s4.y + now }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: s4.x + 40, y: s4.y + now }), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
    const to = now === LANDING_MIN ? LANDING_MAX : LANDING_MIN;
    fireEvent.pointerDown(arrow(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: s4.x + 40, y: s4.y + to }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: s4.x + 40, y: s4.y + to }), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    const shape = vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!;
    expect(shape.landing).toBe(to);
    expect(shape.contact).toEqual({ host: 's1->s2', at: 40 });
  });

  it('a run drag on a joined wire with a slid landing is committed against its contact, not its landing height', async () => {
    const doc = await joinable();
    const draft = setShape(EMPTY_DRAFT, 's3->s4', { bends: null, landing: 40, contact: { host: 's1->s2', at: 40 } });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const joint = applyDraft(doc, draft).wires.find((w) => w.id === 's3->s4')!.joint!;
    // the own line's one vertical run, from its start's height up to the contact
    const climb = joint.own[1]![0];
    // the first run dragged level with the target's slid landing: a jog, then the climb to the contact stays
    const level = doc.placement.steps.get('s4')!.y + 40;
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.seg[data-k="0"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: joint.ownEnds.sx + 8, y: level }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: joint.ownEnds.sx + 8, y: level }), pointerId: 1 });
    const shape = vi.mocked(design.onCommit).mock.calls[0]![0].routes['s3->s4']!;
    expect(shape.bends!.ys).toEqual([level]);
    expect(shape.bends!.xs).toHaveLength(2);
    expect(shape.bends!.xs[1]).toBe(climb);
    expect(shape.contact).toEqual({ host: 's1->s2', at: 40 });
    expect(shape.landing).toBe(40);
  });

  it('Reset route removes the junction', async () => {
    const doc = await joinable();
    const design = designOf({ draft: joined(), picks: [{ kind: 'wire', id: 's3->s4' }] });
    render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    expect(resetRoute(joined(), 's3->s4').routes['s3->s4']).toBeUndefined();
  });

  const twoAndOne = () => loadedDocument(
    graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')], layout: { parked: ['s3'] } }),
    [stepDto('s3')],
  );
  const EMPTY_AT = { x: 1104, y: 704 };
  const commits = (design: ReturnType<typeof designOf>) => vi.mocked(design.onCommit).mock.calls;

  it('a new wire released on empty canvas becomes a loose wire from its source, told "loose wire" in grey (plan 8 §5)', async () => {
    const doc = await twoAndOne();
    const design = designOf();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.react-flow__node[data-id="s2"] .nx-port')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const label = container.querySelector('.design-drop-label')!;
    expect(label.textContent).toBe('loose wire');
    expect(label.getAttribute('class')).toContain('loose');
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const [draft, options] = commits(design)[0]!;
    const [id, loose] = Object.entries(draft.loose)[0]!;
    expect(loose).toEqual({ source: 's2', end: EMPTY_AT });
    expect(draft.next).toEqual({});
    expect(options).toEqual({ picks: [{ kind: 'wire', id: `loose:${id}` }] });
  });

  it('a picked wire\'s head released on empty canvas leaves the wiring and stays drawn as a loose wire', async () => {
    const doc = await twoAndOne();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s1->s2"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const [draft] = commits(design)[0]!;
    expect(draft.next['s1']).toEqual([]);
    expect(Object.values(draft.loose)).toEqual([{ source: 's1', end: EMPTY_AT }]);
  });

  it('a head dropped where it closes a loop re-attaches the wire: cycles are allowed (plan 8 §5)', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3')] }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s2->s3"] .design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('re-attach here');
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's1')), pointerId: 1 });
    expect(commits(design)[0]![0].next['s2']).toEqual(['s1']);
  });

  it('a tail released on empty canvas snaps back: a loose wire always keeps its source', async () => {
    const doc = await twoAndOne();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s1->s2"] .design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')).toBeNull();
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a loose wire\'s open end: onto a step it wires, elsewhere it moves, on its own source it snaps back', async () => {
    const doc = await twoAndOne();
    const design = designOf({ draft: addLoose(EMPTY_DRAFT, 'l1', 's1', EMPTY_AT) });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const openEnd = () => container.querySelector('[data-testid="rf__edge-loose:l1"] .nx-open-hit')!;
    const drag = (to: { x: number; y: number }) => {
      fireEvent.pointerDown(openEnd(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
      fireEvent.pointerMove(document, { ...screenOf(container, to), pointerId: 1 });
      const label = container.querySelector('.design-drop-label')?.textContent ?? null;
      fireEvent.pointerUp(document, { ...screenOf(container, to), pointerId: 1 });
      return label;
    };
    expect(drag(middleOf(doc, 's3'))).toBe('connect here');
    expect(commits(design)[0]![0].next['s1']).toEqual(['s2', 's3']);
    expect(commits(design)[0]![0].loose).toEqual({});

    expect(drag({ x: 1200, y: 760 })).toBe('loose wire');
    expect(commits(design)[1]![0].loose['l1']).toEqual({ source: 's1', end: { x: 1200, y: 760 } });

    expect(drag(middleOf(doc, 's1'))).toBe('same step');
    expect(commits(design)).toHaveLength(2);

    // released where its end already is: no step
    drag(EMPTY_AT);
    expect(commits(design)).toHaveLength(2);
  });

  it('a loose wire from the hub dropped back on the hub says "same step" and snaps back (decision 11)', async () => {
    const doc = await twoAndOne();
    const design = designOf({ draft: addLoose(EMPTY_DRAFT, 'l1', 'wf', EMPTY_AT) });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const hub = { x: doc.placement.sphere.cx, y: doc.placement.sphere.cy };
    fireEvent.pointerDown(container.querySelector('[data-testid="rf__edge-loose:l1"] .nx-open-hit')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, hub), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('same step');
    expect(nodeClass(container, 'wf')).toContain('drop-no');
    fireEvent.pointerUp(document, { ...screenOf(container, hub), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('Delete removes a picked loose wire', async () => {
    const doc = await twoAndOne();
    const design = designOf({ draft: addLoose(EMPTY_DRAFT, 'l1', 's1', EMPTY_AT), picks: [{ kind: 'wire', id: 'loose:l1' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.keyDown(container.querySelector('.studio-canvas')!, { key: 'Delete' });
    expect(commits(design)[0]![0].loose).toEqual({});
  });

  it('Delete on a loose pick that is gone (after an undo) makes no step', async () => {
    const doc = await twoAndOne();
    const design = designOf({ picks: [{ kind: 'wire', id: 'loose:gone' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    fireEvent.keyDown(container.querySelector('.studio-canvas')!, { key: 'Delete' });
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  describe('a picked loose wire has the squares of a connected wire', () => {
    const picked = (draft = addLoose(EMPTY_DRAFT, 'l1', 's1', EMPTY_AT)) => designOf({ draft, picks: [{ kind: 'wire', id: 'loose:l1' }] });
    const squares = (container: HTMLElement) => container.querySelector('.design-wire[data-wire="loose:l1"]');

    it('a start square, an open-end square and a square in the middle of each run', async () => {
      const doc = await twoAndOne();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={picked()} onSelect={vi.fn()} />);
      const g = squares(container)!;
      expect(g).not.toBeNull();
      expect(g.querySelector('.design-handle.end[data-end="source"]')).not.toBeNull();
      expect(g.querySelector('.design-handle.end[data-end="target"]')).not.toBeNull();
      expect(g.querySelectorAll('.design-handle.seg').length).toBeGreaterThan(0);
    });

    it('a run square moves its run, and the loose wire keeps that shape: drawn by its bends, its source and end unchanged', async () => {
      const doc = await twoAndOne();
      const design = picked();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
      const upright = squares(container)!.querySelector('.design-handle.seg.v')!;
      const x = Number(upright.getAttribute('x')) + 64, y = Number(upright.getAttribute('y'));
      fireEvent.pointerDown(upright, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
      expect(container.querySelector('.studio-canvas')!.classList.contains('gesture-ew')).toBe(true);
      fireEvent.pointerMove(document, { ...screenOf(container, { x, y }), pointerId: 1 });
      fireEvent.pointerUp(document, { ...screenOf(container, { x, y }), pointerId: 1 });
      expect(commits(design)).toHaveLength(1);
      const [draft, options] = commits(design)[0]!;
      const l = draft.loose['l1']!;
      expect(l.source).toBe('s1');
      expect(l.end).toEqual(EMPTY_AT);
      expect(l.bends).toBeDefined();
      expect(options).toEqual({ picks: [{ kind: 'wire', id: 'loose:l1' }] });
      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={{ ...design, draft }} onSelect={vi.fn()} />);
      const drawn = wirePath(container, 'loose:l1');
      expect(drawn).toEqual(simplify(pointsOfShape(endsOf(drawn), l.bends!)));
      expect(rightAngled(drawn)).toBe(true);
    });

    it("pressing a picked loose wire's body drags its nearest run", async () => {
      const doc = await twoAndOne();
      const design = picked();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
      const pts = wirePath(container, 'loose:l1');
      // the middle of the second run (the first vertical)
      const at = { x: (pts[1]![0] + pts[2]![0]) / 2, y: (pts[1]![1] + pts[2]![1]) / 2 };
      const body = container.querySelector('[data-testid="rf__edge-loose:l1"] path.nx-hit')!;
      fireEvent.pointerDown(body, { button: 0, ...screenOf(container, at), pointerId: 1 });
      fireEvent.pointerMove(document, { ...screenOf(container, { x: at.x + 64, y: at.y }), pointerId: 1 });
      fireEvent.pointerUp(document, { ...screenOf(container, { x: at.x + 64, y: at.y }), pointerId: 1 });
      expect(commits(design)).toHaveLength(1);
      expect(commits(design)[0]![0].loose['l1']!.bends).toBeDefined();
    });

    it('the start square onto another step or the hub re-sources the wire; on empty canvas or its own source it snaps back', async () => {
      const doc = await twoAndOne();
      const design = picked();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
      const drag = (to: Point) => {
        fireEvent.pointerDown(squares(container)!.querySelector('.design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
        fireEvent.pointerMove(document, { ...screenOf(container, to), pointerId: 1 });
        const label = container.querySelector('.design-drop-label')?.textContent ?? null;
        // the loose wire itself follows the pointer, from its new start to its open end
        const path = wirePath(container, 'loose:l1');
        fireEvent.pointerUp(document, { ...screenOf(container, to), pointerId: 1 });
        return { label, path };
      };
      const onS2 = drag(middleOf(doc, 's2'));
      expect(onS2.label).toBe('re-attach here');
      expect(onS2.path[onS2.path.length - 1]).toEqual([EMPTY_AT.x, EMPTY_AT.y]);
      expect(commits(design)[0]).toEqual([resourceLoose(design.draft, 'l1', 's2'), { picks: [{ kind: 'wire', id: 'loose:l1' }] }]);

      expect(drag({ x: doc.placement.sphere.cx, y: doc.placement.sphere.cy }).label).toBe('re-attach here');
      expect(commits(design)[1]![0].loose['l1']!.source).toBe('wf');

      expect(drag({ x: 1150, y: 40 }).label).toBeNull();
      expect(drag(middleOf(doc, 's1')).label).toBe('starts here');
      expect(commits(design)).toHaveLength(2);
    });

    it('the start square over a cache says "cannot start here" and snaps back', async () => {
      const doc = await loadedDocument(graphDto({ steps: [stepDto('s1'), stepDto('s2')], caches: [cacheDto('c1')] }));
      const design = designOf({ draft: addLoose(EMPTY_DRAFT, 'l1', 's1', EMPTY_AT), picks: [{ kind: 'wire', id: 'loose:l1' }] });
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
      const c = doc.placement.caches.get('c1')!;
      const over = { x: c.x + CACHE_W / 2, y: c.y + CACHE_H / 2 };
      fireEvent.pointerDown(squares(container)!.querySelector('.design-handle.end[data-end="source"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
      fireEvent.pointerMove(document, { ...screenOf(container, over), pointerId: 1 });
      expect(container.querySelector('.design-drop-label')!.textContent).toBe('cannot start here');
      expect(nodeClass(container, 'cache:c1')).toContain('drop-no');
      fireEvent.pointerUp(document, { ...screenOf(container, over), pointerId: 1 });
      expect(design.onCommit).not.toHaveBeenCalled();
    });

    it('the open-end square does what the open circle does: onto a step it becomes a wire, the loose wire following the pointer', async () => {
      const doc = await twoAndOne();
      const design = picked();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
      fireEvent.pointerDown(squares(container)!.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
      fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
      expect(container.querySelector('.design-drop-label')!.textContent).toBe('connect here');
      expect(nodeClass(container, 's3')).toContain('drop-ok');
      // no separate ghost: the loose wire itself is drawn to the step, and its squares with it
      expect(container.querySelector('.design-ghost')).toBeNull();
      const s3 = doc.placement.steps.get('s3')!;
      expect(wirePath(container, 'loose:l1').at(-1)![0]).toBe(s3.x);
      expect(Number(squares(container)!.querySelector('.design-handle.end[data-end="target"]')!.getAttribute('x'))).toBeLessThan(s3.x);
      fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's3')), pointerId: 1 });
      expect(commits(design)[0]).toEqual([attachLoose(design.draft, doc, 'l1', 's3'), { picks: [{ kind: 'wire', id: 's1->s3' }] }]);
    });

    it('a shaped loose wire whose open end is moved is automatic again, as a re-attached end is', async () => {
      const doc = await twoAndOne();
      const design = picked({ ...EMPTY_DRAFT, loose: { l1: { source: 's1', end: EMPTY_AT, bends: { xs: [800, 1000], ys: [760] } } } });
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
      fireEvent.pointerDown(squares(container)!.querySelector('.design-handle.end[data-end="target"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
      fireEvent.pointerMove(document, { ...screenOf(container, { x: 1150, y: 600 }), pointerId: 1 });
      expect(container.querySelector('.design-drop-label')!.textContent).toBe('loose wire');
      fireEvent.pointerUp(document, { ...screenOf(container, { x: 1150, y: 600 }), pointerId: 1 });
      expect(commits(design)[0]![0].loose['l1']).toEqual({ source: 's1', end: { x: 1152, y: 600 } });
    });
  });
});

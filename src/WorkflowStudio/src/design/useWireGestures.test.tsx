import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import type { StudioDocument } from '../app/document';
import { clampLanding, PMID, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { circuitOf, EMPTY_DRAFT, isEmptyDraft, setShape, withCircuit, type Draft } from './draft';
import { setEnd } from '../circuit/circuit';
import { lengthOf, pointAt } from '../layout/junctions';
import { endsOf, pointsOfShape, shapeFromPoints } from '../layout/shape';
import { translatePoints } from '../layout/wireMove';
import type { DesignProps } from './designProps';
import { applyDraft } from './apply';
import { overlapsOf } from '../layout/overlaps';

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
const pointsOfD = (d: string): [number, number][] => [...d.matchAll(/[ML]([-\d.e]+) ([-\d.e]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const rightAngled = (pts: readonly (readonly [number, number])[]) => pts.length >= 2 && pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
/** A wire as drawn: its trace's points. */
const wirePath = (container: HTMLElement, id: string) => pointsOfD(container.querySelector(`[data-testid="rf__edge-${id}"] path.w`)!.getAttribute('d')!);
/** The dashed preview of a dragged wire's new route (Visio's, plan 10): the wire itself stays put until release. */
const ghostPath = (container: HTMLElement) => pointsOfD(container.querySelector('path.design-ghost')!.getAttribute('d')!);
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
    fireEvent.pointerMove(handle.ownerDocument, { clientX: 100, clientY: 184, pointerId: 1 });
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 100, clientY: 184, pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].wires!['s1->s2']!.bends).not.toBeNull();
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture')).toBe(false);
    // a press on a handle is not a rectangle on empty canvas: the picks stay
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a run dragged onto a step is pushed off it: the wire goes around the step, never through it', async () => {
    const doc = await three();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    // s1 -> s2 drops below both steps and comes back up just before s2
    const draft = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s1.x + STEP_W + 16, s2.x - 16], ys: [s1.y + STEP_H + 48] }, landing: null });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const ends = endsOf(wirePath(container, 's1->s2'));
    // the run that comes back up, dragged into the middle of s2
    const handle = container.querySelector('.design-handle.seg[data-k="3"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, middleOf(doc, 's2')), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, middleOf(doc, 's2')), pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    const bends = vi.mocked(design.onCommit).mock.calls[0]![0].wires!['s1->s2']!.bends!;
    const pts = pointsOfShape(ends, bends);
    expect(rightAngled(pts)).toBe(true);
    // no run lies inside s2 (its landing touches the border, from outside)
    const into = pts.some((a, i) => {
      const c = pts[i + 1];
      return c !== undefined && Math.max(a[0], c[0]) > s2.x && Math.min(a[0], c[0]) < s2.x + STEP_W && Math.max(a[1], c[1]) > s2.y && Math.min(a[1], c[1]) < s2.y + STEP_H;
    });
    expect(into).toBe(false);
  });

  it("a run dragged within 12 screen px of a step's edge snaps to it and shows Visio's guide there until release (plan 10 phase 2)", async () => {
    const doc = await three();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const low = s1.y + STEP_H + 48;
    const draft = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s1.x + STEP_W + 16, s2.x - 16], ys: [low] }, landing: null });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="2"]')!;
    const x = s1.x + STEP_W + 100;
    // the low run, dragged 10 px under the steps' bottom edge
    const edge = s1.y + STEP_H;
    fireEvent.pointerDown(handle, { button: 0, ...screenOf(container, { x, y: low }), pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x, y: edge + 10 }), pointerId: 1 });
    const guide = container.querySelector('line.design-guide.run')!;
    expect(guide).not.toBeNull();
    expect([Number(guide.getAttribute('y1')), Number(guide.getAttribute('y2'))]).toEqual([edge, edge]);
    fireEvent.pointerUp(document, { ...screenOf(container, { x, y: edge + 10 }), pointerId: 1 });
    expect(container.querySelector('line.design-guide.run')).toBeNull();
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].wires!['s1->s2']!.bends!.ys).toEqual([edge]);
  });

  it("a run is not snapped onto a step's side it would lie along (it would be pushed off): no guide, the drag as without the snap", async () => {
    const doc = await three();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const low = s1.y + STEP_H + 48;
    const draft = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s1.x + STEP_W + 16, s2.x - 32], ys: [low] }, landing: null });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    // the run that comes back up into s2, dragged 8 px short of s2's left side (which it would lie along)
    const handle = container.querySelector('.design-handle.seg[data-k="3"]')!;
    const y = (low + s2.y + PMID) / 2;
    fireEvent.pointerDown(handle, { button: 0, ...screenOf(container, { x: s2.x - 32, y }), pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: s2.x - 8, y }), pointerId: 1 });
    expect(container.querySelector('line.design-guide.run')).toBeNull();
    fireEvent.pointerUp(document, { ...screenOf(container, { x: s2.x - 8, y }), pointerId: 1 });
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].wires!['s1->s2']!.bends!.xs).toEqual([s1.x + STEP_W + 16, s2.x - 8]);
  });

  it("a head's run slid along its step's side snaps to the processor middle only: no guide elsewhere on the side (final review 2026-10-21)", async () => {
    const doc = await two();
    const s2 = doc.placement.steps.get('s2')!;
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const handle = container.querySelector('.design-handle.seg[data-k="0"]')!;
    const x = s2.x - 40;
    fireEvent.pointerDown(handle, { button: 0, ...screenOf(container, { x, y: s2.y + PMID }), pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x, y: s2.y + 40 }), pointerId: 1 });
    expect(container.querySelector('line.design-guide.run')).toBeNull();
    fireEvent.pointerMove(document, { ...screenOf(container, { x, y: s2.y + PMID + 6 }), pointerId: 1 });
    expect(Number(container.querySelector('line.design-guide.run')!.getAttribute('y1'))).toBe(s2.y + PMID);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerUp(document, { pointerId: 1 });
  });

  it("an end square held over the wire's other end square previews the whole wire going: no dashed new route (final review 2026-10-21)", async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
    const head = container.querySelector('.design-handle.end[data-end="head"]')!;
    const tail = container.querySelector('.design-handle.end[data-end="tail"]')!;
    const at = (el: Element) => ({ x: Number(el.getAttribute('cx')), y: Number(el.getAttribute('cy')) });
    fireEvent.pointerDown(head, { button: 0, ...screenOf(container, at(head)), pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: at(tail).x + 20, y: at(tail).y }), pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, at(tail)), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('delete wire');
    expect(container.querySelector('path.design-gone')).not.toBeNull();
    expect(container.querySelector('path.design-ghost')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerUp(document, { pointerId: 1 });
  });

  it('a run square shows the way its run moves, and keeps that double arrow while it is dragged', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    // a manual wire with one vertical run, landing below the processor middle so the run has length
    const draft = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [(s1.x + STEP_W + s2.x) / 2], ys: [] }, landing: 128 });
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

    // an end drag shows Visio's crosshair while the end is placed (plan 10 phase 2), not a run's double arrow
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="head"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-cross')).toBe(true);
    expect(canvas.classList.contains('gesture-ns')).toBe(false);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-cross')).toBe(false);
  });

  it('handles, outline and ghost keep their size on screen whatever the zoom', async () => {
    const doc = await two();
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] })} onSelect={vi.fn()} />);
    const zoom = Number(/scale\(([-\d.e]+)\)/.exec((container.querySelector('.react-flow__viewport') as HTMLElement).style.transform)![1]);
    const end = container.querySelector('.design-handle.end')!;
    // Visio's handles (plan 10 phase 2): an 8 px end circle and a 6 px run dot on screen
    expect(end.tagName).toBe('circle');
    expect(2 * Number(end.getAttribute('r')) * zoom).toBeCloseTo(8);
    const square = container.querySelector('.design-handle.seg')!;
    expect(2 * Number(square.getAttribute('r')) * zoom).toBeCloseTo(6);
    // the node outline (CSS) scales by the canvas's --inv
    expect(Number((container.querySelector('.studio-canvas') as HTMLElement).style.getPropertyValue('--inv')) * zoom).toBeCloseTo(1);
  });

  it('a run too short on screen to keep its square clear of an end square shows no square (the end wins)', async () => {
    const doc = await two();
    const s1 = doc.placement.steps.get('s1')!;
    // the first run is one grid step long: at any zoom below 2 its square would sit under the start dot
    const draft = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s1.x + STEP_W + 8], ys: [] }, landing: 128 });
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

  it('right-click → Reset route makes a manual wire automatic again; an automatic wire has it disabled', async () => {
    const doc = await two();
    const shaped = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [400], ys: [] }, landing: 96 });
    const onSelect = vi.fn();
    const design = designOf({ draft: shaped });
    const view = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
    fireEvent.contextMenu(view.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!, { clientX: 50, clientY: 50 });
    expect(onSelect).toHaveBeenCalledWith(null, [{ kind: 'wire', id: 's1->s2' }]);
    fireEvent.click(view.getByRole('menuitem', { name: /Reset route/ }));
    // automatic again: the workflow's own wire, so the draft holds nothing (no false "design draft")
    expect(isEmptyDraft(vi.mocked(design.onCommit).mock.calls[0]![0])).toBe(true);
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

  // ---- plan 9: every end square drags its end; the drop is judged as a circuit ----
  const four = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
  }));
  const commits = (design: DesignProps) => vi.mocked(design.onCommit).mock.calls;
  const inputOf = (doc: StudioDocument, id: string): Point => { const at = doc.placement.steps.get(id)!; return { x: at.x + 40, y: at.y + STEP_H / 2 }; };
  const outputOf = (doc: StudioDocument, id: string): Point => { const at = doc.placement.steps.get(id)!; return { x: at.x + STEP_W - 40, y: at.y + STEP_H / 2 }; };
  const onLine = (doc: StudioDocument, id: string, f = 0.5): Point => {
    const pts = doc.wires.find((w) => w.id === id)!.points;
    const [x, y] = pointAt([pts], lengthOf([pts]) * f).p;
    return { x, y };
  };
  const EMPTY_AT = { x: 1104, y: 704 };
  const canvasOf = (doc: StudioDocument, design: DesignProps) =>
    render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={vi.fn()} />);
  /** Presses a picked wire's end square, moves to `to`, reads the label there, releases. */
  const dragEnd = (container: HTMLElement, id: string, side: 'tail' | 'head', to: Point) => {
    fireEvent.pointerDown(container.querySelector(`.design-wire[data-wire="${id}"] .design-handle.end[data-end="${side}"]`)!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, to), pointerId: 1 });
    const label = container.querySelector('.design-drop-label');
    const read = { text: label?.textContent ?? null, tone: label?.getAttribute('class') ?? '' };
    fireEvent.pointerUp(document, { ...screenOf(container, to), pointerId: 1 });
    return read;
  };

  it("a picked wire has a dot on each end; dragged, it shows Visio's crosshair (plan 10 phase 2)", async () => {
    const doc = await two();
    const { container } = canvasOf(doc, designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] }));
    expect(container.querySelectorAll('.design-wire[data-wire="s1->s2"] .design-handle.end')).toHaveLength(2);
    const canvas = container.querySelector('.studio-canvas')!;
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="tail"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-cross')).toBe(true);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-cross')).toBe(false);
  });

  it('a head dropped on another step\'s input connects there: green "connect here", the same wire, one step', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    const to = inputOf(doc, 's3');
    const read = dragEnd(container, 's1->s2', 'head', to);
    expect(read.text).toBe('connect here');
    expect(read.tone).toContain('ok');
    const [draft, options] = commits(design)[0]!;
    expect(draft.wires!['s1->s2']!.head).toEqual({ on: 'step', step: 's3', y: clampLanding(to.y - doc.placement.steps.get('s3')!.y) });
    expect(draft.next['s1']).toEqual(['s3']);
    expect(options).toEqual({ picks: [{ kind: 'wire', id: 's1->s2' }] });
  });

  it('a head moved along its own step\'s input slides there (rule 5)', async () => {
    const doc = await two();
    const s2 = doc.placement.steps.get('s2')!;
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's1->s2', 'head', { x: s2.x + 20, y: s2.y + 120 }).text).toBe('connect here');
    expect(commits(design)[0]![0].wires!['s1->s2']!.head).toEqual({ on: 'step', step: 's2', y: 120 });
  });

  it('a head on a step\'s output, a tail on an input, or a head over the hub is refused in red; nothing changes', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }, { kind: 'wire', id: 's2->s3' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's1->s2', 'head', outputOf(doc, 's3')).text).toBe('wrong side');
    expect(dragEnd(container, 's2->s3', 'tail', inputOf(doc, 's1')).text).toBe('wrong side');
    const { cx, cy } = doc.placement.sphere;
    const hub = dragEnd(container, 's1->s2', 'head', { x: cx, y: cy - 40 });
    expect(hub.text).toBe('only a tail on the workflow');
    expect(hub.tone).toContain('no');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a tail dropped on the hub starts there, at the angle it was dropped; its step becomes an entry step (rule 1)', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = canvasOf(doc, design);
    const { cx, cy } = doc.placement.sphere;
    expect(dragEnd(container, 's2->s3', 'tail', { x: cx - 2, y: cy - 60 }).text).toBe('connect here');
    const [draft] = commits(design)[0]!;
    expect(draft.wires!['s2->s3']!.tail).toEqual({ on: 'hub', angle: 270 });
    expect(draft.entries).toEqual(['s1', 's3']);
  });

  it('an end released on empty canvas is open there, grey "move here"; both ends may be open', async () => {
    const doc = await two();
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const view = canvasOf(doc, design);
    const read = dragEnd(view.container, 's1->s2', 'head', EMPTY_AT);
    expect(read.text).toBe('move here');
    expect(read.tone).toContain('move');
    const [open] = commits(design)[0]!;
    expect(open.wires!['s1->s2']!.head).toEqual({ on: 'open', x: 1104, y: 704 });
    expect(open.next['s1']).toEqual([]);
    view.unmount();
    const both = designOf({ draft: open, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const again = canvasOf(doc, both);
    // away from its own line: the head's L now runs down x = 1104, and a tail dropped on it would be "same wire"
    expect(dragEnd(again.container, 's1->s2', 'tail', { x: 1000, y: 504 }).text).toBe('move here');
    expect(commits(both)[0]![0].wires!['s1->s2']!.tail).toEqual({ on: 'open', x: 1000, y: 504 });
  });

  it('a head on a wire of the same family joins it: "join here", a green halo; its current goes on into the host\'s step', async () => {
    const doc = await four();
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = canvasOf(doc, design);
    const on = onLine(doc, 's1->s2');
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.end[data-end="head"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, on), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('join here');
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] g.wire')!.getAttribute('class')).toContain('halo-ok');
    fireEvent.pointerUp(document, { ...screenOf(container, on), pointerId: 1 });
    const [draft] = commits(design)[0]!;
    expect(draft.wires!['s3->s4']!.head).toMatchObject({ on: 'wire', host: 's1->s2' });
    expect(draft.next['s3']).toEqual(['s2']);
  });

  it('a tail on a wire of another family is a short circuit: refused', async () => {
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4', { entryCondition: 2 })],
    }));
    const design = designOf({ picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = canvasOf(doc, design);
    const read = dragEnd(container, 's3->s4', 'tail', onLine(doc, 's1->s2'));
    expect(read.text).toBe('short circuit');
    expect(read.tone).toContain('no');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('both ends on one wire are refused: "same wire"', async () => {
    const doc = await four();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's3->s4', 'tail', onLine(doc, 's1->s2', 0.7)).text).toBe('same wire');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a head joined where its own step feeds itself joins (free style, 2026-10-20): "join here"', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's2->s3', 'head', onLine(doc, 's1->s2')).text).toBe('join here');
    expect(design.onCommit).toHaveBeenCalled();
  });

  it('a junction that closes a loop of wires is refused: "short circuit"', async () => {
    const doc = await four();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's1->s2', 'head', onLine(applyDraft(doc, draft), 's3->s4', 0.4)).text).toBe('short circuit');
    expect(design.onCommit).not.toHaveBeenCalled();
  });

  it('a dragged end over its own end run is not "same wire"; over the rest of its own line it is (Review Focus 5)', async () => {
    const doc = await two();
    const s2 = doc.placement.steps.get('s2')!;
    // a wire with a bend, so its head's run is not the whole wire (wireAt skips a straight one entirely)
    const draft = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s2.x - 32], ys: [] }, landing: 128 });
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    const pts = applyDraft(doc, draft).wires.find((x) => x.id === 's1->s2')!.points;
    expect(pts.length).toBeGreaterThan(2);
    const mid = (i: number): Point => ({ x: (pts[i]![0] + pts[i + 1]![0]) / 2, y: (pts[i]![1] + pts[i + 1]![1]) / 2 });
    expect(dragEnd(container, 's1->s2', 'head', mid(pts.length - 2)).text).not.toBe('same wire');
    // three quarters along its first run: its own line, clear of s1 and off the run's square
    const quarter: Point = { x: pts[0]![0] + ((pts[1]![0] - pts[0]![0]) * 3) / 4, y: pts[0]![1] };
    expect(dragEnd(container, 's1->s2', 'head', quarter).text).toBe('same wire');
    // on that run's square: released there it would cut the wire (the user's rule, 2026-10-09)
    expect(dragEnd(container, 's1->s2', 'head', mid(0)).text).toBe('cut here');
  });

  it('a host whose end is dropped open is detached: the end joined on it opens where it was drawn (spec §2.2-6)', async () => {
    const doc = await four();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    const contact = applyDraft(doc, draft).wires.find((w) => w.id === 's3->s4')!.points.at(-1)!;
    expect(dragEnd(container, 's1->s2', 'tail', EMPTY_AT).text).toBe('move here');
    const [next] = commits(design)[0]!;
    expect(next.wires!['s1->s2']!.tail).toEqual({ on: 'open', x: 1104, y: 704 });
    expect(next.wires!['s3->s4']!.head).toEqual({ on: 'open', x: contact[0], y: contact[1] });
    expect(next.next['s3']).toEqual([]);
  });

  it('Delete on a host leaves the wire joined on it open where it was drawn (spec §2.2-6)', async () => {
    const doc = await four();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    const contact = applyDraft(doc, draft).wires.find((w) => w.id === 's3->s4')!.points.at(-1)!;
    fireEvent.keyDown(container.querySelector('.studio-canvas')!, { key: 'Delete' });
    const [next] = commits(design)[0]!;
    expect(Object.hasOwn(next.wires!, 's1->s2')).toBe(false);
    expect(next.wires!['s3->s4']!.head).toEqual({ on: 'open', x: contact[0], y: contact[1] });
  });

  it('a new wire from a step\'s port released on empty canvas is a grey wire open at its head, picked', async () => {
    const doc = await two();
    const design = designOf();
    const { container } = canvasOf(doc, design);
    fireEvent.pointerDown(container.querySelector('.react-flow__node[data-id="s2"] .nx-port')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    expect(container.querySelector('.design-drop-label')!.textContent).toBe('move here');
    // Visio's crosshair while the new wire's end is placed (plan 10 phase 2)
    expect(container.querySelector('.studio-canvas')!.classList.contains('gesture-cross')).toBe(true);
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const [draft, options] = commits(design)[0]!;
    const id = Object.keys(draft.wires!).find((k) => k.startsWith('w:'))!;
    expect(draft.wires![id]).toEqual({ tail: { on: 'step', step: 's2', y: null }, head: { on: 'open', x: 1104, y: 704 } });
    expect(options).toEqual({ picks: [{ kind: 'wire', id }] });
  });

  // ---- runs of a manual wire, and of a wire whose head is on a junction ----
  it('the run squares of a manual wire follow the drag', async () => {
    const doc = await two();
    const shaped = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [528, 560], ys: [400] }, landing: null });
    const { container } = canvasOf(doc, designOf({ draft: shaped, picks: [{ kind: 'wire', id: 's1->s2' }] }));
    const run = () => container.querySelector('.design-handle.seg[data-k="1"]')!;
    // a run dot's centre
    const centre = (axis: 'x' | 'y', _size?: 'width' | 'height') => Number(run().getAttribute(axis === 'x' ? 'cx' : 'cy'));
    expect(centre('x', 'width')).toBeCloseTo(528);
    const y = centre('y', 'height');
    fireEvent.pointerDown(run(), { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: 544, y }), pointerId: 1 });
    // the squares stay on the wire, which stays put; the dashed preview has the run at 544 (Visio, plan 10)
    expect(centre('x', 'width')).toBeCloseTo(528);
    expect(ghostPath(container).some(([x]) => Math.abs(x - 544) < 0.01)).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });

  const joinedHead = (doc: StudioDocument) => withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));

  it('a picked wire whose head is on a junction shows its end squares and no square on its last run (it ends on the host)', async () => {
    const doc = await four();
    const draft = joinedHead(doc);
    const { container } = canvasOf(doc, designOf({ draft, picks: [{ kind: 'wire', id: 's3->s4' }] }));
    const g = container.querySelector('.design-wire[data-wire="s3->s4"]')!;
    expect(g.querySelectorAll('.design-handle.end')).toHaveLength(2);
    const w = applyDraft(doc, draft).wires.find((x) => x.id === 's3->s4')!;
    const last = 2 * shapeFromPoints(w.core.points).xs.length;
    expect(g.querySelectorAll('.design-handle.seg').length).toBeGreaterThan(0);
    expect(g.querySelector(`.design-handle.seg[data-k="${last}"]`)).toBeNull();
  });

  it('a run drag on a wire whose head is on a junction keeps its head on the host; its last run does not drag', async () => {
    const doc = await four();
    const draft = joinedHead(doc);
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's3->s4' }] });
    const { container } = canvasOf(doc, design);
    fireEvent.pointerDown(container.querySelector('.design-wire[data-wire="s3->s4"] .design-handle.seg[data-k="0"]')!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    const s3 = doc.placement.steps.get('s3')!;
    const to = { x: s3.x + STEP_W + 24, y: s3.y + STEP_H + 64 };
    fireEvent.pointerMove(document, { ...screenOf(container, to), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, to), pointerId: 1 });
    const [next] = commits(design)[0]!;
    expect(next.wires!['s3->s4']!.head).toEqual({ on: 'wire', host: 's1->s2', at: 40 });
    expect(next.wires!['s3->s4']!.bends!.xs.length).toBeGreaterThan(0);
    expect(next.next['s3']).toEqual(['s2']);
  });

  it('the last run of a wire open at its head slides the open head up and down, its x kept', async () => {
    const doc = await two();
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's1->s2', 'head', { on: 'open', x: 1104, y: 400 }));
    const design = designOf({ draft, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const { container } = canvasOf(doc, design);
    const runs = container.querySelectorAll('.design-wire[data-wire="s1->s2"] .design-handle.seg');
    fireEvent.pointerDown(runs[runs.length - 1]!, { button: 0, clientX: -500, clientY: -500, pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(container, { x: 1080, y: 464 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: 1080, y: 464 }), pointerId: 1 });
    const head = commits(design)[0]![0].wires!['s1->s2']!.head;
    expect(head).toMatchObject({ on: 'open', x: 1104 });
    expect((head as { y: number }).y).not.toBe(400);
  });

  // ---- the user's drag rules (2026-10-08): the body moves the whole wire; an end square adds one corner ----
  const pathNow = (doc: StudioDocument, draft: Draft, id: string) => applyDraft(doc, draft).wires.find((w) => w.id === id)!.points;
  const pressBody = (container: HTMLElement, id: string, at: Point) =>
    fireEvent.pointerDown(container.querySelector(`.react-flow__edge[data-id="${id}"] .nx-hit`)!, { button: 0, ...screenOf(container, at), pointerId: 1 });
  const bent = (doc: StudioDocument) => {
    const s1 = doc.placement.steps.get('s1')!;
    return setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [s1.x + STEP_W + 32], ys: [] }, landing: 128 });
  };

  it('a wire\'s body has the open hand in design mode only', async () => {
    const doc = await two();
    const view = canvasOf(doc, designOf());
    expect(view.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!.getAttribute('class')).toBe('nx-hit grab');
    view.unmount();
    const ro = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} />);
    expect(ro.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!.getAttribute('class')).toBe('nx-hit');
  });

  it('dragging any wire\'s body moves the whole wire rigidly, snapped to the grid: every point shifted, both ends open, its shape kept as bends; one step, picked; Visio\'s move cursor while dragged', async () => {
    const doc = await three();
    const draft = bent(doc);
    const design = designOf({ draft });
    const { container } = canvasOf(doc, design);
    const before = pathNow(doc, draft, 's1->s2');
    expect(before.length).toBe(4);
    const from = onLine(applyDraft(doc, draft), 's1->s2', 0.3);
    pressBody(container, 's1->s2', from);
    const canvas = container.querySelector('.studio-canvas')!;
    expect(canvas.getAttribute('class')).toBe('studio-canvas gesture gesture-move');
    fireEvent.pointerMove(document, { ...screenOf(container, { x: from.x + 43, y: from.y + 213 }), pointerId: 1 });
    // the dashed preview: the whole wire, moved; the wire itself stays put, faded, until release (Visio, plan 10)
    const moved = translatePoints(before, 40, 216);
    expect(ghostPath(container)).toEqual(moved);
    expect(wirePath(container, 's1->s2')).toEqual(before);
    expect(container.querySelector('[data-testid="rf__edge-s1->s2"] g.wire.faded')).not.toBeNull();
    expect(canvas.getAttribute('class')).toBe('studio-canvas gesture gesture-move');
    fireEvent.pointerUp(document, { ...screenOf(container, { x: from.x + 43, y: from.y + 213 }), pointerId: 1 });
    expect(commits(design)).toHaveLength(1);
    const [next, options] = commits(design)[0]!;
    const w = next.wires!['s1->s2']!;
    expect(w.tail).toEqual({ on: 'open', x: moved[0]![0], y: moved[0]![1] });
    expect(w.head).toEqual({ on: 'open', x: moved[3]![0], y: moved[3]![1] });
    expect(w.bends).toEqual(shapeFromPoints(moved));
    expect(pathNow(doc, next, 's1->s2')).toEqual(moved);
    expect(next.next['s1']).toEqual([]);
    expect(options).toEqual({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    expect(canvas.getAttribute('class')).toBe('studio-canvas');
  });

  it('a press on a wire\'s body that does not move is only a pick: no step; Escape mid-drag puts it back', async () => {
    const doc = await two();
    const design = designOf();
    const { container } = canvasOf(doc, design);
    const from = onLine(doc, 's1->s2');
    pressBody(container, 's1->s2', from);
    fireEvent.pointerUp(document, { ...screenOf(container, from), pointerId: 1 });
    pressBody(container, 's1->s2', from);
    fireEvent.pointerMove(document, { ...screenOf(container, { x: from.x, y: from.y + 1 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: from.x, y: from.y + 1 }), pointerId: 1 });
    pressBody(container, 's1->s2', from);
    fireEvent.pointerMove(document, { ...screenOf(container, { x: from.x, y: from.y + 80 }), pointerId: 1 });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: from.x, y: from.y + 80 }), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
    expect(wirePath(container, 's1->s2')).toEqual(doc.wires.find((w) => w.id === 's1->s2')!.points);
  });

  it('a host dragged by its body detaches: the end joined on it opens where it was drawn; a wire whose head is on a junction breaks it', async () => {
    const doc = await four();
    const draft = joinedHead(doc);
    const shown = applyDraft(doc, draft);
    const contact = shown.wires.find((w) => w.id === 's3->s4')!.points.at(-1)!;
    const host = designOf({ draft });
    const one = canvasOf(doc, host);
    const from = onLine(shown, 's1->s2', 0.3);
    // 48 up: its ends are still on s1's output and s2's input (rule B, 2026-10-09): it connects there again, moved
    // whole; the end joined on it is opened all the same
    pressBody(one.container, 's1->s2', from);
    fireEvent.pointerMove(document, { ...screenOf(one.container, { x: from.x, y: from.y - 48 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(one.container, { x: from.x, y: from.y - 48 }), pointerId: 1 });
    const [next] = commits(host)[0]!;
    expect(next.wires!['s1->s2']!.tail).toEqual({ on: 'step', step: 's1', y: PMID - 48 });
    expect(next.wires!['s1->s2']!.head).toMatchObject({ on: 'step', step: 's2' });
    expect(next.wires!['s3->s4']!.head).toEqual({ on: 'open', x: contact[0], y: contact[1] });
    one.unmount();

    const joined = designOf({ draft });
    const other = canvasOf(doc, joined);
    const own = shown.wires.find((w) => w.id === 's3->s4')!.points;
    const at = onLine(shown, 's3->s4', 0.2);
    pressBody(other.container, 's3->s4', at);
    // down clear of every block and line: both its ends open where the moved path starts and ends
    fireEvent.pointerMove(document, { ...screenOf(other.container, { x: at.x + 16, y: at.y + 400 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(other.container, { x: at.x + 16, y: at.y + 400 }), pointerId: 1 });
    const [after] = commits(joined)[0]!;
    const moved = translatePoints(own, 16, 400);
    expect(after.wires!['s3->s4']).toMatchObject({ tail: { on: 'open', x: moved[0]![0], y: moved[0]![1] }, head: { on: 'open', x: moved.at(-1)![0], y: moved.at(-1)![1] } });
    expect(pathNow(doc, after, 's3->s4')).toEqual(moved);
    expect(after.wires!['s1->s2']).toEqual(draft.wires!['s1->s2']);
  });

  it('a head square dragged down off a straight wire adds one corner (an L); its vertical leg dragged sideways adds a horizontal one; dropped on a step it still connects', async () => {
    const doc = await three();
    const s2 = doc.placement.steps.get('s2')!;
    const pts = doc.wires.find((w) => w.id === 's1->s2')!.points;
    const [t0, h0] = [pts[0]!, pts.at(-1)!];
    expect(t0[1]).toBe(h0[1]);
    const first = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const one = canvasOf(doc, first);
    const down = { x: h0[0], y: s2.y + STEP_H + 32 };
    fireEvent.pointerDown(one.container.querySelector('.design-wire[data-wire="s1->s2"] .design-handle.end[data-end="head"]')!, { button: 0, ...screenOf(one.container, { x: h0[0], y: h0[1] }), pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(one.container, down), pointerId: 1 });
    // while dragged the dashed preview is the L already; the wire itself stays put until release (Visio, plan 10)
    expect(ghostPath(one.container)).toEqual([[t0[0], t0[1]], [h0[0], h0[1]], [down.x, down.y]]);
    expect(wirePath(one.container, 's1->s2')).toEqual([[t0[0], t0[1]], [h0[0], h0[1]]]);
    expect(one.container.querySelector('.design-drop-label')!.textContent).toBe('move here');
    fireEvent.pointerUp(document, { ...screenOf(one.container, down), pointerId: 1 });
    const [l] = commits(first)[0]!;
    expect(l.wires!['s1->s2']!.head).toEqual({ on: 'open', x: down.x, y: down.y });
    // the other end stays where it is drawn: an automatic tail is held at its height, so no fan-out or landing moves it
    expect(l.wires!['s1->s2']!.tail).toEqual({ on: 'step', step: 's1', y: t0[1] - doc.placement.steps.get('s1')!.y });
    expect(l.wires!['s1->s2']!.held).toBe('tail');
    expect(pathNow(doc, l, 's1->s2')).toEqual([[t0[0], t0[1]], [h0[0], h0[1]], [down.x, down.y]]);
    one.unmount();

    const second = designOf({ draft: l, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const other = canvasOf(doc, second);
    const aside = { x: down.x + 80, y: down.y };
    expect(dragEnd(other.container, 's1->s2', 'head', aside).text).toBe('move here');
    const [z] = commits(second)[0]!;
    expect(pathNow(doc, z, 's1->s2')).toEqual([[t0[0], t0[1]], [h0[0], h0[1]], [down.x, down.y], [aside.x, aside.y]]);
    other.unmount();

    const third = designOf({ draft: z, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const last = canvasOf(doc, third);
    const read = dragEnd(last.container, 's1->s2', 'head', inputOf(doc, 's3'));
    expect(read.text).toBe('connect here');
    // connected again: the tail held at its height goes back to automatic
    const back = commits(third)[0]![0].wires!['s1->s2']!;
    expect(back.head).toMatchObject({ on: 'step', step: 's3' });
    expect(back.tail).toEqual({ on: 'step', step: 's1', y: null });
    expect(back.held).toBeUndefined();
  });

  it('a tail square dragged down adds one corner at the tail; dragged along its run only lengthens it', async () => {
    const doc = await three();
    const s1 = doc.placement.steps.get('s1')!;
    const pts = doc.wires.find((w) => w.id === 's1->s2')!.points;
    const [t0, h0] = [pts[0]!, pts.at(-1)!];
    const design = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const view = canvasOf(doc, design);
    const down = { x: t0[0], y: s1.y + STEP_H + 32 };
    expect(dragEnd(view.container, 's1->s2', 'tail', down).text).toBe('move here');
    const [l] = commits(design)[0]!;
    expect(l.wires!['s1->s2']!.tail).toEqual({ on: 'open', x: down.x, y: down.y });
    expect(l.wires!['s1->s2']!.head).toEqual({ on: 'step', step: 's2', y: h0[1] - doc.placement.steps.get('s2')!.y });
    expect(pathNow(doc, l, 's1->s2')).toEqual([[down.x, down.y], [t0[0], t0[1]], [h0[0], h0[1]]]);
    view.unmount();

    // an open tail moved along its (horizontal) run: no corner
    const open = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's1->s2', 'tail', { on: 'open', x: t0[0] + 40, y: t0[1] }));
    const along = designOf({ draft: open, picks: [{ kind: 'wire', id: 's1->s2' }] });
    const again = canvasOf(doc, along);
    expect(dragEnd(again.container, 's1->s2', 'tail', { x: t0[0] + 16, y: t0[1] }).text).toBe('move here');
    expect(pathNow(doc, commits(along)[0]![0], 's1->s2')).toEqual([[t0[0] + 16, t0[1]], [h0[0], h0[1]]]);
  });

  it('a press on a wire\'s body that moves less than a grid step picks it as a click would (its click is swallowed); with Ctrl it toggles; nothing is committed', async () => {
    const doc = await two();
    const onSelect = vi.fn();
    const design = designOf();
    const view = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
    const from = onLine(doc, 's1->s2');
    pressBody(view.container, 's1->s2', from);
    // 3 screen px at 100 %: past the drag threshold, but it snaps to no move
    fireEvent.pointerMove(document, { ...screenOf(view.container, { x: from.x, y: from.y + 3 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(view.container, { x: from.x, y: from.y + 3 }), pointerId: 1 });
    expect(design.onCommit).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(null, [{ kind: 'wire', id: 's1->s2' }]);
    view.unmount();

    const select = vi.fn();
    const picked = designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] });
    const again = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={picked} onSelect={select} />);
    fireEvent.pointerDown(again.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!, { button: 0, ctrlKey: true, ...screenOf(again.container, from), pointerId: 1 });
    fireEvent.pointerMove(document, { ...screenOf(again.container, { x: from.x + 3, y: from.y }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(again.container, { x: from.x + 3, y: from.y }), pointerId: 1 });
    expect(select).toHaveBeenCalledWith(null, []);
    expect(picked.onCommit).not.toHaveBeenCalled();
  });

  it('a straight wire moved whole stays straight where it is put (it keeps a one-run shape)', async () => {
    const doc = await three();
    const s1 = doc.placement.steps.get('s1')!;
    const design = designOf();
    const { container } = canvasOf(doc, design);
    const before = doc.wires.find((w) => w.id === 's1->s2')!.points;
    expect(before).toHaveLength(2);
    const from = onLine(doc, 's1->s2');
    // down below the steps, clear of every block: both ends open there
    pressBody(container, 's1->s2', from);
    fireEvent.pointerMove(document, { ...screenOf(container, { x: from.x - 64, y: from.y + 320 }), pointerId: 1 });
    fireEvent.pointerUp(document, { ...screenOf(container, { x: from.x - 64, y: from.y + 320 }), pointerId: 1 });
    const [next] = commits(design)[0]!;
    const moved = translatePoints(before, -64, 320);
    expect(moved[0]![1]).toBeGreaterThan(s1.y + STEP_H);
    expect(next.wires!['s1->s2']!.bends).toEqual({ xs: [moved[0]![0]], ys: [] });
    expect(pathNow(doc, next, 's1->s2')).toEqual(moved);
  });

  it('a head dragged open off a wire from the hub holds its automatic tail exactly where it is drawn (review 2026-10-09), not moved by the fan-out', async () => {
    const doc = await two();
    const id = 'wf->s1';
    const pts = doc.wires.find((w) => w.id === id)!.points;
    const design = designOf({ picks: [{ kind: 'wire', id }] });
    const { container } = canvasOf(doc, design);
    const s1 = doc.placement.steps.get('s1')!;
    expect(dragEnd(container, id, 'head', { x: pts.at(-1)![0], y: s1.y + STEP_H + 48 }).text).toBe('move here');
    const w = commits(design)[0]![0].wires![id]!;
    expect(w.tail).toEqual({ on: 'hub', angle: null, dy: pts[0]![1] - doc.placement.sphere.cy });
    expect(w.held).toBe('tail');
    expect(pathNow(doc, commits(design)[0]![0], id)[0]).toEqual(pts[0]);
  });
});

describe('a run drag on a wire the router left on another (re-review 2026-10-09)', () => {
  // the review's seed 12345, trial 150: two automatic wires into s16 (s8 -> s16 one of them) share an upright run before
  // s16 (the gap there is too crowded to give each its own track)
  const crowded = async () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let trial = 0; ; trial++) {
      const n = 3 + Math.floor(rnd() * 14);
      const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
      const steps = ids.map((id, i) => {
        const next: string[] = [];
        for (let j = 0; j < n; j++) if (j !== i && rnd() < (j > i ? 0.3 : 0.05)) next.push(ids[j]!);
        return stepDto(id, { nextStepIds: next, entryCondition: (1 + Math.floor(rnd() * 3)) as 1 | 2 | 3 });
      });
      const entries = ids.filter((_, i) => i === 0 || rnd() < 0.15);
      if (trial === 150) return loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: entries }), steps }));
    }
  };

  it('a run moved a grid step keeps the stretch it already shared: no "short circuit", committed', async () => {
    const doc = await crowded();
    // two wires into s16 share a stretch as the router drew them (not a short circuit: both automatic)
    const pair = overlapsOf(doc.wires).find((o) => o.a.endsWith('->s16') && o.b.endsWith('->s16'))!;
    expect(pair).toBeDefined();
    const b = doc.wires.find((w) => w.id === 's8->s16')!;
    expect([pair.a, pair.b]).toContain(b.id);
    expect(b.short).toBe(false);
    expect(b.core.points[1]![0]).toBe(b.core.points[2]![0]);
    const design = designOf({ picks: [{ kind: 'wire', id: b.id }] });
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} />);
    // its first upright run (run 1) a grid step across
    const handle = container.querySelector(`.design-wire[data-wire="${b.id}"] .design-handle.seg[data-k="1"]`)!;
    expect(handle).not.toBeNull();
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle.ownerDocument, { clientX: 108, clientY: 100, pointerId: 1 });
    expect(container.querySelector('.design-drop-label')).toBeNull();
    fireEvent.pointerUp(handle.ownerDocument, { clientX: 108, clientY: 100, pointerId: 1 });
    expect(design.onCommit).toHaveBeenCalledTimes(1);
    const draft = vi.mocked(design.onCommit).mock.calls[0]![0];
    // shaped by hand now (its run moved, pushed clear of the block beside it)
    expect(draft.wires![b.id]!.bends!.xs[0]).not.toBe(b.core.points[1]![0]);
    // and drawn with nothing short: the automatic partner took a track around it
    expect(applyDraft(doc, draft).wires.filter((w) => w.short).map((w) => w.id)).toEqual([]);
  });
});

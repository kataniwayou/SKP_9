import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createTextFitter } from '../canvas/fitText';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import type { StudioDocument } from '../app/document';
import { clampLanding, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { circuitOf, EMPTY_DRAFT, setShape, withCircuit } from './draft';
import { setEnd } from '../circuit/circuit';
import { lengthOf, pointAt } from '../layout/junctions';
import { endsOf, pointsOfShape } from '../layout/shape';
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

    // an end drag shows the four-way cursor (plan 9 rule 14), not a run's double arrow
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="head"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(true);
    expect(canvas.classList.contains('gesture-ns')).toBe(false);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(false);
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
    const shaped = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs: [400], ys: [] }, landing: 96 });
    const onSelect = vi.fn();
    const design = designOf({ draft: shaped });
    const view = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={AT_100} design={design} onSelect={onSelect} />);
    fireEvent.contextMenu(view.container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!, { clientX: 50, clientY: 50 });
    expect(onSelect).toHaveBeenCalledWith(null, [{ kind: 'wire', id: 's1->s2' }]);
    fireEvent.click(view.getByRole('menuitem', { name: /Reset route/ }));
    expect(vi.mocked(design.onCommit).mock.calls[0]![0].wires!['s1->s2']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's2', y: null } });
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

  it('a picked wire has a square on each end with the four-way cursor, kept while dragged (rule 14)', async () => {
    const doc = await two();
    const { container } = canvasOf(doc, designOf({ picks: [{ kind: 'wire', id: 's1->s2' }] }));
    expect(container.querySelectorAll('.design-wire[data-wire="s1->s2"] .design-handle.end')).toHaveLength(2);
    const canvas = container.querySelector('.studio-canvas')!;
    fireEvent.pointerDown(container.querySelector('.design-handle.end[data-end="tail"]')!, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(true);
    fireEvent.pointerUp(document, { clientX: 100, clientY: 100, pointerId: 1 });
    expect(canvas.classList.contains('gesture-move')).toBe(false);
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
    expect(dragEnd(again.container, 's1->s2', 'tail', { x: 1104, y: 504 }).text).toBe('move here');
    expect(commits(both)[0]![0].wires!['s1->s2']!.tail).toEqual({ on: 'open', x: 1104, y: 504 });
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

  it('a head joined where its own step would feed itself is refused: "same step"', async () => {
    const doc = await three();
    const design = designOf({ picks: [{ kind: 'wire', id: 's2->s3' }] });
    const { container } = canvasOf(doc, design);
    expect(dragEnd(container, 's2->s3', 'head', onLine(doc, 's1->s2')).text).toBe('same step');
    expect(design.onCommit).not.toHaveBeenCalled();
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
    expect(dragEnd(container, 's1->s2', 'head', mid(0)).text).toBe('same wire');
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
    fireEvent.pointerUp(document, { ...screenOf(container, EMPTY_AT), pointerId: 1 });
    const [draft, options] = commits(design)[0]!;
    const id = Object.keys(draft.wires!).find((k) => k.startsWith('w:'))!;
    expect(draft.wires![id]).toEqual({ tail: { on: 'step', step: 's2', y: null }, head: { on: 'open', x: 1104, y: 704 } });
    expect(options).toEqual({ picks: [{ kind: 'wire', id }] });
  });
});

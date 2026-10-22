import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore, useStoreApi } from '@xyflow/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { loadDocument } from '../app/loadDocument';
import type { DesignProps } from '../design/designProps';
import { setEnd } from '../circuit/circuit';
import { circuitOf, EMPTY_DRAFT, withCircuit } from '../design/draft';
import { createTextFitter } from './fitText';
import { WorkflowCanvas } from './WorkflowCanvas';
import { ZoomControls } from './ZoomControls';

/** Shows the size React Flow measured for the canvas; given `to`, sets it there (the canvas settling at another size). */
function CanvasSize({ to = null }: { to?: { width: number; height: number } | null }) {
  const store = useStoreApi();
  const width = useStore((st) => st.width);
  const height = useStore((st) => st.height);
  useEffect(() => { if (to) store.setState({ width: to.width, height: to.height }); }, [store, to?.width, to?.height]);
  return <output aria-label="Canvas size" data-width={width} data-height={height} />;
}
const measured = (c: HTMLElement) => {
  const o = c.querySelector('output[aria-label="Canvas size"]')!;
  return { width: Number(o.getAttribute('data-width')), height: Number(o.getAttribute('data-height')) };
};

const fitter = createTextFitter((t) => t.length * 7);

describe('WorkflowCanvas', () => {
  it('draws the sphere, every step and every wire of a loaded document', async () => {
    const api = {
      getGraph: async () => ({
        ok: true,
        value: graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }),
      }),
      getStep: async () => ({ ok: false, error: { kind: 'notFound', status: 404 } }),
      getProcessor: async () => ({ ok: false, error: { kind: 'notFound', status: 404 } }),
      listWorkflows: async () => ({ ok: true, value: [] }),
    } as unknown as StudioApi;
    const loaded = await loadDocument(api, 'wf1');
    if (!loaded.ok) throw new Error('load failed');

    const { container, getByText } = render(<WorkflowCanvas doc={loaded.value} fitter={fitter} width={1200} height={800} />);

    expect(getByText('WORKFLOW')).toBeInTheDocument();
    expect(getByText('fetch')).toBeInTheDocument();
    expect(getByText('store')).toBeInTheDocument();
    expect(container.querySelectorAll('.wire')).toHaveLength(2);
  });

  it('mounts the canvas afresh for another workflow, so React Flow fits the new document', async () => {
    const load = async (id: string) => {
      const api = {
        getGraph: async () => ({ ok: true, value: graphDto({ workflow: workflowDto({ id }) }) }),
      } as unknown as StudioApi;
      const r = await loadDocument(api, id);
      if (!r.ok) throw new Error('load failed');
      return r.value;
    };
    const a = await load('wfA'), b = await load('wfB');

    const { container, rerender } = render(<WorkflowCanvas doc={a} fitter={fitter} width={1200} height={800} />);
    const first = container.querySelector('.studio-canvas');
    rerender(<WorkflowCanvas doc={a} fitter={fitter} width={1200} height={800} />);
    expect(container.querySelector('.studio-canvas')).toBe(first);
    rerender(<WorkflowCanvas doc={b} fitter={fitter} width={1200} height={800} />);
    expect(container.querySelector('.studio-canvas')).not.toBe(first);
  });

  describe('selection (slice 3a)', () => {
    async function twoSteps() {
      const api = {
        getGraph: async () => ({ ok: true, value: graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }) }),
      } as unknown as StudioApi;
      const r = await loadDocument(api, 'wf1');
      if (!r.ok) throw new Error('load failed');
      return r.value;
    }
    const node = (container: HTMLElement, id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

    it('shows the hub started only when the live state says so (review focus 3)', async () => {
      const doc = await twoSteps();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} />);
      expect(container.querySelector('.wf')!.getAttribute('data-started')).toBe('false');

      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} live={{ started: true, status: 'running', health: () => 'healthy' }} />);
      expect(container.querySelector('.wf')!.getAttribute('data-started')).toBe('true');
    });

    it('shows no React Flow attribution badge', async () => {
      const { container } = render(<WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} />);
      expect(container.querySelector('.react-flow__node')).not.toBeNull();
      expect(container.querySelector('.react-flow__attribution')).toBeNull();
    });

    it('reports a click on a step, on its die, on the sphere and on empty canvas', async () => {
      const onSelect = vi.fn();
      const { container } = render(<WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} onSelect={onSelect} />);

      fireEvent.click(node(container, 's1'));
      fireEvent.click(node(container, 's2').querySelector('.chipg .nx-panel')!);
      fireEvent.click(node(container, 'wf'));
      fireEvent.click(container.querySelector('.react-flow__pane')!);

      expect(onSelect.mock.calls.map((c) => c[0])).toEqual([
        { kind: 'step', stepId: 's1' },
        { kind: 'processor', processorId: 'p1', stepId: 's2' },
        { kind: 'workflow' },
        null,
      ]);
      // read-only: exactly one argument, as in slice 3a (no picks)
      expect(onSelect.mock.calls.every((c) => c.length === 1)).toBe(true);
    });

    it('marks the selected step, and a selected processor on its own step only', async () => {
      const doc = await twoSteps();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} selection={{ kind: 'step', stepId: 's2' }} />);
      expect(node(container, 's2')).toHaveClass('studio-sel');
      expect(node(container, 's1')).not.toHaveClass('studio-sel');

      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} selection={{ kind: 'processor', processorId: 'p1', stepId: 's1' }} />);
      expect(node(container, 's1')).toHaveClass('studio-die-sel');
      expect(node(container, 's2')).not.toHaveClass('studio-die-sel');
      expect(container.querySelectorAll('.studio-sel')).toHaveLength(0);
    });

    it('drives its own React Flow instance from controls passed as children', async () => {
      render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      expect(screen.getByLabelText('Zoom level').tagName).toBe('OUTPUT');
      const level = () => Number(screen.getByLabelText('Zoom level').textContent!.replace('%', ''));
      await waitFor(() => expect(level()).toBeGreaterThan(0));
      const before = level();

      fireEvent.click(screen.getByLabelText('Zoom in'));

      await waitFor(() => expect(level()).toBeGreaterThan(before));
    });

    it('draws each processor in the health the canvas live state gives it', async () => {
      const live = { started: false, status: 'stopped' as const, health: (id: string) => (id === 'p1' ? 'unhealthy' as const : 'healthy' as const) };
      const { container } = render(<WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} live={live} />);
      const rings = [...container.querySelectorAll('.nx-health')];
      expect(rings.length).toBe(2);
      for (const ring of rings) expect(ring.getAttribute('data-health')).toBe('unhealthy');
    });

    it('opens at a saved view that no longer followed Fit, and reports the view when it settles', async () => {
      const onViewChange = vi.fn();
      const { container } = render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800}
          initialView={{ x: -100, y: 40, zoom: 1.5, followFit: false }} onViewChange={onViewChange}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).toHaveTextContent('150%'));
      // jsdom serializes the transform without the space after the comma
      expect((container.querySelector('.react-flow__viewport') as HTMLElement).style.transform.replace(/,\s*/g, ', ')).toBe('translate(-100px, 40px) scale(1.5)');

      fireEvent.click(screen.getByLabelText('Zoom in'));
      await waitFor(() => expect(onViewChange).toHaveBeenCalled());
      const last = onViewChange.mock.calls.at(-1)![0];
      expect(last.zoom).toBeGreaterThan(1.5);
      expect(last.followFit).toBe(false);
    });

    it('reports a view change at once, so a refresh right after it still finds it in the session', async () => {
      // React Flow calls onMoveEnd 150 ms after the move when panOnScroll is on; a refresh inside that time
      // (a zoom click, then a pane hidden, then F5) wrote the view from before the move
      const onViewChange = vi.fn();
      render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800}
          initialView={{ x: -100, y: 40, zoom: 1.5, followFit: false }} onViewChange={onViewChange}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).toHaveTextContent('150%'));
      onViewChange.mockClear();
      fireEvent.click(screen.getByLabelText('Zoom in'));
      expect(onViewChange).toHaveBeenCalled();
      const last = onViewChange.mock.calls.at(-1)![0];
      expect(last.zoom).toBeCloseTo(1.8);
      expect(last.followFit).toBe(false);
    });

    it('reads the saved view once: a later view handed back queues no fit', async () => {
      // a queued fit runs on the next node change in a browser (jsdom never measures nodes, so it is checked directly)
      // `fitViewQueued` is a React Flow internal store field (not public api), read here because jsdom never
      // measures nodes, so the queued fit itself never runs; if React Flow renames it, this test must follow
      function FitQueued() {
        return <output aria-label="Fit queued">{String(useStore((st) => st.fitViewQueued))}</output>;
      }
      const doc = await twoSteps();
      const saved = { x: -100, y: 40, zoom: 1.5, followFit: false };
      const canvas = (initialView: typeof saved) => (
        <WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={initialView}>
          <ZoomControls />
          <FitQueued />
        </WorkflowCanvas>
      );
      const { rerender } = render(canvas(saved));
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).toHaveTextContent('150%'));

      // the page hands back what the canvas reported after Fit was pressed
      rerender(canvas({ ...saved, followFit: true }));
      expect(screen.getByLabelText('Fit queued')).toHaveTextContent('false');
    });

    it('a restored view keeps its centre against the size it was saved at: a canvas that settles after a refresh does not move it', async () => {
      // the deployed studio lays a restored canvas out 26 px taller for a frame, then at its saved size: measured
      // from that first frame, the view came back 13 px off (session.spec on the deployed studio). jsdom measures
      // this canvas once (the ResizeObserver shim); CanvasSize then sets the size the canvas settles at.
      const transform = (c: HTMLElement) => (c.querySelector('.react-flow__viewport') as HTMLElement).style.transform.replace(/,\s*/g, ', ');
      const doc = await twoSteps();
      const probe = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800}><CanvasSize /></WorkflowCanvas>);
      const first = measured(probe.container);
      probe.unmount();
      const saved = { x: -100, y: 40, zoom: 1.5, followFit: false, width: first.width, height: first.height - 26 };
      const canvas = (size: { width: number; height: number } | null) => (
        <WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} initialView={saved}><CanvasSize to={size} /></WorkflowCanvas>
      );
      const { container, rerender } = render(canvas(null));
      // laid out 26 px taller than it was saved at: the saved centre stays the centre
      await waitFor(() => expect(transform(container)).toBe('translate(-100px, 53px) scale(1.5)'));
      // settled at the saved size: exactly the saved view
      rerender(canvas({ width: saved.width, height: saved.height }));
      await waitFor(() => expect(transform(container)).toBe('translate(-100px, 40px) scale(1.5)'));
    });

    it('reports the canvas size with each view, so a restore knows what the view was taken at', async () => {
      const onViewChange = vi.fn();
      const { container } = render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800}
          initialView={{ x: -100, y: 40, zoom: 1.5, followFit: false }} onViewChange={onViewChange}>
          <ZoomControls />
          <CanvasSize />
        </WorkflowCanvas>,
      );
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).toHaveTextContent('150%'));
      fireEvent.click(screen.getByLabelText('Zoom in'));
      expect(onViewChange.mock.calls.at(-1)![0]).toMatchObject(measured(container));
    });

    it('fits a document whose saved view still followed Fit', async () => {
      render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} initialView={{ x: -100, y: 40, zoom: 1.5, followFit: true }}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).not.toHaveTextContent('150%'));
    });
  });

  describe('design mode (plan 4)', () => {
    const designOf = (over: Partial<DesignProps> = {}): DesignProps => ({ draft: EMPTY_DRAFT, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn(), ...over });
    const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }));

    it('draws the draft over the saved document', async () => {
      const doc = await two();
      const s2 = doc.placement.steps.get('s2')!;
      const draft = { ...EMPTY_DRAFT, steps: { s2: { x: s2.x, y: s2.y + 320 } } };
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ draft })} />);
      const node = container.querySelector('.react-flow__node[data-id="s2"]') as HTMLElement;
      expect(node.style.transform).toContain(`${s2.y + 320}px`);
    });

    it('a click picks one block, Ctrl+click adds, a wire click picks the wire, the pane clears', async () => {
      const doc = await two();
      const onSelect = vi.fn();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={onSelect} />);
      fireEvent.click(screen.getByText('fetch'));
      expect(onSelect).toHaveBeenLastCalledWith({ kind: 'step', stepId: 's1' }, [{ kind: 'node', id: 's1' }]);
      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'node', id: 's1' }] })} onSelect={onSelect} />);
      fireEvent.click(screen.getByText('store'), { ctrlKey: true });
      expect(onSelect).toHaveBeenLastCalledWith(null, [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }]);
      fireEvent.click(container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!);
      expect(onSelect).toHaveBeenLastCalledWith(null, [{ kind: 'wire', id: 's1->s2' }]);
      fireEvent.click(container.querySelector('.react-flow__pane')!);
      expect(onSelect).toHaveBeenLastCalledWith(null, []);
    });

    it('marks picked blocks and wires', async () => {
      const doc = await two();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }] })} />);
      expect(container.querySelector('.react-flow__node[data-id="s2"]')!.className).toContain('studio-pick');
      expect(container.querySelector('.react-flow__edge[data-id="s1->s2"] .wire')!.getAttribute('class')).toContain('picked');
    });

    it('a left-drag rectangle on empty canvas picks what lies inside; its closing click does not clear them (the user, 2026-10-22: a Ctrl+drag pans)', async () => {
      const doc = await two();
      const onSelect = vi.fn();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={onSelect} />);
      const pane = container.querySelector('.react-flow__pane')!;
      fireEvent.pointerDown(pane, { button: 0, clientX: -1e5, clientY: -1e5 });
      fireEvent.pointerMove(document, { clientX: 0, clientY: 0 });
      expect(container.ownerDocument.querySelector('.design-band')).not.toBeNull();
      fireEvent.pointerUp(document, { clientX: 1e5, clientY: 1e5 });
      fireEvent.click(pane);
      expect(onSelect).toHaveBeenCalledTimes(1);
      const [selection, picks] = onSelect.mock.calls[0]!;
      expect(selection).toBeNull();
      expect(picks).toEqual(expect.arrayContaining([{ kind: 'node', id: 'wf' }, { kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }]));
      expect(container.ownerDocument.querySelector('.design-band')).toBeNull();
    });

    it('Escape during a rectangle cancels it: the picks stay, the release picks nothing, the Escape goes no further', async () => {
      const doc = await two();
      const onSelect = vi.fn();
      const { container, unmount } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'node', id: 's1' }] })} onSelect={onSelect} />);
      const pane = container.querySelector('.react-flow__pane')!;
      fireEvent.pointerDown(pane, { button: 0, clientX: -1e5, clientY: -1e5 });
      fireEvent.pointerMove(document, { clientX: 0, clientY: 0 });
      expect(container.ownerDocument.querySelector('.design-band')).not.toBeNull();
      const outside = vi.fn();
      window.addEventListener('keydown', outside);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      window.removeEventListener('keydown', outside);
      expect(outside).not.toHaveBeenCalled();
      expect(container.ownerDocument.querySelector('.design-band')).toBeNull();
      // the button is still down; moving on draws no rectangle, and the release and its click pick nothing
      fireEvent.pointerMove(document, { clientX: 1e5, clientY: 1e5 });
      expect(container.ownerDocument.querySelector('.design-band')).toBeNull();
      fireEvent.pointerUp(document, { clientX: 1e5, clientY: 1e5 });
      fireEvent.click(pane);
      expect(onSelect).not.toHaveBeenCalled();
      // the next Escape is the studio's again
      const later = vi.fn();
      window.addEventListener('keydown', later);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      window.removeEventListener('keydown', later);
      expect(later).toHaveBeenCalled();
      // and a rectangle cut short by an unmount leaves no Escape listener behind
      fireEvent.pointerDown(pane, { button: 0, clientX: -1e5, clientY: -1e5 });
      fireEvent.pointerMove(document, { clientX: 0, clientY: 0 });
      unmount();
      const after = vi.fn();
      window.addEventListener('keydown', after);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      window.removeEventListener('keydown', after);
      expect(after).toHaveBeenCalled();
    });

    it('a press on a block or a wire starts no rectangle (both lie inside React Flow\'s pane)', async () => {
      const doc = await two();
      const onSelect = vi.fn();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={onSelect} />);
      for (const el of [screen.getByText('fetch'), container.querySelector('.react-flow__edge[data-id="s1->s2"] .nx-hit')!]) {
        fireEvent.pointerDown(el, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerMove(document, { clientX: 300, clientY: 300 });
        expect(container.ownerDocument.querySelector('.design-band')).toBeNull();
        fireEvent.pointerUp(document, { clientX: 300, clientY: 300 });
      }
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('a rectangle shows no closed hand (that is the pan cursor, the user 2026-10-22): the canvas is marked banding once it moves', async () => {
      const doc = await two();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={vi.fn()} />);
      const canvas = container.querySelector('.studio-canvas')!;
      const pane = container.querySelector('.react-flow__pane')!;
      fireEvent.pointerDown(pane, { button: 0, clientX: 5, clientY: 5 });
      fireEvent.pointerMove(document, { clientX: 6, clientY: 6 });
      expect(canvas.classList.contains('banding')).toBe(false);
      fireEvent.pointerMove(document, { clientX: 300, clientY: 300 });
      expect(canvas.classList.contains('banding')).toBe(true);
      expect(canvas.classList.contains('gesture')).toBe(false);
      fireEvent.pointerUp(document, { clientX: 300, clientY: 300 });
      expect(canvas.classList.contains('banding')).toBe(false);
    });

    it('a Ctrl+drag on empty canvas draws no rectangle and picks nothing: it pans, the closed hand shown while Ctrl is held (the user, 2026-10-22)', async () => {
      const doc = await two();
      const onSelect = vi.fn();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} onSelect={onSelect} />);
      const canvas = container.querySelector('.studio-canvas')!;
      const pane = container.querySelector('.react-flow__pane')!;
      fireEvent.keyDown(document, { key: 'Control', ctrlKey: true });
      expect(canvas.classList.contains('ctrl-pan')).toBe(true);
      fireEvent.pointerDown(pane, { button: 0, clientX: -1e5, clientY: -1e5, ctrlKey: true });
      fireEvent.pointerMove(document, { clientX: 0, clientY: 0, ctrlKey: true });
      expect(container.ownerDocument.querySelector('.design-band')).toBeNull();
      fireEvent.pointerUp(document, { clientX: 1e5, clientY: 1e5, ctrlKey: true });
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.keyUp(document, { key: 'Control' });
      expect(canvas.classList.contains('ctrl-pan')).toBe(false);
    });

    it('blocks can be dragged in design mode only', async () => {
      const doc = await two();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf()} />);
      expect(container.querySelector('.react-flow__node[data-id="s1"]')!.classList.contains('draggable')).toBe(true);
      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} />);
      expect(container.querySelector('.react-flow__node[data-id="s1"]')!.classList.contains('draggable')).toBe(false);
    });

    it('arrow keys on the focused canvas nudge the picked blocks; Ctrl+Z undoes', async () => {
      const doc = await two();
      const design = designOf({ picks: [{ kind: 'node', id: 's2' }] });
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} />);
      const canvas = container.querySelector('.studio-canvas')!;
      fireEvent.keyDown(canvas, { key: 'ArrowUp' });
      const s2 = doc.placement.steps.get('s2')!;
      expect(design.onCommit).toHaveBeenCalledWith(expect.objectContaining({ steps: { s2: { x: s2.x, y: s2.y - 8 } } }), { merge: 'nudge' });
      fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
      expect(design.onUndo).toHaveBeenCalledTimes(1);
    });

    it('keys do nothing while a rectangle runs, and act again after its release', async () => {
      const doc = await two();
      const design = designOf({ picks: [{ kind: 'node', id: 's2' }] });
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
      const canvas = container.querySelector('.studio-canvas')!;
      const pane = container.querySelector('.react-flow__pane')!;
      fireEvent.pointerDown(pane, { button: 0, clientX: -1e5, clientY: -1e5 });
      fireEvent.pointerMove(document, { clientX: 0, clientY: 0 });
      fireEvent.keyDown(canvas, { key: 'ArrowUp' });
      fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
      expect(design.onCommit).not.toHaveBeenCalled();
      expect(design.onUndo).not.toHaveBeenCalled();
      fireEvent.pointerUp(document, { clientX: 1e5, clientY: 1e5 });
      fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
      expect(design.onUndo).toHaveBeenCalledTimes(1);
    });

    it('keys on the capsule toolbar drawn inside the canvas do not nudge', async () => {
      const doc = await two();
      const design = designOf({ picks: [{ kind: 'node', id: 's2' }] });
      render(
        <WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design}>
          <div className="docbar" role="toolbar" aria-label="Workflow"><button type="button">Save</button></div>
        </WorkflowCanvas>,
      );
      fireEvent.keyDown(screen.getByRole('button', { name: 'Save' }), { key: 'ArrowUp' });
      expect(design.onCommit).not.toHaveBeenCalled();
    });

    it('a rectangle with Shift adds to the picks, without it replaces them; a press that does not move is a click', async () => {
      const doc = await two();
      const onSelect = vi.fn();
      const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={designOf({ picks: [{ kind: 'wire', id: 'gone' }] })} onSelect={onSelect} />);
      const pane = container.querySelector('.react-flow__pane')!;
      fireEvent.pointerDown(pane, { button: 0, clientX: 5, clientY: 5 });
      fireEvent.pointerUp(document, { clientX: 6, clientY: 6 });
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.pointerDown(pane, { button: 0, clientX: -1e5, clientY: -1e5 });
      fireEvent.pointerMove(document, { clientX: 1e5, clientY: 1e5 });
      fireEvent.pointerUp(document, { clientX: 1e5, clientY: 1e5, shiftKey: true });
      expect(onSelect.mock.calls[0]![1][0]).toEqual({ kind: 'wire', id: 'gone' });
      expect(onSelect.mock.calls[0]![1]).toContainEqual({ kind: 'node', id: 's2' });
      fireEvent.pointerDown(pane, { button: 0, clientX: -1e5, clientY: -1e5 });
      fireEvent.pointerMove(document, { clientX: 1e5, clientY: 1e5 });
      fireEvent.pointerUp(document, { clientX: 1e5, clientY: 1e5 });
      expect(onSelect.mock.calls[1]![1]).not.toContainEqual({ kind: 'wire', id: 'gone' });
      expect(onSelect.mock.calls[1]![1]).toContainEqual({ kind: 'node', id: 's2' });
    });
  });

  it('draws a junction as a filled circle with no arrow head at that end; the host keeps its own (plan 9 §5)', async () => {
    const doc = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
    }));
    const draft = withCircuit(EMPTY_DRAFT, doc, setEnd(circuitOf(doc, EMPTY_DRAFT), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 40 }));
    const design: DesignProps = { draft, picks: [], onPick: vi.fn(), onCommit: vi.fn(), onUndo: vi.fn(), onRedo: vi.fn() };
    const { container } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} design={design} onSelect={vi.fn()} />);
    const edge = container.querySelector('[data-testid="rf__edge-s3->s4"]')!;
    expect(edge.querySelectorAll('circle.nx-joint')).toHaveLength(1);
    expect(edge.querySelectorAll('.nx-head')).toHaveLength(0);
    expect(edge.querySelectorAll('circle.nx-src')).toHaveLength(1);
    const host = container.querySelector('[data-testid="rf__edge-s1->s2"]')!;
    expect(host.querySelectorAll('.nx-head')).toHaveLength(1);
    expect(host.querySelectorAll('circle.nx-joint')).toHaveLength(0);
  });
});

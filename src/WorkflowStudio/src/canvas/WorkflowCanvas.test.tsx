import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadDocument } from '../app/loadDocument';
import { createTextFitter } from './fitText';
import { WorkflowCanvas } from './WorkflowCanvas';
import { ZoomControls } from './ZoomControls';

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
      validate: async () => ({ ok: true, value: { valid: true, problems: [] } }),
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
        validate: async () => ({ ok: true, value: { valid: true, problems: [] } }),
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
        validate: async () => ({ ok: true, value: { valid: true, problems: [] } }),
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

    it('shows no React Flow attribution badge (it would sit on the horizontal scroll bar)', async () => {
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

    it('fits a document whose saved view still followed Fit', async () => {
      render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} initialView={{ x: -100, y: 40, zoom: 1.5, followFit: true }}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).not.toHaveTextContent('150%'));
    });
  });
});

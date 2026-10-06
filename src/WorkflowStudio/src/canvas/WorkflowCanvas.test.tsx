import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadDocument } from '../app/loadDocument';
import { createTextFitter } from './fitText';
import { WorkflowCanvas } from './WorkflowCanvas';

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
});

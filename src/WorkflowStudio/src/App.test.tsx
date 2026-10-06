import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { workflowDto } from './api/fixtures';
import { App } from './App';
import * as fitText from './canvas/fitText';

vi.mock('./canvas/fitText', async (original) => {
  const actual = await original<typeof import('./canvas/fitText')>();
  return { ...actual, createTextFitter: vi.fn(actual.createTextFitter) };
});

const api = (over: Partial<StudioApi>): StudioApi => ({
  listWorkflows: vi.fn(), getGraph: vi.fn(), getStep: vi.fn(), getProcessor: vi.fn(),
  validate: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }), ...over,
} as StudioApi);

describe('App', () => {
  it('lists the workflows in the picker, sorted by name', async () => {
    render(<App api={api({
      listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [workflowDto({ id: 'w2', name: 'zeta' }), workflowDto({ id: 'w1', name: 'alpha' })] }),
    })} />);

    // The placeholder option is there from the first render, so wait for the list itself.
    await waitFor(() => {
      const options = screen.getAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual(['Open a workflow…', 'alpha 1.0.0', 'zeta 1.0.0']);
    });
  });

  it('shows a network failure in the status line', async () => {
    render(<App api={api({ listWorkflows: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } }) })} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Network error: Failed to fetch');
  });

  describe('fonts', () => {
    afterEach(() => { delete (document as { fonts?: unknown }).fonts; });

    it('requests every face the fitter measures with before it makes the fitter', async () => {
      const load = vi.fn().mockResolvedValue([]);
      Object.defineProperty(document, 'fonts', { configurable: true, value: { load, ready: Promise.resolve() } });
      vi.mocked(fitText.createTextFitter).mockClear();

      render(<App api={api({ listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [] }) })} />);

      await waitFor(() => expect(fitText.createTextFitter).toHaveBeenCalled());
      expect(load.mock.calls.map((c) => c[0]).sort()).toEqual([...fitText.MEASURED_FONTS].sort());
      const lastLoad = Math.max(...load.mock.invocationCallOrder);
      expect(lastLoad).toBeLessThan(vi.mocked(fitText.createTextFitter).mock.invocationCallOrder[0]!);
    });

    it('does not wait for a document that has no fonts API', async () => {
      vi.mocked(fitText.createTextFitter).mockClear();
      render(<App api={api({ listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [] }) })} />);
      await waitFor(() => expect(fitText.createTextFitter).toHaveBeenCalled());
    });
  });
});

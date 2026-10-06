import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { graphDto, stepDto, workflowDto } from './api/fixtures';
import { App } from './App';
import { memoryStorage } from './test/memoryStorage';

const ZETA = '11111111-2222-3333-4444-555555555555';
const ALPHA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

function fakeApi(over: Partial<StudioApi> = {}): StudioApi {
  return {
    listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [workflowDto({ id: ZETA, name: 'zeta' }), workflowDto({ id: ALPHA, name: 'alpha' })] }),
    getGraph: vi.fn().mockImplementation(async (id: string) => ({
      ok: true, value: graphDto({ workflow: workflowDto({ id, name: id === ALPHA ? 'alpha' : 'zeta' }), steps: [stepDto('s1', { name: 'fetch' })] }),
    })),
    getStep: vi.fn().mockResolvedValue(notFound),
    getProcessor: vi.fn().mockResolvedValue(notFound),
    getSchema: vi.fn().mockResolvedValue(notFound),
    listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    listLiveness: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    validate: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }),
    ...over,
  };
}


const openPicker = () => {
  fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Open workflow/ }));
};
const pickWorkflow = async (label: string) => {
  openPicker();
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(label) }));
};
const inspector = () => screen.getByText(/Open a workflow to inspect it|Nothing selected|STEP|WORKFLOW|Loading/, { selector: '.paneBody *' }).closest('.paneBody') as HTMLElement;

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { vi.restoreAllMocks(); });

describe('App', () => {
  it('lists the workflows in the picker by unique name, sorted', async () => {
    render(<App api={fakeApi()} storage={memoryStorage()} />);
    openPicker();
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent))
      .toEqual(['alpha_1.0.0-dddd-eeeeeeeeeeee', 'zeta_1.0.0-4444-555555555555']));
  });

  it('says in the picker why the list could not be read', async () => {
    render(<App api={fakeApi({ listWorkflows: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } }) })} storage={memoryStorage()} />);
    openPicker();
    expect(await screen.findByText('Workflows could not be listed. Network error: Failed to fetch')).toBeInTheDocument();
  });

  it('opens a workflow as a tab, fills the Inspector on a click, and clears it on Esc', async () => {
    render(<App api={fakeApi()} storage={memoryStorage()} />);
    await pickWorkflow('alpha');

    const step = await screen.findByText('fetch');
    expect(within(inspector()).getByText('Nothing selected. Click a step, a processor, a cache or the workflow.')).toBeInTheDocument();
    expect(screen.getByText('No problems')).toBeInTheDocument();

    fireEvent.click(step.closest('.react-flow__node')!);
    expect(within(inspector()).getByText('STEP')).toBeInTheDocument();
    expect(within(inspector()).getByLabelText('Unique name')).toHaveTextContent('fetch_1.0.0-s1');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(within(inspector()).getByText(/Nothing selected/)).toBeInTheDocument();
  });

  it('focuses the tab of a workflow that is already open instead of loading it again', async () => {
    const api = fakeApi();
    render(<App api={api} storage={memoryStorage()} />);
    await pickWorkflow('alpha');
    await screen.findByText('fetch');
    await pickWorkflow('zeta');
    await waitFor(() => expect(screen.getAllByText('fetch')).toHaveLength(2));

    openPicker();
    expect(await screen.findByRole('option', { name: /alpha.*open — switch/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /alpha/ }));

    expect(api.getGraph).toHaveBeenCalledTimes(2);
  });

  it('shows in its tab that a workflow no longer exists (review focus 2)', async () => {
    render(<App api={fakeApi({ getGraph: vi.fn().mockResolvedValue(notFound) })} storage={memoryStorage()} />);
    await pickWorkflow('zeta');
    expect(await screen.findByText('This workflow no longer exists.', { selector: '.doc-msg' })).toHaveAttribute('role', 'alert');
  });
  it('ignores a first load that lands after its document was closed and reopened', async () => {
    const pending: Array<(v: unknown) => void> = [];
    const graph = (name: string) => ({ ok: true, value: graphDto({ workflow: workflowDto({ id: ALPHA, name: 'alpha' }), steps: [stepDto('s1', { name })] }) });
    const getGraph = vi.fn().mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    render(<App api={fakeApi({ getGraph })} storage={memoryStorage()} />);

    await pickWorkflow('alpha');
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.keyDown(window, { key: 'w', altKey: true });
    await waitFor(() => expect(screen.queryByRole('tab', { name: /alpha/ })).not.toBeInTheDocument());
    await pickWorkflow('alpha');
    await waitFor(() => expect(pending).toHaveLength(2));

    pending[0]!(graph('stale'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('stale')).not.toBeInTheDocument();

    pending[1]!(graph('fresh'));
    expect(await screen.findByText('fresh')).toBeInTheDocument();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  it('hands the panels one api for the whole life of the page, so the live poll is not restarted by a re-render', async () => {
    const api = fakeApi();
    const { rerender } = render(<App api={api} storage={memoryStorage()} />);
    await pickWorkflow('alpha');
    const step = await screen.findByText('fetch');
    await waitFor(() => expect(api.listLive).toHaveBeenCalled());
    const polls = vi.mocked(api.listLive).mock.calls.length;

    fireEvent.click(step.closest('.react-flow__node')!);
    rerender(<App api={api} storage={memoryStorage()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.listLive).toHaveBeenCalledTimes(polls);
  });
});

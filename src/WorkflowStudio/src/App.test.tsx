import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { graphDto, stepDto, workflowDto } from './api/fixtures';
import { App } from './App';
import { SESSION_KEY } from './app/session';
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
    getEntity: vi.fn().mockResolvedValue(notFound),
    putEntity: vi.fn().mockResolvedValue(notFound),
    createAssignment: vi.fn().mockResolvedValue(notFound),
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

describe('session (plan 3d)', () => {
  const seeded = (session: unknown) => memoryStorage({ [SESSION_KEY]: JSON.stringify(session) });

  it('brings back the open documents, the active one and each selection after a reload', async () => {
    const api = fakeApi();
    const storage = seeded({
      version: 1, activeId: 'wf2', showDetails: false, dock: null,
      docs: [
        { workflowId: 'wf1', name: 'orders', version: '1.0.0', selection: { kind: 'workflow' }, view: null },
        { workflowId: 'wf2', name: 'billing', version: '2.0.0', selection: null, view: null },
      ],
    });
    render(<App api={api} storage={storage} />);
    expect(await screen.findAllByText('orders', { selector: '.doctab .nm' })).toHaveLength(1);
    expect(screen.getAllByText('billing', { selector: '.doctab .nm' })).toHaveLength(1);
    await waitFor(() => expect(api.getGraph).toHaveBeenCalledWith('wf1'));
    expect(api.getGraph).toHaveBeenCalledWith('wf2');

    // once the graphs load, wf1's restored selection is drawn on its canvas and wf2 (active) shows none
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node[data-id="wf"]')).toHaveLength(2));
    expect(document.querySelectorAll('.react-flow__node.studio-sel')).toHaveLength(1);
    expect(within(inspector()).getByText(/Nothing selected/)).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('orders', { selector: '.doctab .nm' }).closest('.dv-tab')!);
    await waitFor(() => expect(within(inspector()).getByText('WORKFLOW')).toBeInTheDocument());
  });

  it('keeps the restored active document active when the session has no dock, and the Inspector follows it', async () => {
    render(<App api={fakeApi()} storage={seeded({
      version: 1, activeId: 'wf1', showDetails: false, dock: null,
      docs: [
        { workflowId: 'wf1', name: 'orders', version: '1.0.0', selection: { kind: 'workflow' }, view: null },
        { workflowId: 'wf2', name: 'billing', version: '2.0.0', selection: null, view: null },
      ],
    })} />);
    const ordersTab = await screen.findByText('orders', { selector: '.doctab .nm' });
    await waitFor(() => expect(within(inspector()).getByText('WORKFLOW')).toBeInTheDocument());
    expect(ordersTab.closest('.dv-tab')).toHaveClass('dv-active-tab');
    expect(screen.getByText('billing', { selector: '.doctab .nm' }).closest('.dv-tab')).not.toHaveClass('dv-active-tab');
  });

  it('opens each restored document at its own view (review focus 5)', async () => {
    render(<App api={fakeApi()} storage={seeded({
      version: 1, activeId: 'wf1', showDetails: false, dock: null,
      docs: [
        { workflowId: 'wf1', name: 'orders', version: '1.0.0', selection: null, view: { x: -100, y: 40, zoom: 1.5, followFit: false } },
        { workflowId: 'wf2', name: 'billing', version: '2.0.0', selection: null, view: null },
      ],
    })} />);
    // each panel is found by its workflow: the sphere's unique name ends with the workflow id
    const transformOf = (workflowId: string) => {
      const panel = [...document.querySelectorAll('.docpanel')].find((p) => p.querySelector('.react-flow__node[data-id="wf"]')?.textContent?.includes(`-${workflowId}`))!;
      return (panel.querySelector('.react-flow__viewport') as HTMLElement).style.transform.replace(/,\s*/g, ', ');
    };
    await waitFor(() => expect(document.querySelectorAll('.react-flow__viewport')).toHaveLength(2));
    expect(transformOf('wf1')).toBe('translate(-100px, 40px) scale(1.5)');
    const restoredFresh = transformOf('wf2');
    cleanup();

    // the same document opened fresh, with no session: wf2 must sit exactly where Fit puts it (a new tab)
    render(<App api={fakeApi()} tabStorage={memoryStorage()} storage={seeded({
      version: 1, activeId: 'wf2', showDetails: false, dock: null,
      docs: [{ workflowId: 'wf2', name: 'billing', version: '2.0.0', selection: null, view: null }],
    })} />);
    await waitFor(() => expect(document.querySelectorAll('.react-flow__viewport')).toHaveLength(1));
    await waitFor(() => expect(transformOf('wf2')).not.toBe('translate(0px, 0px) scale(1)'));
    expect(restoredFresh).toBe(transformOf('wf2'));
  });

  it('keeps a document closed before the reload closed, and forgets its view (review focus 3)', async () => {
    const storage = memoryStorage();
    const { unmount } = render(<App api={fakeApi()} storage={storage} />);
    await pickWorkflow('alpha');
    await screen.findByText('fetch');
    fireEvent.click(screen.getByRole('button', { name: /Close alpha/ }));
    await waitFor(() => expect(screen.queryByText('fetch')).not.toBeInTheDocument());
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    const saved = JSON.parse(storage.getItem(SESSION_KEY)!);
    expect(saved.docs).toEqual([]);
    unmount();
  });

  it('fits a document reopened after it was closed, not at the view it had (review focus 3)', async () => {
    const storage = memoryStorage();
    render(<App api={fakeApi()} storage={storage} />);
    await pickWorkflow('alpha');
    await screen.findByText('fetch');
    const level = () => screen.getByLabelText('Zoom level').textContent;
    await waitFor(() => expect(level()).not.toBe('100%'));
    const fitted = level();
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await waitFor(() => expect(level()).not.toBe(fitted));
    // the zoom settles, and the saver writes the view 300 ms later
    await waitFor(() => expect(JSON.parse(storage.getItem(SESSION_KEY) ?? 'null')?.docs[0]?.view).toMatchObject({ followFit: false }));

    fireEvent.click(screen.getByRole('button', { name: /Close alpha/ }));
    await waitFor(() => expect(screen.queryByText('fetch')).not.toBeInTheDocument());
    await pickWorkflow('alpha');
    await screen.findByText('fetch');
    await waitFor(() => expect(level()).toBe(fitted));
  });

  it('writes the session at once when the page goes away (review focus 4)', async () => {
    const storage = memoryStorage();
    render(<App api={fakeApi()} storage={storage} />);
    await pickWorkflow('alpha');
    // nothing written yet: the saver's 300 ms have not passed, so only the pagehide flush can write it
    expect(JSON.parse(storage.getItem(SESSION_KEY) ?? '{"docs":[]}').docs).toHaveLength(0);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(JSON.parse(storage.getItem(SESSION_KEY)!).docs).toHaveLength(1);
  });

  it('keeps a session per tab: refreshing one tab never brings up what another tab has open (controller ruling)', async () => {
    const mirror = memoryStorage();
    const tabA = memoryStorage(), tabB = memoryStorage();
    const leave = async (unmount: () => void) => { await act(async () => { window.dispatchEvent(new Event('pagehide')); }); unmount(); };

    const a = render(<App api={fakeApi()} storage={mirror} tabStorage={tabA} />);
    await pickWorkflow('alpha');
    await leave(a.unmount);
    const b = render(<App api={fakeApi()} storage={mirror} tabStorage={tabB} />);
    // a new tab starts from the mirror (alpha, from tab A); it closes alpha and opens zeta
    expect(await screen.findAllByText('alpha', { selector: '.doctab .nm' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Close alpha/ }));
    await pickWorkflow('zeta');
    await screen.findAllByText('zeta', { selector: '.doctab .nm' });
    await leave(b.unmount);

    // tab A refreshes: its own session, not the one tab B wrote last
    render(<App api={fakeApi()} storage={mirror} tabStorage={tabA} />);
    expect(await screen.findAllByText('alpha', { selector: '.doctab .nm' })).toHaveLength(1);
    expect(screen.queryAllByText('zeta', { selector: '.doctab .nm' })).toHaveLength(0);
    // and the mirror holds the last write of any tab, to seed the next new tab
    await waitFor(() => expect(JSON.parse(mirror.getItem(SESSION_KEY)!).docs.map((d: { name: string }) => d.name)).toEqual(['alpha']));
  });

  it('starts as new when the stored session is broken (review focus 1)', () => {
    render(<App api={fakeApi()} storage={memoryStorage({ [SESSION_KEY]: '{oops' })} />);
    expect(screen.getByText('No workflow open')).toBeInTheDocument();
  });
});

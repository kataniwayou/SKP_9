import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { EMPTY_DRAFT } from '../design/draft';
import { LiveStoreProvider } from '../live/LiveContext';
import { createStudioStore, StudioStoreProvider, type StudioStore } from '../store/studioStore';
import { liveStub, type LiveStub } from '../test/liveStub';
import { DocumentPanel } from './DocumentPanel';
import { loadedDocument } from './fixtures';
import { useOwnerDocument, type PanelLike } from './panelHooks';

/** A stand-in for a dockview panel api: visible or not, in a given window, with events we fire. */
function fakePanel(visible = true, win: Window = window) {
  const location = new Set<() => void>(), visibility = new Set<(e: { isVisible: boolean }) => void>();
  let current = win;
  const panel = {
    getWindow: () => current,
    get isVisible() { return visible; },
    onDidLocationChange: (f: () => void) => { location.add(f); return { dispose: () => location.delete(f) }; },
    onDidVisibilityChange: (f: (e: { isVisible: boolean }) => void) => { visibility.add(f); return { dispose: () => visibility.delete(f) }; },
  } as unknown as PanelLike;
  return {
    panel,
    moveTo: (w: Window) => { current = w; location.forEach((f) => f()); },
    show: (v: boolean) => { visible = v; visibility.forEach((f) => f({ isVisible: v })); },
  };
}

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });


/** The panel in its providers: the studio store and the app's liveness store (2026-10-10). */
const inStores = (store: StudioStore, live: LiveStub, panel: React.ReactNode) =>
  <StudioStoreProvider value={store}><LiveStoreProvider value={live}><div style={{ width: 1200, height: 800 }}>{panel}</div></LiveStoreProvider></StudioStoreProvider>;
const running = (ids: string[], processors: Record<string, boolean> = {}) => { const l = liveStub(); l.known(ids, processors); return l; };

describe('useOwnerDocument', () => {
  it('follows the panel into a pop-out window', () => {
    const fake = fakePanel();
    const { result } = renderHook(() => useOwnerDocument(fake.panel));
    expect(result.current).toBe(document);
    const popout = document.implementation.createHTMLDocument('popout');
    act(() => fake.moveTo({ document: popout } as unknown as Window));
    expect(result.current).toBe(popout);
  });
});

describe('DocumentPanel', () => {
  async function setup(live: LiveStub = liveStub()) {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const fake = fakePanel();
    render(inStores(store, live, <DocumentPanel workflowId="wf1" panel={fake.panel} />));
    return { store, fake, live };
  }

  it('shows Loading…, then the canvas with its toolbar and status', async () => {
    const { store } = await setup(running(['WF1']));
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const doc = await loadedDocument(graphDto({ workflow: workflowDto({ cronExpression: '0 * * * * *' }), steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));

    expect(await screen.findByText('fetch')).toBeInTheDocument();
    expect(within(screen.getByRole('toolbar', { name: 'Workflow' })).getByText('⏱ 0 * * * * *')).toBeInTheDocument();
    expect(await screen.findByText('▶ running')).toBeInTheDocument();
    for (const name of ['⤓ Save', '▶ Start', '■ Stop']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: '▶ Start' }).parentElement).toHaveAttribute('data-tip', 'Not available yet');
  });

  it('Start and Stop are enabled running or stopped (idempotent, the user\'s rule 2026-10-10); a press shows starting… (2026-10-09)', async () => {
    const live = running(['wf1']);
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] })) });
    const onRun = vi.fn();
    render(inStores(store, live, <DocumentPanel workflowId="wf1" panel={fakePanel().panel} onRun={onRun} />));
    const start = () => screen.getByRole('button', { name: /Start/ });
    const stop = () => screen.getByRole('button', { name: /Stop/ });

    expect(await screen.findByText('▶ running')).toBeInTheDocument();
    expect(start()).toBeEnabled();
    expect(stop()).toBeEnabled();
    fireEvent.click(stop());
    expect(onRun).toHaveBeenCalledWith('stop');

    act(() => live.known([]));
    expect(await screen.findByText('■ stopped')).toBeInTheDocument();
    expect(start()).toBeEnabled();
    expect(start()).toHaveAttribute('data-tip', 'Start the saved workflow (what BaseApi holds, not the drawing) (F5)');
    expect(stop()).toBeEnabled();
    fireEvent.click(start());
    expect(onRun).toHaveBeenLastCalledWith('start');

    act(() => store.dispatch({ type: 'runRequested', workflowId: 'wf1', op: 'start', token: 't', at: '2026-10-09T09:00:00Z' }));
    expect(screen.getByText('starting…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ Starting…' })).toBeDisabled();
    expect(stop()).toBeDisabled();
  });

  it("a hidden tab follows the store too: its status, its hub and its processors' health change while it is hidden (2026-10-10)", async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch', processorId: 'p1' })] }));
    const { store, fake, live } = await setup(running([], { p1: true }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    expect(await screen.findByText('■ stopped')).toBeInTheDocument();
    const ring = () => document.querySelector('.nx-health')!.getAttribute('data-health');
    expect(ring()).toBe('healthy');

    act(() => fake.show(false));
    act(() => live.known(['wf1'], { p1: false }));
    expect(screen.getByText('▶ running')).toBeInTheDocument();
    expect(document.querySelector('.wf')!.getAttribute('data-started')).toBe('true');
    expect(ring()).toBe('unhealthy');
    act(() => live.known(['wf1'], {}));
    expect(ring()).toBe('undetermined');
  });

  it('shows status unknown, not stopped, when the store cannot say', async () => {
    const live = liveStub();
    live.unknown();
    const { store } = await setup(live);
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    expect(await screen.findByText('status unknown')).toBeInTheDocument();
    expect(screen.queryByText('■ stopped')).not.toBeInTheDocument();
    expect(document.querySelector('.wf')!.getAttribute('data-started')).toBe('false'); // review focus 3
    // the hub looks not started but states no verdict: its state inside the dial says status unknown too (spec §5.1)
    expect(document.querySelector('.wf .nx-state tspan')!.textContent).toBe('? status unknown');
    expect(document.querySelector('.nx-health')!.getAttribute('data-health')).toBe('undetermined');
  });

  it('shows checking… before the store has any answer', async () => {
    const { store } = await setup(liveStub());
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    expect(within(await screen.findByLabelText('Status')).getByText('checking…')).toBeInTheDocument();
  });

  it('shows the hub started when the store says the workflow runs', async () => {
    const { store } = await setup(running(['wf1']));
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    expect(await screen.findByText('▶ running')).toBeInTheDocument();
    expect(document.querySelector('.wf')!.getAttribute('data-started')).toBe('true');
  });

  it('shows why a document could not be opened (review focus 2: a workflow deleted since the list was read)', async () => {
    const { store } = await setup();
    act(() => store.dispatch({ type: 'failed', workflowId: 'wf1', message: 'This workflow no longer exists.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This workflow no longer exists.');
  });

  it('selects what is clicked and activates this document', async () => {
    const { store } = await setup();
    act(() => store.dispatch({ type: 'open', workflowId: 'other', name: 'x', version: '1' }));
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));

    fireEvent.click((await screen.findByText('fetch')).closest('.react-flow__node')!);

    expect(store.getState().activeId).toBe('wf1');
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's1' });
  });

  it('offers Retry on a failed document when given onRetry, and none without it', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'failed', workflowId: 'wf1', message: 'BaseApi unreachable' });
    const onRetry = vi.fn();
    const { rerender } = render(<StudioStoreProvider value={store}><DocumentPanel workflowId="wf1" panel={fakePanel().panel} /></StudioStoreProvider>);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    rerender(<StudioStoreProvider value={store}><DocumentPanel workflowId="wf1" panel={fakePanel().panel} onRetry={onRetry} /></StudioStoreProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent('BaseApi unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hands a click to onSelect when given, instead of selecting itself', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc });
    const live = running([]);
    const onSelect = vi.fn();
    render(inStores(store, live, <DocumentPanel workflowId="wf1" panel={fakePanel().panel} onSelect={onSelect} />));

    fireEvent.click((await screen.findByText('fetch')).closest('.react-flow__node')!);

    expect(onSelect).toHaveBeenCalledWith({ kind: 'step', stepId: 's1' }, document, [{ kind: 'node', id: 's1' }]);
    expect(store.getState().docs[0]!.selection).toBeNull();
    await screen.findByText('■ stopped');
  });

  it('draws the design: a step renamed in the Inspector shows its new name on the canvas (plan 8 §3.1)', async () => {
    const { store } = await setup();
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    await screen.findByText('fetch');
    act(() => {
      store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
      store.dispatch({ type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: stepDto('s1', { name: 'fetch' }) } });
      store.dispatch({ type: 'editField', workflowId: 'wf1', key: 'name', value: 'gather', copyId: 'x' });
    });
    expect(await screen.findByText('gather')).toBeInTheDocument();
  });
});

describe('DocumentPanel Save', () => {
  it('offers Save once the design differs from the base, and is read-only while it runs (plan 8 §4.1)', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] })) });
    const live = running([]);
    const onSave = vi.fn();
    render(inStores(store, live, <DocumentPanel workflowId="wf1" panel={fakePanel().panel} onSave={onSave} />));

    expect(await screen.findByRole('button', { name: '⤓ Save' })).toBeDisabled();
    act(() => store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } }));
    fireEvent.click(screen.getByRole('button', { name: '⤓ Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.studio-canvas')!.getAttribute('tabindex')).toBe('0');

    act(() => store.dispatch({ type: 'saving', workflowId: 'wf1' }));
    // a spinner replaces the ⤓ while the Save runs (2026-10-10); the button is busy and disabled
    const busy = screen.getByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.querySelector('.spin')).not.toBeNull();
    // read-only: the canvas is not in design mode while the answer is awaited
    expect(document.querySelector('.studio-canvas')!.getAttribute('tabindex')).toBeNull();
    await screen.findByText('■ stopped');
  });
});

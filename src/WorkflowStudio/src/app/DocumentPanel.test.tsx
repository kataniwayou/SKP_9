import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { EMPTY_DRAFT } from '../design/draft';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';
import { DocumentPanel } from './DocumentPanel';
import { loadedDocument } from './fixtures';
import { LIVE_POLL_MS, useLiveness, useLiveStatus, useOwnerDocument, usePanelVisible, type PanelLike } from './panelHooks';

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

describe('useLiveStatus', () => {
  it('polls every 5 s while visible, and not at all while hidden', async () => {
    vi.useFakeTimers();
    const listLive = vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] });
    const api = { listLive } as unknown as StudioApi;
    const { result, rerender } = renderHook(({ visible }) => useLiveStatus(api, 'wf1', visible), { initialProps: { visible: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).not.toHaveBeenCalled();
    expect(result.current).toBe('checking');

    rerender({ visible: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('running');
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * LIVE_POLL_MS); });
    expect(listLive).toHaveBeenCalledTimes(3);

    rerender({ visible: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).toHaveBeenCalledTimes(3);
  });

  it('says status unknown when the poll fails, even by throwing', async () => {
    const api = { listLive: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as StudioApi;
    const { result } = renderHook(() => useLiveStatus(api, 'wf1', true));
    await waitFor(() => expect(result.current).toBe('unknown'));
  });

  // Review focus 3, through the hook: each odd poll shape lands on the right status.
  it.each([
    ['an HTTP failure', { ok: false, error: { kind: 'http', status: 500, detail: 'Redis down' } }, 'unknown'],
    ['a body that is not an array', { ok: true, value: { live: ['wf1'] } }, 'unknown'],
    ['a null body', { ok: true, value: null }, 'unknown'],
    ['an upper-case id', { ok: true, value: ['WF1'] }, 'running'],
    ['entries that are not strings or GUIDs', { ok: true, value: [null, 7, { id: 'wf1' }, 'not-a-guid'] }, 'stopped'],
  ])('reads %s', async (_name, body, expected) => {
    const api = { listLive: vi.fn().mockResolvedValue(body) } as unknown as StudioApi;
    const { result } = renderHook(() => useLiveStatus(api, 'wf1', true));
    await waitFor(() => expect(result.current).toBe(expected));
  });

  it('keeps polling after a failed poll and recovers', async () => {
    vi.useFakeTimers();
    const listLive = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } })
      .mockResolvedValue({ ok: true, value: ['wf1'] });
    const api = { listLive } as unknown as StudioApi;
    const { result } = renderHook(() => useLiveStatus(api, 'wf1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('unknown');
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_POLL_MS); });
    expect(result.current).toBe('running');
  });
});

describe('useLiveness', () => {
  it('polls every 5 s while visible, returns the last answer, and null while hidden', async () => {
    vi.useFakeTimers();
    const answer = { ok: true, value: [{ processorId: 'p1', live: true }] };
    const listLiveness = vi.fn().mockResolvedValue(answer);
    const api = { listLiveness } as unknown as StudioApi;
    const { result, rerender } = renderHook(({ visible }) => useLiveness(api, visible), { initialProps: { visible: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual(answer);
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * LIVE_POLL_MS); });
    expect(listLiveness).toHaveBeenCalledTimes(3);

    rerender({ visible: false });
    expect(result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLiveness).toHaveBeenCalledTimes(3);
  });

  it('turns a thrown call into a network failure', async () => {
    const api = { listLiveness: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as StudioApi;
    const { result } = renderHook(() => useLiveness(api, true));
    await waitFor(() => expect(result.current).toEqual({ ok: false, error: { kind: 'network', message: 'Error: boom' } }));
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('usePanelVisible and polling (coverage added in fix round 1)', () => {
  /** A document whose visibilityState we control. */
  function controlledDocument() {
    const d = document.implementation.createHTMLDocument('w');
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(d, 'visibilityState', { get: () => state, configurable: true });
    return { doc: d, set: (v: DocumentVisibilityState) => { state = v; d.dispatchEvent(new Event('visibilitychange')); } };
  }
  const polling = (listLive: ReturnType<typeof vi.fn>, panel: PanelLike, doc: Document) => {
    const api = { listLive } as unknown as StudioApi;
    return renderHook(() => useLiveStatus(api, 'wf1', usePanelVisible(panel, doc)));
  };

  it('stops polling when the panel is hidden and resumes when it is shown again', async () => {
    vi.useFakeTimers();
    const listLive = vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] });
    const fake = fakePanel();
    polling(listLive, fake.panel, document);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listLive).toHaveBeenCalledTimes(1);

    act(() => fake.show(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).toHaveBeenCalledTimes(1);

    act(() => fake.show(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listLive).toHaveBeenCalledTimes(2);
  });

  it('stops polling while the owner document is hidden and resumes when it is visible again', async () => {
    vi.useFakeTimers();
    const listLive = vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] });
    const cd = controlledDocument();
    polling(listLive, fakePanel().panel, cd.doc);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listLive).toHaveBeenCalledTimes(1);

    act(() => cd.set('hidden'));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).toHaveBeenCalledTimes(1);

    act(() => cd.set('visible'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listLive).toHaveBeenCalledTimes(2);
  });

  it('does not poll at all when it starts hidden', async () => {
    vi.useFakeTimers();
    const listLive = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const cd = controlledDocument();
    cd.set('hidden');
    polling(listLive, fakePanel().panel, cd.doc);
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).not.toHaveBeenCalled();
  });

  it('resets to checking when hidden, so a re-shown tab never flashes the old status', async () => {
    const listLive = vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] });
    const api = { listLive } as unknown as StudioApi;
    const { result, rerender } = renderHook(({ visible }) => useLiveStatus(api, 'wf1', visible), { initialProps: { visible: true } });
    await waitFor(() => expect(result.current).toBe('running'));
    rerender({ visible: false });
    expect(result.current).toBe('checking');
  });

  it('ignores a response that arrives after unmount: no state change, no new poll, no warning', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deferred<unknown>();
    const listLive = vi.fn().mockReturnValue(d.promise);
    const api = { listLive } as unknown as StudioApi;
    const { result, unmount } = renderHook(() => useLiveStatus(api, 'wf1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { d.resolve({ ok: true, value: ['wf1'] }); await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(result.current).toBe('checking');
    expect(listLive).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('does not let a stale response win after hide and show while it was in flight', async () => {
    vi.useFakeTimers();
    const first = deferred<unknown>(), second = deferred<unknown>();
    const listLive = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const api = { listLive } as unknown as StudioApi;
    const { result, rerender } = renderHook(({ visible }) => useLiveStatus(api, 'wf1', visible), { initialProps: { visible: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    rerender({ visible: false });
    rerender({ visible: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listLive).toHaveBeenCalledTimes(2);

    await act(async () => { first.resolve({ ok: true, value: ['wf1'] }); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('checking');
    await act(async () => { second.resolve({ ok: true, value: [] }); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('stopped');
  });
});

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
  async function setup(listLive = vi.fn().mockResolvedValue({ ok: true, value: [] }), listLiveness = vi.fn().mockResolvedValue({ ok: true, value: [] })) {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const fake = fakePanel();
    const api = { listLive, listLiveness } as unknown as StudioApi;
    render(<StudioStoreProvider value={store}><div style={{ width: 1200, height: 800 }}><DocumentPanel api={api} workflowId="wf1" panel={fake.panel} /></div></StudioStoreProvider>);
    return { store, fake, listLive, listLiveness };
  }

  it('shows Loading…, then the canvas with its toolbar and status', async () => {
    const { store } = await setup(vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] }));
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const doc = await loadedDocument(graphDto({ workflow: workflowDto({ cronExpression: '0 * * * * *' }), steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));

    expect(await screen.findByText('fetch')).toBeInTheDocument();
    expect(within(screen.getByRole('toolbar', { name: 'Workflow' })).getByText('⏱ 0 * * * * *')).toBeInTheDocument();
    expect(await screen.findByText('▶ running')).toBeInTheDocument();
    for (const name of ['⤓ Save', '▶ Start', '■ Stop']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: '▶ Start' }).parentElement).toHaveAttribute('data-tip', 'Not available yet');
  });

  it('shows status unknown, not stopped, when the live poll fails', async () => {
    const { store } = await setup(vi.fn().mockResolvedValue({ ok: false, error: { kind: 'http', status: 500, detail: 'Redis down' } }));
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    expect(await screen.findByText('status unknown')).toBeInTheDocument();
    expect(screen.queryByText('■ stopped')).not.toBeInTheDocument();
    expect(document.querySelector('.wf')!.getAttribute('data-started')).toBe('false'); // review focus 3
    // the hub looks not started but states no verdict: its pill says status unknown too (spec §5.1)
    expect(document.querySelector('.wf .nx-state tspan')!.textContent).toBe('  ? status unknown');
  });

  it('shows the hub started when the live list names the workflow', async () => {
    const { store } = await setup(vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] }));
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    expect(await screen.findByText('▶ running')).toBeInTheDocument();
    expect(document.querySelector('.wf')!.getAttribute('data-started')).toBe('true');
  });

  it('does not poll while the document is loading or has failed', async () => {
    vi.useFakeTimers();
    const { store, listLive } = await setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).not.toHaveBeenCalled();
    act(() => store.dispatch({ type: 'failed', workflowId: 'wf1', message: 'gone' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).not.toHaveBeenCalled();
  });

  it('polls processor liveness beside the live status, and neither while loading or failed', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] })); // before the fake clock: the loader awaits real time
    vi.useFakeTimers();
    const { store, listLive, listLiveness } = await setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLiveness).not.toHaveBeenCalled();

    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listLiveness).toHaveBeenCalledTimes(1);
    expect(listLive).toHaveBeenCalledTimes(1);
  });

  it('stops polling liveness when its tab is hidden', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    vi.useFakeTimers();
    const { store, fake, listLiveness } = await setup();
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => fake.show(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLiveness).toHaveBeenCalledTimes(1);
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
    const api = { listLive: vi.fn(), listLiveness: vi.fn() } as unknown as StudioApi;
    const onRetry = vi.fn();
    const { rerender } = render(<StudioStoreProvider value={store}><DocumentPanel api={api} workflowId="wf1" panel={fakePanel().panel} /></StudioStoreProvider>);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    rerender(<StudioStoreProvider value={store}><DocumentPanel api={api} workflowId="wf1" panel={fakePanel().panel} onRetry={onRetry} /></StudioStoreProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent('BaseApi unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hands a click to onSelect when given, instead of selecting itself', async () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    store.dispatch({ type: 'loaded', workflowId: 'wf1', doc });
    const api = { listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }), listLiveness: vi.fn().mockResolvedValue({ ok: true, value: [] }) } as unknown as StudioApi;
    const onSelect = vi.fn();
    render(<StudioStoreProvider value={store}><div style={{ width: 1200, height: 800 }}>
      <DocumentPanel api={api} workflowId="wf1" panel={fakePanel().panel} onSelect={onSelect} />
    </div></StudioStoreProvider>);

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
    const api = { listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }), listLiveness: vi.fn().mockResolvedValue({ ok: true, value: [] }) } as unknown as StudioApi;
    const onSave = vi.fn();
    render(<StudioStoreProvider value={store}><div style={{ width: 1200, height: 800 }}>
      <DocumentPanel api={api} workflowId="wf1" panel={fakePanel().panel} onSave={onSave} />
    </div></StudioStoreProvider>);

    expect(await screen.findByRole('button', { name: '⤓ Save' })).toBeDisabled();
    act(() => store.dispatch({ type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, sphere: { x: 400, y: 400 } } }));
    fireEvent.click(screen.getByRole('button', { name: '⤓ Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.studio-canvas')!.getAttribute('tabindex')).toBe('0');

    act(() => store.dispatch({ type: 'saving', workflowId: 'wf1' }));
    expect(screen.getByRole('button', { name: '⤓ Saving…' })).toBeDisabled();
    // read-only: the canvas is not in design mode while the answer is awaited
    expect(document.querySelector('.studio-canvas')!.getAttribute('tabindex')).toBeNull();
    await screen.findByText('■ stopped');
  });
});

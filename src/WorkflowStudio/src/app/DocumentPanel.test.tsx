import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';
import { DocumentPanel } from './DocumentPanel';
import { loadedDocument } from './fixtures';
import { LIVE_POLL_MS, useLiveStatus, useOwnerDocument, type PanelLike } from './panelHooks';

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
  async function setup(listLive = vi.fn().mockResolvedValue({ ok: true, value: [] })) {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const fake = fakePanel();
    const api = { listLive } as unknown as StudioApi;
    render(<StudioStoreProvider value={store}><div style={{ width: 1200, height: 800 }}><DocumentPanel api={api} workflowId="wf1" panel={fake.panel} /></div></StudioStoreProvider>);
    return { store, fake, listLive };
  }

  it('shows Loading…, then the canvas with its toolbar and status', async () => {
    const { store } = await setup(vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] }));
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const doc = await loadedDocument(graphDto({ workflow: workflowDto({ cronExpression: '0 * * * * *' }), steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));

    expect(await screen.findByText('fetch')).toBeInTheDocument();
    expect(screen.getByText('⏱ 0 * * * * *')).toBeInTheDocument();
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
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { workflowDto } from './api/fixtures';
import { App, LIVE_MARK_DELAY_MS } from './App';
import { fakeHub, snap } from './test/fakeHub';
import { memoryStorage } from './test/memoryStorage';

// Live push (2026-10-10): one liveness store for the app, fed by the hub; Output logs workflow changes for every
// workflow; the picker marks running workflows; the status area says when live updates are reconnecting.

const ZETA = '11111111-2222-3333-4444-555555555555';
const ALPHA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STRANGER = 'ffffffff-0000-0000-0000-000000000001';
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

function fakeApi(): StudioApi {
  return {
    listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [workflowDto({ id: ZETA, name: 'zeta' }), workflowDto({ id: ALPHA, name: 'alpha' })] }),
    getGraph: vi.fn().mockResolvedValue(notFound),
    getStep: vi.fn().mockResolvedValue(notFound),
    getProcessor: vi.fn().mockResolvedValue(notFound),
    getSchema: vi.fn().mockResolvedValue(notFound),
    getEntity: vi.fn().mockResolvedValue(notFound),
    putEntity: vi.fn().mockResolvedValue(notFound),
    createAssignment: vi.fn().mockResolvedValue(notFound),
    deleteAssignment: vi.fn().mockResolvedValue(notFound),
    saveDesign: vi.fn().mockResolvedValue(notFound),
    startWorkflow: vi.fn().mockResolvedValue(notFound),
    stopWorkflow: vi.fn().mockResolvedValue(notFound),
    listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    listLiveness: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  };
}

/** The App with a fake hub, connected, its first snapshot answered with `running`. */
async function connectedApp(running: string[] = []) {
  const hub = fakeHub();
  const api = fakeApi();
  vi.mocked(api.listLive).mockResolvedValue({ ok: true, value: running });
  render(<App api={api} storage={memoryStorage()} hub={hub.factory} />);
  await act(async () => { hub.last().starting.resolve(); });
  await act(async () => { hub.last().snapshots.shift()!.resolve(snap(1, running)); });
  await waitFor(() => expect(api.listWorkflows).toHaveBeenCalled());
  return { hub, api };
}

const logLines = () => [...document.querySelectorAll('[role="log"] .outl')].map((l) => l.textContent!.replace(/^\S+\s+/, ''));
const openPicker = () => {
  fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Open workflow/ }));
};

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { vi.restoreAllMocks(); });

describe('live push in the studio (2026-10-10)', () => {
  it('Output logs every workflow that starts or stops by its name, open or not; never a processor; the first answer is no change', async () => {
    const { hub, api } = await connectedApp([ZETA]);
    expect(logLines()).toEqual([]);

    act(() => hub.last().emit('workflowLive', { workflowId: ALPHA, running: true, sequence: 2 }));
    act(() => hub.last().emit('processorLiveness', { processorId: 'p1', live: false, healthy: 0, replicas: 1, reason: 'stale', removed: false, sequence: 3 }));
    act(() => hub.last().emit('workflowLive', { workflowId: ZETA, running: false, sequence: 4 }));
    expect(logLines()).toEqual(['alpha running', 'zeta stopped']);

    // a workflow the list does not know yet: named by its id, and the list is read again
    const reads = vi.mocked(api.listWorkflows).mock.calls.length;
    act(() => hub.last().emit('workflowLive', { workflowId: STRANGER, running: true, sequence: 5 }));
    expect(logLines().at(-1)).toBe(`${STRANGER} running`);
    await waitFor(() => expect(api.listWorkflows).toHaveBeenCalledTimes(reads + 1));
  });

  it('the picker shows a running dot, read as "running", next to running workflows only', async () => {
    const { hub } = await connectedApp([ZETA]);
    openPicker();
    const zeta = await screen.findByRole('option', { name: /zeta/ });
    const alpha = screen.getByRole('option', { name: /alpha/ });
    expect(within(zeta).getByRole('img', { name: 'running' })).toBeInTheDocument();
    expect(zeta).toHaveAccessibleName(/running/);
    expect(within(alpha).queryByRole('img', { name: 'running' })).toBeNull();

    act(() => hub.last().emit('workflowLive', { workflowId: ALPHA, running: true, sequence: 2 }));
    expect(within(screen.getByRole('option', { name: /alpha/ })).getByRole('img', { name: 'running' })).toBeInTheDocument();
  });

  it('while the hub is not connected the status area says live updates are reconnecting and the app polls; connected again, the mark goes', async () => {
    const hub = fakeHub();
    const api = fakeApi();
    vi.mocked(api.listLive).mockResolvedValue({ ok: true, value: [ZETA] });
    render(<App api={api} storage={memoryStorage()} hub={hub.factory} />);
    expect(screen.queryByRole('status', { name: 'Live updates' })).toBeNull();   // still connecting at start: no mark yet
    await act(async () => { hub.last().starting.reject(new Error('refused')); });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Live updates' })).toHaveTextContent('live updates reconnecting'), { timeout: LIVE_MARK_DELAY_MS + 2000 });
    expect(api.listLive).toHaveBeenCalled();
    openPicker();
    expect(within(await screen.findByRole('option', { name: /zeta/ })).getByRole('img', { name: 'running' })).toBeInTheDocument();   // from the poll
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    // a retry connects; its snapshot replaces what the poll said
    await waitFor(() => expect(hub.conns.length).toBeGreaterThan(1), { timeout: 3000 });
    await act(async () => { hub.last().starting.resolve(); });
    await act(async () => { hub.last().snapshots.shift()!.resolve(snap(9, [])); });
    expect(screen.queryByRole('status', { name: 'Live updates' })).toBeNull();
    expect(logLines()).toEqual(['zeta stopped']);
  });

  it('without a hub (a test api) the app polls the two GET endpoints, once for the whole app', async () => {
    const api = fakeApi();
    render(<App api={api} storage={memoryStorage()} />);
    await waitFor(() => expect(api.listLive).toHaveBeenCalledTimes(1));
    expect(api.listLiveness).toHaveBeenCalledTimes(1);
  });

  it("a drop that reconnects within a few seconds shows no mark (a background tab's throttled keep-alive, 2026-10-10)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { hub } = await connectedApp();
      act(() => hub.last().lose());
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_MARK_DELAY_MS - 500); });
      expect(screen.queryByRole('status', { name: 'Live updates' })).toBeNull();
      act(() => hub.last().regain());
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_MARK_DELAY_MS * 2); });
      expect(screen.queryByRole('status', { name: 'Live updates' })).toBeNull();

      // down for longer: the mark shows, and goes as soon as it is back
      act(() => hub.last().lose());
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_MARK_DELAY_MS); });
      expect(screen.getByRole('status', { name: 'Live updates' })).toHaveTextContent('live updates reconnecting');
      act(() => hub.last().regain());
      expect(screen.queryByRole('status', { name: 'Live updates' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

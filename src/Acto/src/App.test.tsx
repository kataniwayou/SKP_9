import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { StudioApi } from './api/client';
import { processorDto } from './api/fixtures';
import { fakeApi, graphWith, wf } from './board/testApi';
import { liveStub } from './test/liveStub';
import { memoryStorage } from './test/memoryStorage';

function renderApp(api: StudioApi, storage: Storage = memoryStorage()) {
  return render(<App api={api} live={liveStub()} storage={storage} />);
}

describe('App', () => {
  it('loads the board and reports a differing first step', async () => {
    renderApp(fakeApi({ workflows: [wf('w1')], graph: graphWith({ entry: ['a', 'b'], steps: { a: ['b'], b: [] } }) }));
    expect(await screen.findByText(/Board loaded: 1 workflows?/)).toBeInTheDocument();
    expect(screen.getByText(/b-name stops being a first step/)).toBeInTheDocument();
    expect(await screen.findByText('first steps differ')).toBeInTheDocument();
  });
  it('reports a workflow that could not load', async () => {
    renderApp(fakeApi({ workflows: [wf('w1'), wf('w2')], graphError: { w2: { kind: 'http', status: 500, detail: 'boom' } } }));
    expect(await screen.findByText('Could not load w2-name: boom')).toBeInTheDocument();
    expect(screen.getByText(/Board loaded: 1 workflows?/)).toBeInTheDocument();
  });
  it('logs instead of crashing when the workflow list itself throws', async () => {
    const api = fakeApi();
    (api.listWorkflows as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    renderApp(api);
    expect(await screen.findByText('Could not load the board: offline')).toBeInTheDocument();
  });
  it('shows Acto in the top bar, the processors in the toolbox, and the selection in the inspector', async () => {
    const api = { ...fakeApi({ workflows: [wf('w1')] }), listProcessors: vi.fn().mockResolvedValue({ ok: true, value: [processorDto('p1', { name: 'Cruncher' })] }) } as StudioApi;
    renderApp(api);
    expect(screen.getByText('Acto')).toBeInTheDocument();
    expect(await screen.findByText('Cruncher')).toBeInTheDocument();
    expect(await screen.findByText('Board: 1 workflows, 0 running')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('s1-name'));
    expect(await screen.findByText('Entry condition')).toBeInTheDocument();
  });
  it('restores a saved selection and drops one that no longer exists', async () => {
    const st = memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: { kind: 'workflow', workflowId: 'w1' } }) });
    const { unmount } = renderApp(fakeApi({ workflows: [wf('w1')] }), st);
    expect(await screen.findByText('Steps')).toBeInTheDocument();
    unmount();
    const st2 = memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: { kind: 'workflow', workflowId: 'gone' } }) });
    renderApp(fakeApi({ workflows: [wf('w1')] }), st2);
    expect(await screen.findByText('Board: 1 workflows, 0 running')).toBeInTheDocument();
  });
});

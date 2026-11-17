import { fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(await screen.findByText('Board loaded: 1 workflow')).toBeInTheDocument();
    expect(screen.getByText(/b-name stops being a first step/)).toBeInTheDocument();
    expect(await screen.findByText('first steps differ')).toBeInTheDocument();
  });
  it('reports a workflow that could not load', async () => {
    renderApp(fakeApi({ workflows: [wf('w1'), wf('w2')], graphError: { w2: { kind: 'http', status: 500, detail: 'boom' } } }));
    expect(await screen.findByText('Could not load w2-name: 500: boom')).toBeInTheDocument();
    expect(screen.getByText('Board loaded: 1 workflow')).toBeInTheDocument();
  });
  it('logs instead of crashing when the workflow list itself throws', async () => {
    const api = fakeApi();
    (api.listWorkflows as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    renderApp(api);
    expect(await screen.findByText('Could not load the board: offline')).toBeInTheDocument();
    expect(screen.queryByText(/Board loaded/)).toBeNull();
    expect(screen.queryByText('Loading the board…')).toBeNull();
  });
  it('logs an error, not success, when the workflow list fails', async () => {
    const api = fakeApi();
    (api.listWorkflows as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: { kind: 'http', status: 503, detail: 'unavailable' } });
    renderApp(api);
    expect(await screen.findByText('Could not load the workflow list: 503: unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Board loaded/)).toBeNull();
    expect(screen.queryByText('Loading the board…')).toBeNull();
  });
  it('shows Acto in the top bar, the processors in the toolbox, and the selection in the inspector', async () => {
    const api = { ...fakeApi({ workflows: [wf('w1')] }), listProcessors: vi.fn().mockResolvedValue({ ok: true, value: [processorDto('p1', { name: 'Cruncher' })] }) } as StudioApi;
    renderApp(api);
    expect(screen.getByText('Acto')).toBeInTheDocument();
    expect(await screen.findByText('Cruncher')).toBeInTheDocument();
    expect(await screen.findByText('Board: 1 workflow, 0 running')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('s1-name'));
    expect(await screen.findByText(/Entry condition/)).toBeInTheDocument();
  });
  const saved = (selection: unknown) => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection }) });
  const inspector = () => within(document.querySelector('[data-panel="inspector"]') as HTMLElement);

  it('restores a saved selection into the inspector', async () => {
    renderApp(fakeApi({ workflows: [wf('w1')] }), saved({ kind: 'workflow', workflowId: 'w1' }));
    expect(await inspector().findByText('Wires')).toBeInTheDocument();
    expect(inspector().getByDisplayValue('w1-name')).toBeInTheDocument();
    expect(inspector().queryByText(/^Board:/)).toBeNull();
  });
  it.each([
    ['a workflow that is not loaded', { kind: 'workflow', workflowId: 'gone' }],
    ['a step that no longer exists', { kind: 'step', workflowId: 'w1', stepId: 'zz' }],
  ])('drops a saved selection naming %s', async (_, selection) => {
    renderApp(fakeApi({ workflows: [wf('w1')] }), saved(selection));
    expect(await inspector().findByText('Board: 1 workflow, 0 running')).toBeInTheDocument();
    expect(inspector().queryByText('Wires')).toBeNull();
    expect(inspector().queryByText(/Entry condition/)).toBeNull();
  });

  describe('undo/redo keys', () => {
    const selectedStep = saved({ kind: 'step', workflowId: 'w1', stepId: 's1' });
    const edit = async () => {
      renderApp(fakeApi({ workflows: [wf('w1')] }), selectedStep);
      const input = await inspector().findByDisplayValue('s1-name');
      fireEvent.change(input, { target: { value: 's1-x' } });
      return input;
    };
    it('Ctrl+Z undoes and Ctrl+Y redoes the selected workflow', async () => {
      await edit();
      expect(inspector().getByDisplayValue('s1-x')).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      expect(inspector().getByDisplayValue('s1-name')).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
      expect(inspector().getByDisplayValue('s1-x')).toBeInTheDocument();
    });
    it('leaves Ctrl+Z to a focused input', async () => {
      const input = await edit();
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
      expect(inspector().getByDisplayValue('s1-x')).toBeInTheDocument();
    });
    it('does nothing with no selection', async () => {
      renderApp(fakeApi({ workflows: [wf('w1')] }));
      await inspector().findByText('Board: 1 workflow, 0 running');
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      expect(inspector().getByText('Board: 1 workflow, 0 running')).toBeInTheDocument();
    });
    it('keeps Undo/Redo out of the top bar', async () => {
      renderApp(fakeApi({ workflows: [wf('w1')] }), selectedStep);
      await inspector().findByDisplayValue('s1-name');
      expect(document.querySelector('.topbar')!.querySelectorAll('button')).toHaveLength(0);
      expect(inspector().getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });
  });
});

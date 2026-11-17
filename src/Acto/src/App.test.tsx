import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
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

  describe('picks', () => {
    const two = () => fakeApi({ workflows: [wf('w1')], graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) });
    const card = (n: string) => screen.getByText(n, { selector: '.sn' });
    const view = () => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: null }) });
    it('a plain click replaces the picks and Ctrl+click toggles', async () => {
      renderApp(two(), view());
      fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
      expect(await inspector().findByDisplayValue('a-name')).toBeInTheDocument();
      fireEvent.click(card('b-name'), { ctrlKey: true });
      expect(await inspector().findByText('2 selected')).toBeInTheDocument();
      fireEvent.click(card('b-name'), { ctrlKey: true });
      expect(await inspector().findByDisplayValue('a-name')).toBeInTheDocument();
      fireEvent.click(card('a-name'), { ctrlKey: true });
      fireEvent.click(card('b-name'), { ctrlKey: true });
      fireEvent.click(card('b-name'));
      expect(await inspector().findByDisplayValue('b-name')).toBeInTheDocument();
      expect(inspector().queryByText(/selected/)).toBeNull();
    });
    it('moving one of two picked steps keeps both picks', async () => {
      renderApp(two(), view());
      fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
      fireEvent.click(card('b-name'), { ctrlKey: true });
      await inspector().findByText('2 selected');
      const node = card('a-name').closest('.react-flow__node') as HTMLElement;
      const mouse = (target: Element | Window, type: 'mousedown' | 'mousemove' | 'mouseup', x: number, y: number) => {
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
        Object.defineProperty(ev, 'view', { value: window }); // d3-drag reads event.view, which jsdom leaves null
        fireEvent(target, ev);
      };
      mouse(node, 'mousedown', 100, 100);
      mouse(window, 'mousemove', 140, 130);
      mouse(window, 'mouseup', 140, 130);
      expect(await inspector().findByText('2 selected')).toBeInTheDocument();
      // jsdom measures nothing, so d3-drag moves no node here: the committed multi-node path is covered by
      // BoardEdit.test (one moveMany per workflow) and boardStore.test (one undo restores every step)
    });
    it('keyboard selection (Enter on a focused node) reaches the inspector', async () => {
      renderApp(two(), view());
      const node = (await screen.findByText('a-name', { selector: '.sn' })).closest('.react-flow__node') as HTMLElement;
      node.focus();
      fireEvent.keyDown(node, { key: 'Enter' });
      expect(await inspector().findByDisplayValue('a-name')).toBeInTheDocument();
    });
    it('a picked step that is undone away drops out of the picks', async () => {
      const api = { ...fakeApi({ workflows: [wf('w1')] }), listProcessors: vi.fn().mockResolvedValue({ ok: true, value: [processorDto('p1', { name: 'Cruncher' })] }) } as StudioApi;
      renderApp(api, view());
      await screen.findByText('s1-name');
      await screen.findAllByText('Cruncher');
      const before = document.querySelectorAll('.react-flow__node-step').length;
      fireEvent.click(screen.getByText('w1-name', { selector: '.nm' }));
      await inspector().findByDisplayValue('w1-name');
      const drop = createEvent.drop(document.querySelector('.react-flow')!, { dataTransfer: { getData: () => JSON.stringify({ kind: 'step', processorId: 'p1' }) } });
      Object.defineProperties(drop, { clientX: { value: 350 }, clientY: { value: 150 } }); // jsdom has no DragEvent, so no coordinates
      fireEvent(document.querySelector('.react-flow')!, drop);
      await vi.waitFor(() => expect(document.querySelectorAll('.react-flow__node-step').length).toBe(before + 1));
      const added = [...document.querySelectorAll('.react-flow__node-step')].find((n) => !n.textContent?.includes('s1-name')) as HTMLElement;
      fireEvent.click(added.querySelector('.sn')!);
      await inspector().findByText('Entry condition · colours every wire into this step');
      fireEvent.click(screen.getByText('w1-name', { selector: '.nm' }), { ctrlKey: true });
      await inspector().findByText('2 selected');
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await vi.waitFor(() => expect(document.querySelectorAll('.react-flow__node-step').length).toBe(before));
      expect(await inspector().findByDisplayValue('w1-name')).toBeInTheDocument();
      expect(inspector().queryByText(/selected/)).toBeNull();
    });
  });

  describe('copy and paste', () => {
    const two = () => fakeApi({ workflows: [wf('w1')], graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) });
    const view = () => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: null }) });
    const mount = (api: StudioApi, session: Storage) => render(<App api={api} live={liveStub()} storage={view()} session={session} />);
    const cards = () => document.querySelectorAll('.react-flow__node-step').length;
    const clipOf = (n: number) => JSON.stringify({
      steps: Array.from({ length: n }, (_, i) => ({ id: `x${i}`, name: `x${i}-name`, version: '1.0.0', description: null, entryCondition: 1, processorId: null, at: { x: 40 + i * 300, y: 200 }, payload: null })),
      wires: n === 2 ? [['x0', 'x1']] : [], pasted: 0,
    });

    it('Copy on a step toolbar says what was copied, and Ctrl+V pastes beside it as one undo step', async () => {
      const session = memoryStorage();
      mount(two(), session);
      fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
      fireEvent.click(screen.getByText('Copy'));
      expect(await screen.findByText('Copied 1 step')).toBeInTheDocument();
      expect(JSON.parse(session.getItem('acto.clip')!).steps).toHaveLength(1);
      expect(cards()).toBe(2);
      fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
      await vi.waitFor(() => expect(cards()).toBe(3));
      expect(await inspector().findByDisplayValue('a-name-2')).toBeInTheDocument();
      expect(JSON.parse(session.getItem('acto.clip')!).pasted).toBe(1);
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await vi.waitFor(() => expect(cards()).toBe(2));
    });
    it('Ctrl+V with a workflow picked adds every clip step at once, picks them, and counts the pastes', async () => {
      const session = memoryStorage({ 'acto.clip': clipOf(2) });
      mount(two(), session);
      fireEvent.click(await screen.findByText('w1-name', { selector: '.nm' }));
      fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
      await vi.waitFor(() => expect(cards()).toBe(4));
      expect(await inspector().findByText('2 selected')).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
      await vi.waitFor(() => expect(cards()).toBe(6));
      expect(JSON.parse(session.getItem('acto.clip')!).pasted).toBe(2);
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await vi.waitFor(() => expect(cards()).toBe(4));
    });
    it('says what is missing', async () => {
      mount(two(), memoryStorage({ 'acto.clip': clipOf(1) }));
      await screen.findByText('a-name', { selector: '.sn' });
      fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
      expect(await screen.findByText('Select a workflow to paste into')).toBeInTheDocument();
    });
    it('says when nothing was copied', async () => {
      mount(two(), memoryStorage());
      fireEvent.click(await screen.findByText('w1-name', { selector: '.nm' }));
      fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
      expect(await screen.findByText('Nothing copied yet')).toBeInTheDocument();
      expect(cards()).toBe(2);
    });
    it('ignores Ctrl+V while typing in a field', async () => {
      mount(two(), memoryStorage({ 'acto.clip': clipOf(1) }));
      fireEvent.click(await screen.findByText('w1-name', { selector: '.nm' }));
      const input = await inspector().findByDisplayValue('w1-name');
      fireEvent.keyDown(input, { key: 'v', ctrlKey: true });
      expect(cards()).toBe(2);
    });
  });
});

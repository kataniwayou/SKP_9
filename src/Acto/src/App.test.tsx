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
  it('shows the board as soon as the first workflow arrives, while another is still loading', async () => {
    const api = fakeApi({ workflows: [wf('w1'), wf('w2')] });
    const get = api.getGraph;
    let release: () => void = () => {};
    api.getGraph = ((id: string) => id === 'w2' ? new Promise((res) => { release = () => res(get(id)); }) : get(id)) as typeof api.getGraph;
    renderApp(api);
    expect(await screen.findByTestId('rf__node-wf:w1')).toBeInTheDocument();
    expect(document.querySelector('.board-wait')).toBeNull(); // the board's own wait line (the chat says it too, until the last arrives)
    expect(screen.queryByText(/Board loaded/)).toBeNull();
    release();
    expect(await screen.findByText('Board loaded: 2 workflows')).toBeInTheDocument();
  });
  it('shows the others and logs the failure when one graph read fails', async () => {
    renderApp(fakeApi({ workflows: [wf('w1'), wf('w2')], graphError: { w2: { kind: 'http', status: 500, detail: 'boom' } } }));
    expect(await screen.findByTestId('rf__node-wf:w1')).toBeInTheDocument();
    expect(await screen.findByText('Could not load w2-name: 500: boom')).toBeInTheDocument();
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
    expect(document.querySelector('.topbar .brand')).toHaveTextContent(/^Acto$/);
    expect(await screen.findByText('Cruncher')).toBeInTheDocument();
    expect(await screen.findByText('Board: 1 workflow, 0 running')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('s1-name'));
    expect(await screen.findByText(/Entry condition/)).toBeInTheDocument();
  });
  const saved = (selection: unknown) => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection }) });
  const inspector = () => within(document.querySelector('[data-panel="inspector"]') as HTMLElement);

  it('re-lists the processors for the toolbox after saving a processor change', async () => {
    const listProcessors = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: [processorDto('p1', { name: 'Cruncher' })] })
      .mockResolvedValue({ ok: true, value: [processorDto('p1', { name: 'Crunched' })] });
    const api = {
      ...fakeApi({ workflows: [wf('w1')] }), listProcessors,
      saveDesign: vi.fn().mockResolvedValue({ ok: true, value: { applied: true, errors: [] } }),
      validateWorkflow: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }),
    } as StudioApi;
    renderApp(api, saved({ kind: 'step', workflowId: 'w1', stepId: 's1' }));
    expect(await screen.findByText('Cruncher')).toBeInTheDocument();
    fireEvent.change(await inspector().findByLabelText('Processor name'), { target: { value: 'Crunched' } });
    fireEvent.click(document.querySelector('.react-flow__node-workflow') as HTMLElement);
    fireEvent.click(await screen.findByText('Save'));
    expect(await screen.findByText('w1-name saved')).toBeInTheDocument();
    const toolbox = within(document.querySelector('[data-panel="toolbox"]') as HTMLElement);
    expect(await toolbox.findByText('Crunched')).toBeInTheDocument();
    expect(toolbox.queryByText('Cruncher')).toBeNull();
    expect(listProcessors).toHaveBeenCalledTimes(2);
  });
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
      expect([...document.querySelector('.topbar')!.querySelectorAll('button')].map((x) => x.textContent)).toEqual(['Dark']);
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
    it('a workflow made and picked while the board is still loading stays picked once it has loaded (S2)', async () => {
      const api = fakeApi({ workflows: [wf('w1'), wf('w2')] });
      const get = api.getGraph;
      let release: () => void = () => {};
      api.getGraph = ((id: string) => (id === 'w2' ? new Promise((res) => { release = () => res(get(id)); }) : get(id))) as typeof api.getGraph;
      renderApp(api, view());
      await screen.findByText('s1-name');
      const drop = createEvent.drop(document.querySelector('.react-flow')!, { dataTransfer: { getData: () => JSON.stringify({ kind: 'workflow' }) } });
      Object.defineProperties(drop, { clientX: { value: 3000 }, clientY: { value: 3000 } }); // far from w1: a new workflow
      fireEvent(document.querySelector('.react-flow')!, drop);
      expect(await inspector().findByDisplayValue('new-workflow-1')).toBeInTheDocument();
      release();
      expect(await screen.findByText('Board loaded: 2 workflows')).toBeInTheDocument();
      expect(inspector().getByDisplayValue('new-workflow-1')).toBeInTheDocument();
    });
  });

  describe('arrow nudges', () => {
    const two = () => fakeApi({ workflows: [wf('w1')], graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) });
    const view = () => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: null }) });
    const pos = (name: string) => {
      const card = [...document.querySelectorAll('.react-flow__node-step')].find((n) => n.textContent?.includes(name)) as HTMLElement;
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(card.style.transform)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    const frame = () => { const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec((document.querySelector('.react-flow__node-workflow') as HTMLElement).style.transform)!; return { x: Number(m[1]), y: Number(m[2]) }; };

    it('moves every picked step 8 px per press, a held key as one undo step', async () => {
      render(<App api={two()} live={liveStub()} storage={view()} />);
      fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
      fireEvent.click(screen.getByText('b-name', { selector: '.sn' }), { ctrlKey: true });
      const a0 = pos('a-name'); const b0 = pos('b-name');
      for (let i = 0; i < 3; i++) fireEvent.keyDown(document.body, { key: 'ArrowRight', repeat: i > 0 });
      await vi.waitFor(() => expect(pos('a-name').x).toBe(a0.x + 24));
      expect(pos('b-name')).toEqual({ x: b0.x + 24, y: b0.y });
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await vi.waitFor(() => expect(pos('a-name')).toEqual(a0));
      expect(pos('b-name')).toEqual(b0);
    });
    it('separate presses are separate undo steps, and so is a nudge of another pick', async () => {
      render(<App api={two()} live={liveStub()} storage={view()} />);
      fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
      const a0 = pos('a-name');
      fireEvent.keyDown(document.body, { key: 'ArrowRight' }); fireEvent.keyUp(document.body, { key: 'ArrowRight' });
      fireEvent.keyDown(document.body, { key: 'ArrowRight' }); fireEvent.keyUp(document.body, { key: 'ArrowRight' });
      fireEvent.click(screen.getByText('b-name', { selector: '.sn' }));
      const b0 = pos('b-name');
      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      await vi.waitFor(() => expect(pos('b-name').x).toBe(b0.x + 8));
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await vi.waitFor(() => expect(pos('b-name')).toEqual(b0));
      expect(pos('a-name')).toEqual({ x: a0.x + 16, y: a0.y });
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await vi.waitFor(() => expect(pos('a-name')).toEqual({ x: a0.x + 8, y: a0.y }));
    });
    it('holding an arrow on a workflow that is saving says so once', async () => {
      const api = Object.assign(two(), { saveDesign: vi.fn(() => new Promise(() => undefined)) }) as StudioApi;
      render(<App api={api} live={liveStub()} storage={view()} />);
      fireEvent.click(await screen.findByText('w1-name', { selector: '.nm' }));
      fireEvent.click(await screen.findByText('Save'));
      await screen.findByText('Saving…');
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      for (let i = 0; i < 5; i++) fireEvent.keyDown(document.body, { key: 'ArrowDown', repeat: true });
      expect(screen.getAllByText('w1-name is saving — wait for it to finish')).toHaveLength(1);
    });
    it('moves a picked frame', async () => {
      render(<App api={two()} live={liveStub()} storage={view()} />);
      fireEvent.click(await screen.findByText('w1-name', { selector: '.nm' }));
      const f0 = frame();
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      await vi.waitFor(() => expect(frame()).toEqual({ x: f0.x, y: f0.y + 16 }));
    });
    it('never puts a step above the header band', async () => {
      render(<App api={two()} live={liveStub()} storage={view()} />);
      fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
      const a0 = pos('a-name');
      for (let i = 0; i < 10; i++) fireEvent.keyDown(document.body, { key: 'ArrowUp' });
      for (let i = 0; i < 10; i++) fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      await new Promise((r) => setTimeout(r, 20));
      expect(pos('a-name').y).toBeGreaterThanOrEqual(46 + 28);
      expect(pos('a-name').x).toBeGreaterThanOrEqual(28);
      expect(a0.y).toBeGreaterThanOrEqual(46 + 28);
    });
    it('is ignored while typing and with nothing picked', async () => {
      render(<App api={two()} live={liveStub()} storage={view()} />);
      fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
      const a0 = pos('a-name');
      fireEvent.keyDown(await inspector().findByDisplayValue('a-name'), { key: 'ArrowRight' });
      fireEvent.click(document.querySelector('.react-flow__pane')!);
      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
      await new Promise((r) => setTimeout(r, 20));
      expect(pos('a-name')).toEqual(a0);
    });
  });

  describe('deleting a shared step', () => {
    // w1 and w2 both run a → b: every step is shared
    const shared = () => fakeApi({ workflows: [wf('w1'), wf('w2')], graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) });
    const view = () => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: null }) });
    const cards = (n: string) => screen.getAllByText(n, { selector: '.sn' });
    it('refuses a step a shared step wires to, and takes a shared first step out of this workflow only', async () => {
      renderApp(shared(), view());
      await screen.findByText('Board loaded: 2 workflows');
      fireEvent.click(cards('b-name')[0]!);
      fireEvent.click(screen.getByText('Delete'));
      expect(await screen.findByText('b-name is reached from a-name, which w2-name share too — deleting it here would change them')).toBeInTheDocument();
      expect(cards('b-name')).toHaveLength(2);
      fireEvent.click(cards('a-name')[0]!);
      fireEvent.click(screen.getByText('Delete'));
      await vi.waitFor(() => expect(cards('a-name')).toHaveLength(1));
      expect(cards('b-name')).toHaveLength(2);
    });
    it('Delete on the selection bar keeps a refused step, says why, and deletes the rest', async () => {
      renderApp(fakeApi({ workflows: [wf('w1'), wf('w2')], graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: ['c'], c: [] } }) }), view());
      await screen.findByText('Board loaded: 2 workflows');
      fireEvent.click(cards('c-name')[0]!);
      fireEvent.click(cards('a-name')[0]!, { ctrlKey: true });
      fireEvent.click(await screen.findByText('Delete'));
      expect(await screen.findByText('c-name is reached from b-name, which w2-name share too — deleting it here would change them')).toBeInTheDocument();
      await vi.waitFor(() => expect(cards('a-name')).toHaveLength(1));
      expect(cards('c-name')).toHaveLength(2);
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

  it('switches theme from the topbar button and remembers it', async () => {
    const st = memoryStorage();
    renderApp(fakeApi({ workflows: [] }), st);
    const btn = await screen.findByRole('button', { name: 'Dark' });
    fireEvent.click(btn);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(st.getItem('acto.theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Light' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(st.getItem('acto.theme')).toBe('light');
  });
});

describe('App chat', () => {
  it('shows the chat pane in its panel; a chat that is not configured leaves the board loading as usual', async () => {
    const aiFetch = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    render(<App api={fakeApi({ workflows: [wf('w1')] })} live={liveStub()} storage={memoryStorage()} session={memoryStorage()} aiFetch={aiFetch} />);
    const chat = document.querySelector('[data-panel="chat"]') as HTMLElement;
    expect(within(chat).getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(await within(chat).findByText(/^The chat is not configured/)).toBeInTheDocument();
    expect(await screen.findByText('Board loaded: 1 workflow')).toBeInTheDocument();
    expect(await screen.findByTestId('rf__node-wf:w1')).toBeInTheDocument();
  });
});

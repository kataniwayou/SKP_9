import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { StudioApi } from './api/client';
import { boardApi, fakeApi } from './board/testApi';
import { liveStub } from './test/liveStub';
import { memoryStorage } from './test/memoryStorage';

const view = () => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: null }) });
function renderApp(api: StudioApi = boardApi(), o: { storage?: Storage; session?: Storage; live?: ReturnType<typeof liveStub> } = {}) {
  return render(<App api={api} live={o.live ?? liveStub()} storage={o.storage ?? view()} session={o.session ?? memoryStorage()} />);
}
const inspector = () => within(document.querySelector('[data-panel="inspector"]') as HTMLElement);
const card = (name: string) => screen.getByText(name, { selector: '.sn' });
const triangle = (name: string) => screen.getByText(name, { selector: '.tri-nm' });
const saveButton = () => screen.getByRole('button', { name: /^Sav(e|ing)/ });
const inToolbar = () => within(document.querySelector('.toolbar') as HTMLElement);
const toolbarLabels = () => [...document.querySelectorAll('.toolbar button')].map((b) => b.textContent);
const loaded = () => screen.findByText('Board loaded: 2 workflows');
// real steps: ghost step cards are not counted
const steps = () => document.querySelectorAll('.react-flow__node-step:not(.ghost)').length;

describe('App', () => {
  it('loads the board from BaseAPI\'s lists: triangles, steps, the cache, and the processors in the toolbox', async () => {
    renderApp();
    expect(await loaded()).toBeInTheDocument();
    expect(document.querySelector('.topbar .brand')).toHaveTextContent(/^Acto$/);
    expect(await screen.findByTestId('rf__node-wf:daily')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-wf:hourly')).toBeInTheDocument();
    expect(steps()).toBe(3);
    expect(screen.getByTestId('rf__node-ca:c1')).toBeInTheDocument();
    expect(screen.getByTestId('toolbox-step')).toHaveTextContent('proc');
    expect(screen.getByText('Board: 2 workflows, 0 running')).toBeInTheDocument();
  });

  it('a failed load goes to Output and leaves an empty board, not the wait line', async () => {
    const api = fakeApi();
    (api.listWorkflows as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: { kind: 'http', status: 503, detail: 'unavailable' } });
    renderApp(api);
    expect(await screen.findByText('Could not load the board: 503: unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Board loaded/)).toBeNull();
    expect(screen.queryByText('Loading the board…')).toBeNull();
  });

  it('places an item without a location instead of stacking it at the origin', async () => {
    const api = boardApi();
    const steps0 = (await api.listSteps()) as { ok: true; value: object[] };
    (api.listSteps as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: [...steps0.value, { ...steps0.value[2], id: 'nowhere', name: 'nowhere', boardX: null, boardY: null }] });
    renderApp(api);
    await loaded();
    const el = (await screen.findByTestId('rf__node-st:nowhere')) as HTMLElement;
    expect(el.style.transform).not.toMatch(/translate\(0px,\s*0px\)/);
    // the placed location is unsaved: the next Save writes it; it is no undo step
    expect(saveButton()).toHaveTextContent('Save · 1');
    expect(within(el).getByLabelText('unsaved')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(saveButton()).toHaveTextContent('Save · 1');
  });

  describe('unsaved marks', () => {
    const marked = () => [...document.querySelectorAll('.react-flow__node')].filter((n) => n.querySelector('[aria-label="unsaved"]')).map((n) => n.getAttribute('data-id'));
    it('a clean board shows none; an edited step shows its mark', async () => {
      renderApp();
      await loaded();
      expect(marked()).toEqual([]);
      fireEvent.click(card('expand'));
      fireEvent.change(await inspector().findByDisplayValue('expand'), { target: { value: 'expand-2' } });
      await waitFor(() => expect(marked()).toEqual(['st:expand']));
      expect(screen.getByTitle('unsaved')).toBeInTheDocument();
    });
    it('a payload edit marks the workflow it belongs to', async () => {
      renderApp();
      await loaded();
      fireEvent.click(triangle('daily'));
      fireEvent.click(card('fetch-orders'));
      fireEvent.click(await inspector().findByRole('tab', { name: 'daily' }));
      const area = inspector().getByLabelText('Payload');
      fireEvent.change(area, { target: { value: '{"k":1}' } });
      await waitFor(() => expect(marked()).toEqual(['wf:daily']));
    });
  });

  describe('Save button', () => {
    it('reads Save and is disabled with nothing changed; Save · N after an edit; disabled while saving', async () => {
      let finish: (v: unknown) => void = () => {};
      const api = boardApi();
      (api.applyModel as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((res) => { finish = res; }));
      renderApp(api);
      await loaded();
      expect(saveButton()).toHaveTextContent(/^Save$/);
      expect(saveButton()).toBeDisabled();
      fireEvent.click(card('lonely'));
      await waitFor(() => expect(toolbarLabels()).toEqual(['Copy', 'Delete']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(saveButton()).toHaveTextContent('Save · 1'));
      expect(saveButton()).toBeEnabled();
      fireEvent.click(saveButton());
      await waitFor(() => expect(saveButton()).toHaveTextContent('Saving…'));
      expect(saveButton()).toBeDisabled();
      expect(api.applyModel).toHaveBeenCalledWith([expect.objectContaining({ op: 'delete', table: 'steps', id: 'lonely' })]);
      await act(async () => { finish({ ok: true, value: { applied: true, results: [], made: {} } }); });
      expect(await screen.findByText('Saved 1 change')).toBeInTheDocument();
    });

    it('marks the triangle with the problems of its dry run', async () => {
      const api = boardApi();
      (api.validateWorkflow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: { problems: [{ title: 'cycle', detail: 'x' }, { title: 'payload', detail: 'y' }] } });
      renderApp(api);
      await loaded();
      fireEvent.click(triangle('daily'));
      fireEvent.change(await inspector().findByDisplayValue('daily'), { target: { value: 'daily-2' } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(document.querySelector('[data-workflow="daily"] .tri-problems')).toHaveTextContent('2'));
    });

    it('a refused Save outlines the item BaseAPI named', async () => {
      const api = boardApi();
      (api.applyModel as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, value: { applied: false, results: [{ ok: false, table: 'steps', id: 'expand', status: 409 }] } });
      renderApp(api);
      await loaded();
      fireEvent.click(card('expand'));
      fireEvent.change(await inspector().findByDisplayValue('expand'), { target: { value: 'expand-2' } });
      fireEvent.click(saveButton());
      expect(await screen.findByText('expand-2 changed elsewhere — Take stored drops your change to it')).toBeInTheDocument();
      await waitFor(() => expect(card('expand-2').closest('.node')).toHaveClass('failed'));
      fireEvent.click(screen.getByRole('button', { name: 'Take stored · 1' }));
      await waitFor(() => expect(card('expand').closest('.node')).not.toHaveClass('failed'));
      expect(screen.queryByRole('button', { name: /Take stored/ })).toBeNull();
    });
  });

  describe('toolbars', () => {
    it('a step has Copy · Delete; Delete takes it away as one undo step', async () => {
      renderApp();
      await loaded();
      fireEvent.click(card('expand'));
      await waitFor(() => expect(toolbarLabels()).toEqual(['Copy', 'Delete']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(steps()).toBe(2));
      expect(document.querySelector('[data-id="wire:fetch:expand"]')).toBeNull();
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await waitFor(() => expect(steps()).toBe(3));
      fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
      await waitFor(() => expect(steps()).toBe(2));
    });

    it('a cache has Delete only; a triangle Start · Delete', async () => {
      renderApp();
      await loaded();
      fireEvent.click(screen.getByText('c1', { selector: '.cache-nm' }));
      await waitFor(() => expect(toolbarLabels()).toEqual(['Delete']));
      fireEvent.click(triangle('daily'));
      await waitFor(() => expect(toolbarLabels()).toEqual(['▶ Start', 'Delete']));
    });

    it('a triangle Delete runs the dry run, shows its confirm; Cancel keeps it, Delete deletes it in BaseAPI', async () => {
      const api = boardApi();
      renderApp(api);
      await loaded();
      fireEvent.click(triangle('hourly'));
      await waitFor(() => expect(toolbarLabels()).toContain('Delete'));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText('Delete workflow hourly, assignment assignment-a-hourly-fetch? Its steps and caches stay.')).toBeInTheDocument();
      expect(api.validateModel).toHaveBeenCalledTimes(1);
      fireEvent.click(inToolbar().getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByText('Delete cancelled — nothing was sent')).toBeInTheDocument();
      expect(api.applyModel).not.toHaveBeenCalled();
      await waitFor(() => expect(toolbarLabels()).toEqual(['▶ Start', 'Delete']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      await screen.findByText(/^Delete workflow hourly/);
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByTestId('rf__node-wf:hourly')).toBeNull());
      expect(api.applyModel).toHaveBeenCalledTimes(1);
      expect(steps()).toBe(3);
      expect(saveButton()).toBeDisabled();
    });
  });

  describe('picks and the selection bar', () => {
    it('Ctrl+click a step and a cache: the bar offers only Delete, and Delete takes both', async () => {
      renderApp();
      await loaded();
      fireEvent.click(card('lonely'));
      fireEvent.click(screen.getByText('c1', { selector: '.cache-nm' }), { ctrlKey: true });
      const bar = await screen.findByRole('toolbar', { name: 'selection actions' });
      expect(within(bar).getByText('2 SELECTED')).toBeInTheDocument();
      expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Delete']);
      fireEvent.click(within(bar).getByText('Delete'));
      await waitFor(() => expect(steps()).toBe(2));
      expect(screen.queryByTestId('rf__node-ca:c1')).toBeNull();
      expect(saveButton()).toHaveTextContent('Save · 3'); // the step, the cache and daily's cache line
    });

    it('Esc clears the picks (D1)', async () => {
      renderApp();
      await loaded();
      fireEvent.click(card('expand'));
      expect(await inspector().findByDisplayValue('expand')).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(await inspector().findByText('Board: 2 workflows, 0 running')).toBeInTheDocument();
      expect(document.querySelector('.toolbar')).toBeNull();
    });

    it('restores a saved selection', async () => {
      const storage = memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: { workflows: [], picks: [{ kind: 'step', id: 'expand' }] } }) });
      renderApp(boardApi(), { storage });
      expect(await inspector().findByDisplayValue('expand')).toBeInTheDocument();
    });
  });

  describe('ghosts', () => {
    const ghost = (key: string) => screen.queryByTestId(`rf__node-ghost:${key}`);
    it('a deleted step is a ghost; picked, its toolbar Restores it as one edit and the Save count goes back to 0', async () => {
      renderApp();
      await loaded();
      fireEvent.click(card('lonely'));
      await waitFor(() => expect(toolbarLabels()).toEqual(['Copy', 'Delete']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(ghost('step:lonely')).not.toBeNull());
      expect(saveButton()).toHaveTextContent('Save · 1');
      fireEvent.click(ghost('step:lonely')!);
      await waitFor(() => expect(toolbarLabels()).toEqual(['Restore', 'Remove']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Restore' }));
      await waitFor(() => expect(screen.getByTestId('rf__node-st:lonely')).toBeInTheDocument());
      expect(ghost('step:lonely')).toBeNull();
      expect(saveButton()).toHaveTextContent(/^Save$/);
      // the restored ghost left the selection with the ghost
      expect(document.querySelector('.toolbar')).toBeNull();
      // one undo step: undo takes the step away again
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await waitFor(() => expect(ghost('step:lonely')).not.toBeNull());
    });

    it('Remove drops the ghost; Undo does not bring the ghost back, but Undo of the delete brings the step', async () => {
      renderApp();
      await loaded();
      fireEvent.click(card('lonely'));
      await waitFor(() => expect(toolbarLabels()).toEqual(['Copy', 'Delete']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(ghost('step:lonely')).not.toBeNull());
      fireEvent.click(ghost('step:lonely')!);
      await waitFor(() => expect(toolbarLabels()).toEqual(['Restore', 'Remove']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(ghost('step:lonely')).toBeNull());
      expect(document.querySelector('.toolbar')).toBeNull();
      expect(saveButton()).toHaveTextContent('Save · 1');
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await waitFor(() => expect(screen.getByTestId('rf__node-st:lonely')).toBeInTheDocument());
      expect(ghost('step:lonely')).toBeNull();
      expect(saveButton()).toHaveTextContent(/^Save$/);
    });

    it('a ghost wire whose step is gone is refused with "restore <name> first"', async () => {
      renderApp();
      await loaded();
      fireEvent.click(card('expand'));
      await waitFor(() => expect(toolbarLabels()).toEqual(['Copy', 'Delete']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(ghost('step:expand')).not.toBeNull());
      const wire = document.querySelector('[data-id="ghost:wire:fetch:expand"]') as HTMLElement;
      expect(wire).not.toBeNull();
      fireEvent.click(wire);
      await waitFor(() => expect(toolbarLabels()).toEqual(['Restore', 'Remove']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Restore' }));
      expect(await screen.findByText('restore expand first')).toBeInTheDocument();
      expect(document.querySelector('[data-id="wire:fetch:expand"]')).toBeNull();
    });

    it('two ghosts: the bar offers Restore and Remove; Restore puts both back', async () => {
      renderApp();
      await loaded();
      fireEvent.click(card('lonely'));
      fireEvent.click(screen.getByText('c1', { selector: '.cache-nm' }), { ctrlKey: true });
      const bar = await screen.findByRole('toolbar', { name: 'selection actions' });
      fireEvent.click(within(bar).getByText('Delete'));
      await waitFor(() => expect(ghost('cache:c1')).not.toBeNull());
      fireEvent.click(ghost('step:lonely')!);
      fireEvent.click(ghost('cache:c1')!, { ctrlKey: true });
      const bar2 = await screen.findByRole('toolbar', { name: 'selection actions' });
      expect(within(bar2).getAllByRole('button').map((b) => b.textContent)).toEqual(['Restore', 'Remove']);
      fireEvent.click(within(bar2).getByText('Restore'));
      await waitFor(() => expect(screen.getByTestId('rf__node-st:lonely')).toBeInTheDocument());
      expect(screen.getByTestId('rf__node-ca:c1')).toBeInTheDocument();
      expect(screen.queryByRole('toolbar', { name: 'selection actions' })).toBeNull();
    });
  });

  describe('several triangles', () => {
    const pickBoth = async () => {
      fireEvent.click(triangle('daily'));
      fireEvent.click(triangle('hourly'), { ctrlKey: true });
      return screen.findByRole('toolbar', { name: 'selection actions' });
    };
    it('the bar offers Start · Stop · Delete; Start and Stop act on each', async () => {
      const api = boardApi();
      const answer = { ok: true, value: null };
      Object.assign(api, { startWorkflow: vi.fn().mockResolvedValue(answer), stopWorkflow: vi.fn().mockResolvedValue(answer) });
      renderApp(api);
      await loaded();
      const bar = await pickBoth();
      expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['▶ Start', '■ Stop', 'Delete']);
      fireEvent.click(within(bar).getByText('▶ Start'));
      await waitFor(() => expect(api.startWorkflow).toHaveBeenCalledTimes(2));
      expect(api.startWorkflow).toHaveBeenCalledWith('daily');
      expect(api.startWorkflow).toHaveBeenCalledWith('hourly');
      fireEvent.click(within(bar).getByText('■ Stop'));
      await waitFor(() => expect(api.stopWorkflow).toHaveBeenCalledTimes(2));
      expect(api.startWorkflow).toHaveBeenCalledTimes(2);
    });

    it('Delete runs each dry run, one confirm listing every workflow, then deletes one by one', async () => {
      const api = boardApi();
      renderApp(api);
      await loaded();
      const bar = await pickBoth();
      fireEvent.click(within(bar).getByText('Delete'));
      expect(await screen.findByText(/^Delete workflow daily, .*workflow hourly, .*\? Their steps and caches stay\.$/)).toBeInTheDocument();
      expect(api.validateModel).toHaveBeenCalledTimes(2);
      expect(api.applyModel).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'selection actions' })).getByText('Delete'));
      await waitFor(() => expect(screen.queryByTestId('rf__node-wf:hourly')).toBeNull());
      expect(screen.queryByTestId('rf__node-wf:daily')).toBeNull();
      expect(api.applyModel).toHaveBeenCalledTimes(2);
      expect(steps()).toBe(3);
    });

    it('a refused dry run is reported; the confirm lists the rest, and Cancel sends nothing', async () => {
      const api = boardApi();
      (api.validateModel as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, value: { ok: false, results: [
        { index: 0, op: 'delete', table: 'workflows', id: 'daily', ok: false, status: 422, problem: { detail: 'running: stop it first' } },
      ] } });
      renderApp(api);
      await loaded();
      const bar = await pickBoth();
      fireEvent.click(within(bar).getByText('Delete'));
      expect(await screen.findByText('workflow daily: running: stop it first')).toBeInTheDocument();
      expect(await screen.findByText(/^Delete workflow hourly.*\? Its steps and caches stay\.$/)).toBeInTheDocument();
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'selection actions' })).getByText('Cancel'));
      expect(await screen.findByText('Delete cancelled — nothing was sent')).toBeInTheDocument();
      expect(api.applyModel).not.toHaveBeenCalled();
    });

    it('the Delete key does nothing', async () => {
      const api = boardApi();
      renderApp(api);
      await loaded();
      await pickBoth();
      fireEvent.keyDown(document.body, { key: 'Delete' });
      expect(api.validateModel).not.toHaveBeenCalled();
      expect(screen.getByTestId('rf__node-wf:daily')).toBeInTheDocument();
    });
  });

  describe('selection prune', () => {
    it('a selected workflow that leaves the board leaves workflows', async () => {
      const storage = memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: { workflows: ['gone', 'daily'], picks: [] } }) });
      renderApp(boardApi(), { storage });
      await loaded();
      await waitFor(() => expect(JSON.parse(storage.getItem('acto.view')!).selection.workflows).toEqual(['daily']));
    });
  });

  describe('copy and paste', () => {
    it('Copy says what was copied; Ctrl+V pastes new steps without payloads, picks them, one undo step', async () => {
      const session = memoryStorage();
      renderApp(boardApi(), { session });
      await loaded();
      fireEvent.click(card('fetch-orders'));
      await waitFor(() => expect(toolbarLabels()).toEqual(['Copy', 'Delete']));
      fireEvent.click(inToolbar().getByRole('button', { name: 'Copy' }));
      expect(await screen.findByText('Copied 1 step')).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
      await waitFor(() => expect(steps()).toBe(4));
      expect(await screen.findByText('Pasted 1 step')).toBeInTheDocument();
      expect(await inspector().findByDisplayValue('fetch-orders-2')).toBeInTheDocument();
      expect(JSON.parse(session.getItem('acto.clip')!).pasted).toBe(1);
      expect(saveButton()).toHaveTextContent('Save · 1');
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      await waitFor(() => expect(steps()).toBe(3));
    });

    it('says when nothing was copied, and leaves Ctrl+V to a field', async () => {
      renderApp();
      await loaded();
      fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
      expect(await screen.findByText('Nothing copied yet')).toBeInTheDocument();
      fireEvent.click(card('expand'));
      fireEvent.keyDown(await inspector().findByDisplayValue('expand'), { key: 'v', ctrlKey: true });
      expect(steps()).toBe(3);
    });
  });

  it('a toolbox Workflow dropped on the board makes a triangle at the drop point and selects it', async () => {
    renderApp();
    await loaded();
    const pane = document.querySelector('.react-flow') as HTMLElement;
    const data = { getData: (k: string) => (k === 'application/acto' ? '{"kind":"workflow"}' : ''), dropEffect: '' };
    // jsdom's drag events carry no pointer position: give them one
    const at = (ev: Event) => { Object.defineProperties(ev, { clientX: { value: 500 }, clientY: { value: 300 }, dataTransfer: { value: data } }); return ev; };
    fireEvent(pane, at(createEvent.dragOver(pane)));
    fireEvent(pane, at(createEvent.drop(pane)));
    expect(await screen.findByText('new-workflow-1 created — it is saved only when you press Save')).toBeInTheDocument();
    expect(await inspector().findByDisplayValue('new-workflow-1')).toBeInTheDocument();
    const node = screen.getByTestId(/^rf__node-wf:(?!daily|hourly)/) as HTMLElement;
    await waitFor(() => expect(node.style.transform).toMatch(/translate\(440px,\s*248px\)/));
    expect(saveButton()).toHaveTextContent('Save · 1');
  });

  it('switches theme from the topbar button and remembers it', async () => {
    const st = memoryStorage();
    renderApp(fakeApi(), { storage: st });
    fireEvent.click(await screen.findByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(st.getItem('acto.theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('App chat', () => {
  it('shows the chat pane in its panel; a chat that is not configured leaves the board loading as usual', async () => {
    const aiFetch = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    render(<App api={boardApi()} live={liveStub()} storage={memoryStorage()} session={memoryStorage()} aiFetch={aiFetch} />);
    const chat = document.querySelector('[data-panel="chat"]') as HTMLElement;
    expect(within(chat).getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(await within(chat).findByText(/^The chat is not configured/)).toBeInTheDocument();
    expect(await screen.findByText('Board loaded: 2 workflows')).toBeInTheDocument();
  });
});

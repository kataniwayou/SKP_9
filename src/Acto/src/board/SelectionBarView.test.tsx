import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { liveStub } from '../test/liveStub';
import { memoryStorage } from '../test/memoryStorage';
import { fakeApi, graphWith, wf } from './testApi';
import { SelectionBar } from './SelectionBarView';

const actions = () => ({ copy: vi.fn(), deleteParts: vi.fn(), start: vi.fn(), stop: vi.fn(), save: vi.fn(), deleteWorkflows: vi.fn() });
const labels = () => screen.getAllByRole('button').map((b) => b.textContent);

describe('SelectionBar', () => {
  it('workflows: pill and the buttons whose n is not 0', () => {
    const a = actions();
    render(<SelectionBar bar={{ kind: 'workflows', count: 3, start: ['a', 'b'], stop: ['c'], save: ['b'] }} actions={a} />);
    expect(screen.getByText('3 SELECTED')).toBeInTheDocument();
    expect(labels()).toEqual(['▶ Start 2', '■ Stop 1', 'Save 1', 'Delete']);
    fireEvent.click(screen.getByText('▶ Start 2')); fireEvent.click(screen.getByText('■ Stop 1'));
    fireEvent.click(screen.getByText('Save 1')); fireEvent.click(screen.getByText('Delete'));
    expect(a.start).toHaveBeenCalledWith(['a', 'b']);
    expect(a.stop).toHaveBeenCalledWith(['c']);
    expect(a.save).toHaveBeenCalledWith(['b']);
    expect(a.deleteWorkflows).toHaveBeenCalledTimes(1);
  });
  it('does not render a button whose n is 0', () => {
    render(<SelectionBar bar={{ kind: 'workflows', count: 2, start: [], stop: ['a', 'b'], save: [] }} actions={actions()} />);
    expect(labels()).toEqual(['■ Stop 2', 'Delete']);
    expect(screen.queryByText('Save 0')).toBeNull();
  });
  it('parts: Copy and Delete', () => {
    const a = actions();
    render(<SelectionBar bar={{ kind: 'parts', count: 2 }} actions={a} />);
    expect(labels()).toEqual(['Copy', 'Delete']);
    fireEvent.click(screen.getByText('Copy')); fireEvent.click(screen.getByText('Delete'));
    expect(a.copy).toHaveBeenCalledTimes(1); expect(a.deleteParts).toHaveBeenCalledTimes(1);
  });
  it('mixed: only the text', () => {
    render(<SelectionBar bar={{ kind: 'mixed', count: 2 }} actions={actions()} />);
    expect(screen.getByText('no action in common')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
  it('a pending confirm replaces the buttons', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    render(<SelectionBar bar={{ kind: 'workflows', count: 2, start: [], stop: [], save: [] }} actions={actions()} confirm={{ text: '2 steps go. Delete 2 workflows?', onConfirm, onCancel }} />);
    expect(screen.getByText('2 steps go. Delete 2 workflows?')).toBeInTheDocument();
    expect(labels()).toEqual(['Delete', 'Cancel']);
    fireEvent.click(screen.getByText('Delete')); fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).toHaveBeenCalled(); expect(onCancel).toHaveBeenCalled();
  });
});

const view = () => memoryStorage({ 'acto.view': JSON.stringify({ x: 0, y: 0, zoom: 1, selection: null }) });
const twoWorkflows = () => fakeApi({
  workflows: [wf('w1'), wf('w2')],
  graphs: { w1: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }), w2: graphWith({ entry: ['x'], steps: { x: ['y'], y: [] } }) },
});
const edge = (id: string) => document.querySelector(`.react-flow__edge[data-id="${id}"]`);

describe('SelectionBar in the app', () => {
  it('Delete on a step and a wire of two workflows is one undo step in each; undo acts on the last pick only', async () => {
    render(<App api={twoWorkflows()} live={liveStub()} storage={view()} session={memoryStorage()} />);
    await screen.findByText('Board loaded: 2 workflows');
    fireEvent.click(await screen.findByText('a-name', { selector: '.sn' }));
    await vi.waitFor(() => expect(edge('wi:w2:x>y')).not.toBeNull());
    fireEvent.click(edge('wi:w2:x>y')!, { ctrlKey: true });
    expect(await screen.findByText('2 SELECTED')).toBeInTheDocument();
    expect(labels()).toContain('Copy');
    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => expect(screen.queryByText('a-name', { selector: '.sn' })).toBeNull());
    expect(edge('wi:w2:x>y')).toBeNull();
    expect(screen.queryByText('2 SELECTED')).toBeNull();
    // the picks are now the last pick's workflow: w2 (its undo stack holds the wire delete)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await vi.waitFor(() => expect(edge('wi:w2:x>y')).not.toBeNull());
    expect(screen.queryByText('a-name', { selector: '.sn' })).toBeNull();
    // pick w1: its own undo brings the step back, w2 keeps the wire
    fireEvent.click(screen.getByText('w1-name', { selector: '.nm' }));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(await screen.findByText('a-name', { selector: '.sn' })).toBeInTheDocument();
    expect(edge('wi:w2:x>y')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('a-name', { selector: '.sn' })).toBeInTheDocument();
  });
  it('Delete for two workflows shows the summed confirm in the bar', async () => {
    const api = twoWorkflows();
    const del = vi.fn(async (_id: string, dryRun: boolean) => ({ ok: true as const, value: { applied: !dryRun, steps: 1, assignments: 2, caches: 0, processors: 0, errors: [] } }));
    (api as unknown as { deleteWorkflow: unknown }).deleteWorkflow = del;
    (api as unknown as { listLive: unknown }).listLive = vi.fn(async () => ({ ok: true, value: [] }));
    render(<App api={api} live={liveStub()} storage={view()} session={memoryStorage()} />);
    await screen.findByText('Board loaded: 2 workflows');
    fireEvent.click(await screen.findByText('w1-name', { selector: '.nm' }));
    fireEvent.click(screen.getByText('w2-name', { selector: '.nm' }), { ctrlKey: true });
    await screen.findByText('2 SELECTED');
    await act(async () => { fireEvent.click(screen.getByText('Delete')); });
    expect(await screen.findByText('2 steps, 4 assignments go. Delete 2 workflows?')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Cancel')); });
    expect(screen.getByText('Delete cancelled — nothing was sent')).toBeInTheDocument();
    expect(screen.getByText('2 SELECTED')).toBeInTheDocument();
  });
});

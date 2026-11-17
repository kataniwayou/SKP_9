import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { liveStub } from '../test/liveStub';
import { memoryStorage } from '../test/memoryStorage';
import { fakeApi, graphWith, wf } from './testApi';
import { Toolbar } from './Toolbar';

const labels = () => screen.getAllByRole('button').map((b) => b.textContent);

describe('Toolbar', () => {
  it('shows exactly the right button per kind', () => {
    for (const [kind, label] of [['workflow', 'Save,Delete'], ['step', 'Delete'], ['wire', 'Delete'], ['cache', 'Delete']] as const) {
      const { container, unmount } = render(<Toolbar selection={{ kind }} actions={{}} />);
      expect(labels().join(',')).toBe(label);
      expect(container.firstElementChild!.classList.contains('toolbar')).toBe(true);
      expect(container.querySelector('.toolbar-arrow')).not.toBeNull();
      expect(container.textContent).not.toContain('Ctrl');
      unmount();
    }
  });
  it('shows Start or Stop before Save by the workflow status', () => {
    const onRun = vi.fn();
    const { rerender } = render(<Toolbar selection={{ kind: 'workflow' }} actions={{}} run={{ op: 'start', enabled: true, onRun }} />);
    expect(labels()).toEqual(['▶ Start', 'Save', 'Delete']);
    expect(screen.getByText('▶ Start')).toBeEnabled();
    expect(screen.getByText('▶ Start').className).toContain('go');
    fireEvent.click(screen.getByText('▶ Start'));
    expect(onRun).toHaveBeenCalledTimes(1);
    rerender(<Toolbar selection={{ kind: 'workflow' }} actions={{}} run={{ op: 'stop', enabled: true, onRun }} />);
    expect(labels()).toEqual(['■ Stop', 'Save', 'Delete']);
    expect(screen.getByText('■ Stop').className).toContain('stop');
    rerender(<Toolbar selection={{ kind: 'workflow' }} actions={{}} run={{ op: 'start', enabled: false, onRun }} />);
    expect(screen.getByText('▶ Start')).toBeDisabled();
  });
  it('highlights Save only when unsaved, and disables it while saving', () => {
    const { rerender } = render(<Toolbar selection={{ kind: 'workflow' }} actions={{}} />);
    expect(screen.getByText('Save').className).not.toContain('primary');
    rerender(<Toolbar selection={{ kind: 'workflow' }} actions={{}} unsaved />);
    expect(screen.getByText('Save').className).toContain('primary');
    rerender(<Toolbar selection={{ kind: 'workflow' }} actions={{}} unsaved saving />);
    expect(screen.getByText('Saving…')).toBeDisabled();
  });
  it('a pending workflow delete shows the confirm text, Delete and Cancel instead of the buttons', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    render(<Toolbar selection={{ kind: 'workflow' }} actions={{}} confirm={{ text: '5 steps, 3 assignments go. Delete orders?', onConfirm, onCancel }} />);
    expect(screen.getByText('5 steps, 3 assignments go. Delete orders?')).toBeInTheDocument();
    expect(labels()).toEqual(['Delete', 'Cancel']);
    expect(screen.getByText('Delete').className).toContain('danger');
    fireEvent.click(screen.getByText('Delete')); fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).toHaveBeenCalledTimes(1); expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it('calls the action it is given', () => {
    const onDelete = vi.fn();
    render(<Toolbar selection={{ kind: 'step' }} actions={{ onDelete }} />);
    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('Toolbar in the app', () => {
  it('Delete on a step removes it, selects its workflow and shows the unsaved tag', async () => {
    render(<App api={fakeApi({ workflows: [wf('w1')], graph: graphWith({ entry: ['a'], steps: { a: ['b'], b: [] } }) })}
      live={liveStub()} storage={memoryStorage()} session={memoryStorage()} />);
    await screen.findByText('Board loaded: 1 workflow');
    fireEvent.click(await screen.findByText('b-name'));
    expect(labels().filter((l) => l === 'Delete')).toEqual(['Delete']);
    expect(screen.queryByText('unsaved')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText('Delete')); });
    expect(screen.queryByText('b-name')).toBeNull();
    expect(screen.getByText('unsaved')).toBeInTheDocument();
    expect(screen.getByText('Save').className).toContain('primary');
  });
  it('Delete on a workflow asks for a confirm, Cancel keeps it, Delete removes it and its pick', async () => {
    const api = fakeApi({ workflows: [wf('w1')], graph: graphWith({ entry: ['a'], steps: { a: [] } }) });
    const del = vi.fn(async (_id: string, dryRun: boolean) => ({ ok: true as const, value: { applied: !dryRun, steps: 1, assignments: 2, caches: 0, processors: 0, errors: [] } }));
    (api as unknown as { deleteWorkflow: unknown }).deleteWorkflow = del;
    (api as unknown as { listLive: unknown }).listLive = vi.fn(async () => ({ ok: true, value: [] }));
    render(<App api={api} live={liveStub()} storage={memoryStorage()} session={memoryStorage()} />);
    await screen.findByText('Board loaded: 1 workflow');
    fireEvent.click(await screen.findByText('w1-name'));
    await act(async () => { fireEvent.click(screen.getByText('Delete')); });
    expect(await screen.findByText('1 step, 2 assignments go. Delete w1-name?')).toBeInTheDocument();
    expect(del).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByText('Cancel')); });
    expect(screen.getByText('Delete cancelled — nothing was sent')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Delete')); });
    await screen.findByText('1 step, 2 assignments go. Delete w1-name?');
    await act(async () => { fireEvent.click(screen.getByText('Delete')); });
    expect(del).toHaveBeenLastCalledWith('w1', false);
    expect(screen.getByText('w1-name deleted: 1 step, 2 assignments')).toBeInTheDocument();
    expect(screen.queryByText('Save')).toBeNull();
  });
});

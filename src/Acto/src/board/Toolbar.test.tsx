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
    for (const [kind, label] of [['workflow', 'Save'], ['step', 'Delete'], ['wire', 'Delete'], ['cache', 'Delete']] as const) {
      const { container, unmount } = render(<Toolbar selection={{ kind }} actions={{}} />);
      expect(labels()).toEqual([label]);
      expect(container.firstElementChild!.classList.contains('toolbar')).toBe(true);
      expect(container.querySelector('.toolbar-arrow')).not.toBeNull();
      expect(container.textContent).not.toContain('Ctrl');
      unmount();
    }
  });
  it('highlights Save only when unsaved, and disables it while saving', () => {
    const { rerender } = render(<Toolbar selection={{ kind: 'workflow' }} actions={{}} />);
    expect(screen.getByText('Save').className).not.toContain('primary');
    rerender(<Toolbar selection={{ kind: 'workflow' }} actions={{}} unsaved />);
    expect(screen.getByText('Save').className).toContain('primary');
    rerender(<Toolbar selection={{ kind: 'workflow' }} actions={{}} unsaved saving />);
    expect(screen.getByText('Saving…')).toBeDisabled();
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
});

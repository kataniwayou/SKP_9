import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createStudioStore, StudioStoreProvider, useStudio } from './studioStore';

function ActiveId() {
  const id = useStudio((s) => s.activeId);
  return <span>{id ?? 'none'}</span>;
}

describe('createStudioStore', () => {
  it('notifies listeners on a change and not on a no-op', () => {
    const store = createStudioStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);

    store.dispatch({ type: 'open', workflowId: 'a', name: 'a', version: '1' });
    store.dispatch({ type: 'activate', workflowId: 'a' });
    stop();
    store.dispatch({ type: 'toggleDetails' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().showDetails).toBe(true);
  });

  it('re-renders a component that reads a slice when that slice changes', () => {
    const store = createStudioStore();
    render(<StudioStoreProvider value={store}><ActiveId /></StudioStoreProvider>);
    expect(screen.getByText('none')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'open', workflowId: 'wf9', name: 'n', version: '1' }));

    expect(screen.getByText('wf9')).toBeInTheDocument();
  });

  it('says plainly when the provider is missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ActiveId />)).toThrow(/StudioStoreProvider/);
    vi.restoreAllMocks();
  });
});

import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';
import { SaveAnnouncer } from '../App';
import { MIN_SPIN_MS, Spinner, useMinShown } from './Spinner';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the Save spinner (2026-10-10)', () => {
  it('once shown, stays at least 300 ms; a long Save hides it as soon as it ends', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ on }) => useMinShown(on), { initialProps: { on: false } });
    expect(result.current).toBe(false);
    rerender({ on: true });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ on: false });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(MIN_SPIN_MS - 100 - 1); });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(false);

    rerender({ on: true });
    act(() => { vi.advanceTimersByTime(1000); });
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it('turns with full motion, pulses (class reduced) when the user prefers reduced motion', () => {
    const { unmount } = render(<Spinner />);
    expect(screen.getByTestId('spinner')).toHaveClass('spin');
    expect(screen.getByTestId('spinner')).not.toHaveClass('reduced');
    expect(screen.getByTestId('spinner')).toHaveAttribute('aria-hidden', 'true');
    unmount();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener: () => {}, removeEventListener: () => {} }));
    render(<Spinner />);
    expect(screen.getByTestId('spinner')).toHaveClass('spin reduced');
  });

  it('announces "Saving <name>…" and then "Saved <name>" or "Not saved <name>" politely', () => {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    render(<StudioStoreProvider value={store}><SaveAnnouncer /></StudioStoreProvider>);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    act(() => store.dispatch({ type: 'saving', workflowId: 'wf1' }));
    expect(status).toHaveTextContent('Saving orders…');
    act(() => store.dispatch({ type: 'saveFailed', workflowId: 'wf1', at: 't', message: 'down' }));
    expect(status).toHaveTextContent('Not saved orders');
    act(() => store.dispatch({ type: 'saving', workflowId: 'wf1' }));
    act(() => store.dispatch({ type: 'saveAnswered', workflowId: 'wf1', at: 't', applied: true, errors: [], doc: null, reread: 'x' }));
    expect(status).toHaveTextContent('Saved orders');
  });
});

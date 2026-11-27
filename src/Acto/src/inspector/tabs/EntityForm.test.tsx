import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pick } from '../../board/selection';
import { openOn } from './testBoard';

afterEach(() => sessionStorage.clear());

const fetch: Pick = { kind: 'step', id: 'fetch' };
const CASES: ReadonlyArray<[string, Pick, string]> = [
  ['workflow', { kind: 'workflow', id: 'daily' }, 'Workflow'],
  ['step', fetch, 'Step'],
  ['processor', fetch, 'Processor'],
  ['schema', fetch, 'Config schema'],
  ['assignment', fetch, 'daily'],
  ['cache', { kind: 'cache', id: 'c1' }, 'Cache'],
];

// Studio's EntityForm order for every entity tab [user, 2026-11-18]
describe('one entity form', () => {
  it.each(CASES)('%s: head, Name, Version, show all, Description in that order', (_kind, pick, tab) => {
    openOn(tab, [pick]);
    const parts = [
      screen.getByLabelText('Unique name'),
      screen.getByLabelText('Name'),
      screen.getByLabelText('Version'),
      screen.getByRole('button', { name: '▸ show all' }),
      screen.getByLabelText('Description'),
    ];
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i - 1]!.compareDocumentPosition(parts[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `part ${i}`).toBeTruthy();
    }
    expect(screen.getByLabelText('Description').tagName).toBe('TEXTAREA');
  });
});

// A cache's items are an overlay of unsaved changes: add and revert an item, the Save count and undo follow
describe("a cache's items", () => {
  const overlay = (store: ReturnType<typeof openOn>) => store.state().caches.c1!.itemEdits;
  const addItem = (k: string, v: string) => {
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: k } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: v } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
  };
  it('add an item then revert it: one undo step each, unsaved while the overlay holds a change', () => {
    const store = openOn('Cache', [{ kind: 'cache', id: 'c1' }]);
    expect(screen.getByText('Items · 0 stored')).toBeInTheDocument();
    addItem('usd', '3.7');
    expect(overlay(store).set).toEqual({ usd: '3.7' });
    expect(store.unsaved().size).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Revert usd' }));
    expect(overlay(store).set).toEqual({});
    expect(store.unsaved().size).toBe(0);
    act(() => store.undo());
    expect(overlay(store).set).toEqual({ usd: '3.7' });
    expect(screen.getByLabelText('Value usd')).toHaveValue('3.7');
    act(() => store.undo());
    expect(overlay(store).set).toEqual({});
    expect(screen.queryByLabelText('Value usd')).toBeNull();
    expect(store.canUndo()).toBe(false);
  });
});

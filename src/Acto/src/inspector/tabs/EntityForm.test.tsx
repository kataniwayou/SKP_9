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

// A cache's items are a key/value table: add and remove an item, the Save count and undo follow [user, 2026-11-18]
describe('a cache\'s items', () => {
  const c1 = (store: ReturnType<typeof openOn>) => store.state().caches.c1!.items;
  it('add and remove an item through the table: one undo step each, unsaved while it differs from the saved items', () => {
    const store = openOn('Cache', [{ kind: 'cache', id: 'c1' }]);
    expect(screen.getByText('0 items')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add item' }));
    const key = screen.getByRole('textbox', { name: 'Key 1' });
    fireEvent.change(key, { target: { value: 'usd' } });
    fireEvent.blur(key);
    const value = screen.getByRole('textbox', { name: 'Value 1' });
    fireEvent.focus(value);
    fireEvent.change(value, { target: { value: '3.7' } });
    fireEvent.blur(value);
    expect(c1(store)).toBe('{"usd":"3.7"}');
    expect(store.unsaved().size).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete item 1' }));
    expect(c1(store)).toBe('{}');
    expect(store.unsaved().size).toBe(0); // back to the saved items: nothing to save
    // each commit is its own undo step: undo takes back the delete, then the value, then the key
    act(() => store.undo());
    expect(c1(store)).toBe('{"usd":"3.7"}');
    expect(screen.getByRole('textbox', { name: 'Key 1' })).toHaveValue('usd');
    expect(store.unsaved().size).toBe(1);
    act(() => store.undo());
    expect(c1(store)).toBe('{"usd":""}');
    act(() => store.undo());
    expect(c1(store)).toBe('{}');
    expect(screen.queryByRole('textbox', { name: 'Key 1' })).toBeNull();
    expect(store.unsaved().size).toBe(0);
    expect(store.canUndo()).toBe(false);
  });

  it('undo after an add puts the table back to the saved items', () => {
    const store = openOn('Cache', [{ kind: 'cache', id: 'c1' }]);
    fireEvent.click(screen.getByRole('button', { name: '+ Add item' }));
    const key = screen.getByRole('textbox', { name: 'Key 1' });
    fireEvent.change(key, { target: { value: 'a' } });
    fireEvent.blur(key);
    expect(store.unsaved().size).toBe(1);
    act(() => store.undo());
    expect(c1(store)).toBe('{}');
    expect(screen.queryByRole('textbox', { name: 'Key 1' })).toBeNull();
    expect(store.unsaved().size).toBe(0);
  });
});

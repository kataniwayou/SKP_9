import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { railOf } from './AutoHide';
import { Menu } from './Menu';
import { filterItems } from './Picker';
import { switcherOrder, touch } from './Switcher';
import { tipFor } from './Tooltip';

describe('Menu', () => {
  it('renders into the anchor document, runs an item, and skips a disabled one', () => {
    const onClose = vi.fn(), run = vi.fn(), never = vi.fn();
    render(<Menu label="Test" anchor={{ x: 10, y: 20, doc: document }} onClose={onClose} entries={[
      { id: 'a', label: 'Float', kbd: 'Ctrl+dbl-click', onSelect: run },
      'separator',
      { id: 'b', label: 'Undo', disabled: true, tip: 'Not available yet', onSelect: never },
    ]} />);

    fireEvent.click(screen.getByRole('menuitem', { name: /Undo/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Float/ }));

    expect(never).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: /Undo/ })).toHaveAttribute('data-tip', 'Not available yet');
  });

  it('closes on a press outside it', () => {
    const onClose = vi.fn();
    render(<Menu label="Test" anchor={{ x: 0, y: 0, doc: document }} onClose={onClose} entries={[{ id: 'a', label: 'A', onSelect: () => {} }]} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('filterItems', () => {
  const items = [{ id: '1', label: 'orders_1.0.0-ab12', open: false }, { id: '2', label: 'Billing_2.0.0-cd34', open: true }];
  it('matches any part of the unique name, ignoring case, and keeps the order', () => {
    expect(filterItems(items, '').map((i) => i.id)).toEqual(['1', '2']);
    expect(filterItems(items, ' bill ').map((i) => i.id)).toEqual(['2']);
    expect(filterItems(items, 'cd34').map((i) => i.id)).toEqual(['2']);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
});

describe('tipFor', () => {
  const el = (html: string) => { document.body.innerHTML = html; return document.body.firstElementChild!; };

  it('always shows data-tip, from the element or an ancestor', () => {
    const host = el('<button data-tip="Not available yet"><span>▶ Start</span></button>');
    expect(tipFor(host.querySelector('span'))?.text).toBe('Not available yet');
  });

  it('shows data-tipcut only when the text overflows its box', () => {
    const span = el('<span data-tipcut="a very long source hash">a very…</span>') as HTMLElement;
    Object.defineProperty(span, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(span, 'scrollWidth', { value: 100, configurable: true });
    expect(tipFor(span)).toBeNull();
    Object.defineProperty(span, 'scrollWidth', { value: 240, configurable: true });
    expect(tipFor(span)?.text).toBe('a very long source hash');
  });

  it('shows nothing outside any tip', () => {
    expect(tipFor(el('<div>plain</div>'))).toBeNull();
    expect(tipFor(null)).toBeNull();
  });
});

describe('switcher order and rails', () => {
  it('keeps recently used first, then the rest in their own order', () => {
    expect(touch(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(switcherOrder(['c', 'gone', 'a'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('sends a top pane to the bottom rail', () => {
    expect([railOf('left'), railOf('right'), railOf('top'), railOf('bottom')]).toEqual(['l', 'r', 'b', 'b']);
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoHide } from './AutoHide';
import { Menu } from './Menu';
import { Picker } from './Picker';
import { TOOL_TITLES, type ToolId } from './ids';

describe('Menu keyboard', () => {
  const setup = () => {
    const onClose = vi.fn(), a = vi.fn(), c = vi.fn(), dis = vi.fn();
    render(<Menu label="Test" anchor={{ x: 0, y: 0, doc: document }} onClose={onClose} entries={[
      { id: 'a', label: 'Alpha', onSelect: a },
      'separator',
      { id: 'd', label: 'Dead', disabled: true, onSelect: dis },
      { id: 'c', label: 'Gamma', onSelect: c },
    ]} />);
    return { onClose, a, c, dis };
  };
  const focused = () => { const a = document.activeElement as HTMLElement | null; return a?.getAttribute('role') === 'menuitem' ? a.textContent ?? '' : 'NONE'; };

  it('focuses the first enabled item when it opens', () => {
    setup();
    expect(focused()).toContain('Alpha');
  });

  it('moves with the arrows, skipping separators and disabled items, and wraps', () => {
    setup();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(focused()).toContain('Gamma');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(focused()).toContain('Alpha');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(focused()).toContain('Gamma');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(focused()).toContain('Alpha');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(focused()).toContain('Gamma');
  });

  it('activates the focused item with Enter or Space', () => {
    const { a, c, onClose } = setup();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(a).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    fireEvent.keyDown(document.activeElement!, { key: ' ' });
    expect(c).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Menu in a second document', () => {
  it('portals into that document and listens there, not on the global one', () => {
    const other = document.implementation.createHTMLDocument('pop-out');
    const onOther = vi.spyOn(other, 'addEventListener');
    const onGlobal = vi.spyOn(document, 'addEventListener');
    const onClose = vi.fn();
    render(<Menu label="Test" anchor={{ x: 0, y: 0, doc: other }} onClose={onClose} entries={[{ id: 'a', label: 'A', onSelect: () => {} }]} />);

    expect(other.body.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(onOther.mock.calls.some(([type]) => type === 'pointerdown')).toBe(true);
    expect(onGlobal.mock.calls.some(([type]) => type === 'pointerdown')).toBe(false);

    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    other.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
    onGlobal.mockRestore();
  });
});

describe('Picker', () => {
  const items = [{ id: '1', label: 'orders_1', open: false }, { id: '2', label: 'Billing_2', open: true }];
  const setup = () => {
    const onPick = vi.fn(), onClose = vi.fn();
    render(<Picker items={items} anchor={{ x: 0, y: 0, doc: document }} onPick={onPick} onClose={onClose} />);
    return { onPick, onClose, input: screen.getByRole('textbox', { name: /Search workflows/ }) };
  };

  it('focuses the input, filters while typing and picks the first match on Enter', () => {
    const { onPick, onClose, input } = setup();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'bill' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('2');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Esc inside the input', () => {
    const { onPick, onClose, input } = setup();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('AutoHide', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hidden: ToolId[] = ['inspector', 'output'];
  const view = (over: Partial<Parameters<typeof AutoHide>[0]> = {}) => {
    const onOpen = vi.fn(), onClose = vi.fn(), onPin = vi.fn();
    const props = {
      hidden, sideOf: (id: string) => (id === 'inspector' ? 'right' as const : 'bottom' as const), titleOf: (id: string) => TOOL_TITLES[id as ToolId],
      flyId: null as string | null, fresh: new Set<string>(), onOpen, onClose, onPin, renderPane: (id: string) => <div>{id} body</div>, ...over,
    };
    const r = render(<AutoHide {...props} />);
    return { ...r, onOpen, onClose, onPin, props };
  };

  it('opens after resting 280 ms on a tab, and not before', () => {
    const { onOpen } = view();
    const tab = screen.getByRole('tab', { name: /Inspector/ });
    fireEvent.pointerEnter(tab);
    act(() => { vi.advanceTimersByTime(279); });
    expect(onOpen).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(onOpen).toHaveBeenCalledWith('inspector');
  });

  it('does not open when the pointer leaves the tab first', () => {
    const { onOpen } = view();
    const tab = screen.getByRole('tab', { name: /Inspector/ });
    fireEvent.pointerEnter(tab);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.pointerLeave(tab);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('closes 550 ms after leaving both tab and pane', () => {
    const { onClose } = view({ flyId: 'inspector' });
    fireEvent.pointerLeave(screen.getByRole('region', { name: 'Inspector' }));
    act(() => { vi.advanceTimersByTime(549); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles on click, by pointer or keyboard', () => {
    const closed = view();
    fireEvent.click(screen.getByRole('tab', { name: /Inspector/ }));
    expect(closed.onOpen).toHaveBeenCalledWith('inspector');
    fireEvent.keyDown(screen.getByRole('tab', { name: /Output/ }), { key: 'Enter' });
    expect(closed.onOpen).toHaveBeenCalledWith('output');
    closed.unmount();

    const open = view({ flyId: 'inspector' });
    const tab = screen.getByRole('tab', { name: /Inspector/ });
    expect(tab).toHaveAttribute('tabindex', '0');
    fireEvent.click(tab);
    fireEvent.keyDown(tab, { key: ' ' });
    expect(open.onClose).toHaveBeenCalledTimes(2);
  });

  it('marks a fresh tab', () => {
    view({ fresh: new Set<ToolId>(['output']) });
    expect(screen.getByRole('tab', { name: /Output/ })).toHaveClass('fresh');
    expect(screen.getByRole('tab', { name: /Inspector/ })).not.toHaveClass('fresh');
  });

  it('closes on a press outside, but not inside the pane or on its tab', () => {
    const { onClose } = view({ flyId: 'inspector' });
    fireEvent.pointerDown(screen.getByText('inspector body'));
    fireEvent.pointerDown(screen.getByRole('tab', { name: /Inspector/ }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('listens on the pane\'s own document', () => {
    const add = vi.spyOn(document, 'addEventListener');
    view({ flyId: 'inspector' });
    expect(add.mock.calls.some(([t]) => t === 'pointerdown')).toBe(true);
    add.mockRestore();
  });

  it('does not close again after the pane closed another way', () => {
    const { onClose, rerender, props } = view({ flyId: 'inspector' });
    fireEvent.pointerLeave(screen.getByRole('region', { name: 'Inspector' }));
    rerender(<AutoHide {...props} flyId={null} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes timers and listeners on unmount', () => {
    const { onClose, onOpen, unmount } = view({ flyId: 'inspector' });
    fireEvent.pointerLeave(screen.getByRole('region', { name: 'Inspector' }));
    fireEvent.pointerEnter(screen.getByRole('tab', { name: /Output/ }));
    const remove = vi.spyOn(document, 'removeEventListener');
    unmount();
    expect(remove.mock.calls.some(([t]) => t === 'pointerdown')).toBe(true);
    remove.mockRestore();
    fireEvent.pointerDown(document.body);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

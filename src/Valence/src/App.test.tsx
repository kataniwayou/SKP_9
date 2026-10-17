import { act, fireEvent, render, screen, within } from '@testing-library/react';
// dockview's jsdom layout leaves the document panel hidden, where jsdom gives no accessible names: it is found by selector. The browser check covers it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { SESSION_KEY } from './app/session';
import { SHORTCUTS } from './app/shortcuts';
import { memoryStorage } from './test/memoryStorage';

const setup = (storage = memoryStorage(), tabStorage = memoryStorage()) => {
  const view = render(<div style={{ width: 1200, height: 700 }}><App storage={storage} tabStorage={tabStorage} /></div>);
  return { storage, tabStorage, view };
};
const tab = (name: string) => screen.getAllByText(name, { selector: '.doctab .nm' })[0]!.closest('.doctab') as HTMLElement;

describe('App', () => {
  // BaseApi never answers here: the document stays at "Reading the project…" (ProjectDocument's own tests read it)
  beforeEach(() => { vi.stubGlobal('fetch', () => new Promise(() => {})); return () => vi.unstubAllGlobals(); });

  it('shows the one pinned document, named Canvas, and the three panes', () => {
    setup();
    expect(within(tab('Canvas')).queryByRole('button', { name: 'Close Canvas' })).toBeNull();
    for (const name of ['Inspector', 'Toolbox', 'Output']) expect(tab(name)).toBeInTheDocument();
    // no toolbar on the canvas (the user, 2026-10-15)
    expect(document.querySelector('.docpanel')).not.toBeNull();
    expect(document.querySelector('.docpanel .docbar')).toBeNull();
    expect(document.querySelector('[data-pane="inspector"]')).toHaveTextContent('Reading the project…'); // BaseApi never answers here
    expect(document.querySelector('[data-pane="output"]')).toHaveTextContent('No messages.');
    expect(document.querySelector('[data-pane="toolbox"]')).toBeInTheDocument();
  });

  it('has View, Window and Shortcuts on the menu strip: nothing is loaded, created or deleted from a menu', () => {
    setup();
    expect(within(screen.getByRole('menubar')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['View', 'Window', 'Shortcuts']);
  });

  it('lists every key stroke under Shortcuts, by group (the user, 2026-10-17)', () => {
    setup();
    fireEvent.click(within(screen.getByRole('menubar')).getByRole('menuitem', { name: 'Shortcuts' }));
    const sheet = screen.getByRole('dialog', { name: 'Shortcuts' });
    const keys = [...sheet.querySelectorAll('.sc-row kbd')].map((k) => k.textContent);
    for (const k of ['Delete', 'Ctrl+Z', 'Ctrl+Y · Ctrl+Shift+Z', 'Ctrl+C', 'Ctrl+V', 'Escape', 'Ctrl+E', 'Ctrl+Shift+E', 'Ctrl+drag', 'Ctrl+drag an atom', 'Hover an atom', 'Right-drag', 'Pinch']) expect(keys).toContain(k);
    expect(keys).toHaveLength(SHORTCUTS.reduce((n, g) => n + g.items.length, 0));
    // two columns: the left's groups first, then the right's
    expect([...sheet.querySelectorAll('.sc-h')].map((h) => h.textContent)).toEqual([...SHORTCUTS.filter((g) => g.column === 0), ...SHORTCUTS.filter((g) => g.column === 1)].map((g) => g.group));
  });

  it('has the workflow filter at the right of the menu strip (the user, 2026-10-16)', () => {
    setup();
    const strip = screen.getByRole('menubar');
    const filter = within(strip).getByRole('button', { name: /Workflows/ });
    expect(filter.closest('.mstatus')).not.toBeNull();
    expect(filter).toHaveTextContent('none highlighted');
    act(() => filter.click());
    expect(within(strip).getByText('Reading the project…')).toBeInTheDocument(); // BaseApi never answers here
  });

  it('keeps the picked workflows in the session', () => {
    const tabStorage = memoryStorage({ [SESSION_KEY]: JSON.stringify({ version: 1, dock: null, highlighted: ['a'] }) });
    const { view } = setup(memoryStorage(), tabStorage);
    act(() => view.unmount()); // the unmount flushes a pending write
    expect(JSON.parse(tabStorage.getItem(SESSION_KEY)!).highlighted).toEqual(['a']);
  });
});

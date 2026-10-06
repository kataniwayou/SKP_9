import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockShell, type DockDocument, type DockShellProps } from './DockShell';
import { LAYOUT_KEY } from './layoutPersistence';
import { memoryStorage } from '../test/memoryStorage';


const doc = (id: string): DockDocument => ({ id, name: `wf-${id}`, version: '1.0.0', tooltip: `wf-${id}_1.0.0-${id}` });

function setup(over: Partial<DockShellProps> = {}) {
  const props: DockShellProps = {
    documents: [],
    activeDocumentId: null,
    onActivateDocument: vi.fn(),
    onCloseDocument: vi.fn(),
    workflows: [{ id: 'a', label: 'orders_1.0.0-aaaa', open: false }, { id: 'b', label: 'billing_2.0.0-bbbb', open: true }],
    onOpenWorkflow: vi.fn(),
    renderDocument: (id) => <div>canvas of {id}</div>,
    renderTool: (id) => <div>body of {id}</div>,
    inspectorKey: 'k0',
    onEscape: vi.fn(),
    storage: memoryStorage(),
    ...over,
  };
  const view = render(<div style={{ width: 1200, height: 700 }}><DockShell {...props} /></div>);
  const update = (next: Partial<DockShellProps>) => {
    Object.assign(props, next);
    view.rerender(<div style={{ width: 1200, height: 700 }}><DockShell {...props} /></div>);
  };
  return { props, update };
}

const tab = (name: string) => screen.getAllByText(name, { selector: '.doctab .nm' })[0]!.closest('.doctab') as HTMLElement;
const toast = () => document.querySelector('.toast') as HTMLElement;
const railTab = (id: string) => document.querySelector(`[data-rt="${id}"]`) as HTMLElement | null;
const flyout = () => document.querySelector('.fly') as HTMLElement | null;
const openMenu = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }));
const choose = (label: RegExp | string) => fireEvent.click(screen.getByRole('menuitem', { name: label }));

afterEach(() => { vi.useRealTimers(); });

describe('DockShell', () => {
  it('starts with the default layout: the four panes and an empty document area', () => {
    setup();
    for (const name of ['Inspector', 'Toolbox', 'Problems', 'Output']) expect(tab(name)).toBeInTheDocument();
    expect(screen.getByText('No workflow open')).toBeInTheDocument();
    expect(screen.getByText('body of inspector')).toBeInTheDocument();
  });

  it('opens a tab for each document, renders it, and closes it when the document goes', () => {
    const { update } = setup();
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'b' });
    expect(tab('wf-a')).toHaveAttribute('data-tip', 'wf-a_1.0.0-a');
    expect(screen.getByText('canvas of a')).toBeInTheDocument();
    expect(screen.getByText('canvas of b')).toBeInTheDocument();

    update({ documents: [doc('b')] });
    expect(screen.queryByText('canvas of a')).toBeNull();
  });

  it('asks the page to close a document from its ×, a middle click and Alt+W', () => {
    const { props, update } = setup();
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'b' });

    fireEvent.click(within(tab('wf-a')).getByRole('button', { name: 'Close wf-a' }));
    fireEvent(tab('wf-b'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent.keyDown(window, { key: 'w', altKey: true });

    expect(vi.mocked(props.onCloseDocument).mock.calls).toEqual([['a'], ['b'], ['b']]);
  });

  it('hides and shows a pane from the View menu', () => {
    setup();
    openMenu('View');
    choose(/Problems/);
    expect(screen.queryByText('body of problems')).toBeNull();
    openMenu('View');
    choose(/Problems/);
    expect(screen.getByText('body of problems')).toBeInTheDocument();
  });

  it('auto-hides a pane from its tab menu, slides it out from the rail, and docks it back', () => {
    setup();
    fireEvent.contextMenu(tab('Inspector'));
    choose(/Auto hide/);
    // hidden in place: dockview keeps the group's slot and size, so pinning back is exact
    const slot = () => tab('Inspector').closest('.dv-view')!;
    expect(slot()).not.toHaveClass('visible');

    fireEvent.click(railTab('inspector')!);
    expect(within(flyout()!).getByText('body of inspector')).toBeInTheDocument();

    fireEvent.click(within(flyout()!).getByRole('button', { name: /Dock/ }));
    expect(flyout()).toBeNull();
    expect(railTab('inspector')).toBeNull();
    expect(slot()).toHaveClass('visible');
  });

  it('makes a hidden Inspector glow when its content changes, until it is opened', () => {
    const { update } = setup();
    fireEvent.contextMenu(tab('Inspector'));
    choose(/Auto hide/);
    expect(railTab('inspector')).not.toHaveClass('fresh');

    update({ inspectorKey: 'k1' });
    expect(railTab('inspector')).toHaveClass('fresh');

    fireEvent.click(railTab('inspector')!);
    expect(railTab('inspector')).not.toHaveClass('fresh');
  });

  it('saves, resets and applies the window layout', () => {
    const storage = memoryStorage();
    setup({ storage });
    fireEvent.contextMenu(tab('Output'));
    choose(/Auto hide/);

    openMenu('Window');
    choose(/Save window layout/);
    expect(toast()).toHaveTextContent('Window layout saved in this browser');
    expect(JSON.parse(storage.getItem(LAYOUT_KEY)!).hidden).toEqual(['problems', 'output']);

    openMenu('Window');
    choose(/Reset window layout/);
    expect(railTab('output')).toBeNull();
    expect(tab('Output')).toBeInTheDocument();

    openMenu('Window');
    choose(/Apply saved layout/);
    expect(railTab('output')).toBeInTheDocument();
    expect(railTab('problems')).toBeInTheDocument();
  });

  it.each([
    ['corrupted', '{"version":1,"dock":'],
    ['from an older version', JSON.stringify({ version: 0, dock: {} })],
    ['rejected by dockview', JSON.stringify({ version: 1, dock: { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: {} }] }, width: 1, height: 1, orientation: 'HORIZONTAL' }, panels: {} }, hidden: [], sides: {}, homes: {}, documentGroupId: null })],
  ])('falls back to the default layout when the saved one is %s (review focus 1)', (_name, text) => {
    setup({ storage: memoryStorage({ [LAYOUT_KEY]: text }) });
    for (const name of ['Inspector', 'Toolbox', 'Problems', 'Output']) expect(tab(name)).toBeInTheDocument();
  });

  it('opens the picker from File, filters it, and opens the first match on Enter', () => {
    const { props } = setup();
    openMenu('File');
    choose(/Open workflow/);
    const search = screen.getByRole('textbox', { name: 'Search workflows' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['orders_1.0.0-aaaa', 'billing_2.0.0-bbbbopen — switch']);

    fireEvent.change(search, { target: { value: 'BILL' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(props.onOpenWorkflow).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('dialog', { name: 'Open workflow' })).toBeNull();
  });

  it('keeps Edit present but disabled, and Start/Stop keys harmless', () => {
    setup();
    openMenu('Edit');
    for (const item of screen.getAllByRole('menuitem').filter((m) => m.classList.contains('mi'))) expect(item).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(window, { key: 'F5' });
    expect(toast()).toHaveTextContent('Start and Stop are not available yet.');
  });

  it('toggles a strip menu with its own button', () => {
    setup();
    openMenu('File');
    expect(screen.getByRole('menu', { name: 'File' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'File' }));
    openMenu('File');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes an open menu on Esc before it clears the selection', () => {
    const { props } = setup();
    openMenu('View');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(props.onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onEscape).toHaveBeenCalledTimes(1);
  });

  it('switches windows with Ctrl+E, released on Ctrl', () => {
    const { props, update } = setup();
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'b' });
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Switch window' });
    expect(within(dialog).getByRole('listbox', { name: 'Active documents' })).toHaveTextContent('wf-a');

    act(() => { fireEvent.keyUp(window, { key: 'Control' }); });

    expect(screen.queryByRole('dialog', { name: 'Switch window' })).toBeNull();
    expect(props.onActivateDocument).toHaveBeenCalled();
  });

  it('copes with dozens of open documents (review focus 5)', () => {
    const { update } = setup();
    const many = Array.from({ length: 40 }, (_, i) => doc(String(i)));
    update({ documents: many, activeDocumentId: '39' });
    expect(screen.getAllByText(/^canvas of /)).toHaveLength(40);
    update({ documents: many.slice(0, 2), activeDocumentId: '1' });
    expect(screen.getAllByText(/^canvas of /)).toHaveLength(2);
  });
});

// Layouts readLayout accepts (every structural check passes) but dockview rejects halfway through
// fromJSON: a new panel (so `reuseExistingPanels` cannot stand in) names a component the dock does
// not have. In the first the failure comes before dockview reaches the open documents (it leaves
// them parked, undisposed); in the second after it has put them back (it disposes them itself).
const rejected = (leaves: { id: string; views: string[] }[], documentGroupId: string | null) => JSON.stringify({
  version: 1,
  dock: {
    grid: { root: { type: 'branch', data: leaves.map((l) => ({ type: 'leaf', data: { ...l, activeView: l.views[0] }, size: 100 })), size: 100 }, width: 100, height: 100, orientation: 'HORIZONTAL' },
    panels: { stray: { id: 'stray', contentComponent: 'no-such-component', title: 'Stray' } },
  },
  hidden: [], sides: {}, homes: {}, documentGroupId,
});
const REJECTED_BY_DOCKVIEW = rejected([{ id: '1', views: ['stray'] }], null);
const REJECTED_AFTER_DOCUMENTS = rejected([{ id: '1', views: [] }, { id: '2', views: ['stray'] }], '1');

/** Runs `run` expecting dockview's "failed to deserialize layout" error, kept out of the output. */
function expectingDockviewRejection(run: () => void) {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    run();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('failed to deserialize layout'), expect.anything());
  } finally {
    logged.mockRestore();
  }
}

const docTabs = (name: string) => screen.queryAllByText(name, { selector: '.doctab .nm' });

describe('DockShell, a layout dockview rejects', () => {
  it('falls back to the default layout at startup, with a toast', () => {
    expectingDockviewRejection(() => { setup({ storage: memoryStorage({ [LAYOUT_KEY]: REJECTED_BY_DOCKVIEW }) }); });
    for (const name of ['Inspector', 'Toolbox', 'Problems', 'Output']) expect(docTabs(name)).toHaveLength(1);
    expect(toast()).toHaveTextContent('The saved window layout could not be applied; the default layout is shown.');
  });

  it.each([
    ['before it reaches the open documents', REJECTED_BY_DOCKVIEW],
    ['after it has placed the open documents', REJECTED_AFTER_DOCUMENTS],
  ])('keeps each open document exactly once when Apply is rejected %s', (_when, layout) => {
    const storage = memoryStorage();
    const { props, update } = setup({ storage });
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'a' });
    storage.setItem(LAYOUT_KEY, layout);

    expectingDockviewRejection(() => { openMenu('Window'); choose(/Apply saved layout/); });

    expect(toast()).toHaveTextContent('The saved window layout could not be applied; the default layout is shown.');
    for (const id of ['a', 'b']) {
      expect(docTabs(`wf-${id}`)).toHaveLength(1);
      expect(screen.getAllByText(`canvas of ${id}`)).toHaveLength(1);
    }
    expect(tab('wf-a').closest('.dv-groupview')).toBe(tab('wf-b').closest('.dv-groupview'));
    for (const name of ['Inspector', 'Toolbox', 'Problems', 'Output']) expect(docTabs(name)).toHaveLength(1);
    // the documents dockview dropped are disposed: no second canvas, no empty overlay left behind
    expect([...document.querySelectorAll('.dv-render-overlay')].map((o) => o.textContent).sort()).toEqual(['canvas of a', 'canvas of b']);
    expect(props.onCloseDocument).not.toHaveBeenCalled();
  });
});

describe('DockShell, the Esc order in the main window', () => {
  const slideOutInspector = () => {
    fireEvent.contextMenu(tab('Inspector'));
    choose(/Auto hide/);
    fireEvent.click(railTab('inspector')!);
    expect(flyout()).not.toBeNull();
  };
  const esc = () => fireEvent.keyDown(window, { key: 'Escape' });
  const switcherShown = () => screen.queryByRole('dialog', { name: 'Switch window' }) !== null;
  const pickerShown = () => screen.queryByRole('dialog', { name: 'Open workflow' }) !== null;
  const menuShown = () => screen.queryByRole('menu') !== null;

  it('closes the switcher, then the menu, then the flyout, then clears the selection', () => {
    const { props } = setup();
    slideOutInspector();
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    openMenu('View');
    expect([switcherShown(), menuShown(), flyout() !== null]).toEqual([true, true, true]);

    esc();
    expect([switcherShown(), menuShown(), flyout() !== null]).toEqual([false, true, true]);
    esc();
    expect([menuShown(), flyout() !== null]).toEqual([false, true]);
    esc();
    expect(flyout()).toBeNull();
    expect(props.onEscape).not.toHaveBeenCalled();
    esc();
    expect(props.onEscape).toHaveBeenCalledTimes(1);
  });

  it('closes the switcher, then the picker, then the flyout, then clears the selection', () => {
    const { props } = setup();
    slideOutInspector();
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open workflow…' }));
    expect([switcherShown(), pickerShown(), flyout() !== null]).toEqual([true, true, true]);

    esc();
    expect([switcherShown(), pickerShown(), flyout() !== null]).toEqual([false, true, true]);
    esc();
    expect([pickerShown(), flyout() !== null]).toEqual([false, true]);
    esc();
    expect(flyout()).toBeNull();
    expect(props.onEscape).not.toHaveBeenCalled();
    esc();
    expect(props.onEscape).toHaveBeenCalledTimes(1);
  });

  it('lets the picker take Esc in its own search box, without clearing the selection', () => {
    const { props } = setup();
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search workflows' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Open workflow' })).toBeNull();
    expect(props.onEscape).not.toHaveBeenCalled();
  });
});

describe('DockShell, pop-out windows', () => {
  let frames: HTMLIFrameElement[] = [];
  afterEach(() => { vi.restoreAllMocks(); frames.forEach((f) => f.remove()); frames = []; });

  /** Pops a tab's group out through its pop-out button; the "window" is an iframe that answers window.open. */
  async function popOut(tabName: string): Promise<Window> {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    frames.push(frame);
    const win = frame.contentWindow!;
    vi.spyOn(window, 'open').mockImplementation(() => win);
    const group = tab(tabName).closest('.dv-groupview') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Pop out to its own window' }));
    await act(async () => {
      win.dispatchEvent(new (win as Window & typeof globalThis).Event('load'));
      await new Promise((r) => setTimeout(r, 0));
    });
    return win;
  }
  const inPopout = (win: Window) => within(win.document.body);
  const popoutTab = (win: Window, name: string) => inPopout(win).getAllByText(name, { selector: '.doctab .nm' })[0]!;

  it('moves the group into the pop-out, with the page content and its own tooltip layer', async () => {
    setup({ popoutContent: <svg data-testid="defs" /> });
    const win = await popOut('Output');
    expect(inPopout(win).getAllByText('Output', { selector: '.doctab .nm' })).toHaveLength(1);
    // getBy* throws when it finds nothing; toBeInTheDocument cannot judge a node of another window
    expect(inPopout(win).getByText('body of problems').ownerDocument).toBe(win.document);
    expect(inPopout(win).getByTestId('defs').parentElement).toBe(win.document.body);
    expect(win.document.querySelector('.tip[role="tooltip"]')).not.toBeNull();
  });

  it('opens the window-position menu, the switcher, the picker and toasts in the pop-out', async () => {
    const { props, update } = setup();
    update({ documents: [doc('a')], activeDocumentId: 'a' });
    const win = await popOut('Output');

    fireEvent.contextMenu(popoutTab(win, 'Output'));
    expect(inPopout(win).getByRole('menu', { name: 'Window position' })).toBeInTheDocument();
    fireEvent.keyDown(win, { key: 'Escape' });
    expect(inPopout(win).queryByRole('menu')).toBeNull();

    fireEvent.keyDown(win, { key: 'e', ctrlKey: true });
    expect(inPopout(win).getByRole('dialog', { name: 'Switch window' })).toBeInTheDocument();
    fireEvent.keyDown(win, { key: 'Escape' });

    fireEvent.keyDown(win, { key: 'o', ctrlKey: true });
    expect(inPopout(win).getByRole('dialog', { name: 'Open workflow' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Open workflow' })).toBeNull();
    fireEvent.keyDown(win, { key: 'Escape' });

    fireEvent.keyDown(win, { key: 'F5', shiftKey: true });
    expect(win.document.querySelector('.toast')).toHaveTextContent('Start and Stop are not available yet.');

    fireEvent.keyDown(win, { key: 'w', altKey: true });
    expect(props.onCloseDocument).toHaveBeenCalledWith('a');
    expect(props.onEscape).not.toHaveBeenCalled();
  });

  it('keeps the Esc order in a pop-out: switcher, menu, picker, flyout, then the selection', async () => {
    const { props } = setup();
    const win = await popOut('Output');
    fireEvent.contextMenu(tab('Inspector'));
    choose(/Auto hide/);
    fireEvent.click(railTab('inspector')!);
    const esc = () => fireEvent.keyDown(win, { key: 'Escape' });
    const shown = () => ({
      switcher: inPopout(win).queryByRole('dialog', { name: 'Switch window' }) !== null,
      menu: inPopout(win).queryByRole('menu') !== null,
      picker: inPopout(win).queryByRole('dialog', { name: 'Open workflow' }) !== null,
      flyout: flyout() !== null,
    });

    fireEvent.keyDown(win, { key: 'e', ctrlKey: true });
    fireEvent.contextMenu(popoutTab(win, 'Output'));
    expect(shown()).toEqual({ switcher: true, menu: true, picker: false, flyout: true });
    esc();
    expect(shown()).toEqual({ switcher: false, menu: true, picker: false, flyout: true });
    esc();
    expect(shown()).toEqual({ switcher: false, menu: false, picker: false, flyout: true });

    fireEvent.keyDown(win, { key: 'o', ctrlKey: true });
    expect(shown()).toEqual({ switcher: false, menu: false, picker: true, flyout: true });
    esc();
    expect(shown()).toEqual({ switcher: false, menu: false, picker: false, flyout: true });
    esc();
    expect(shown()).toEqual({ switcher: false, menu: false, picker: false, flyout: false });
    expect(props.onEscape).not.toHaveBeenCalled();
    esc();
    expect(props.onEscape).toHaveBeenCalledTimes(1);
  });

  it('stops listening to a pop-out once its group is docked back', async () => {
    const { props } = setup();
    const win = await popOut('Output');
    // jsdom's close() tears the frame's window down, listeners and all, which would hide a leak
    vi.spyOn(win, 'close').mockImplementation(() => {});
    const group = popoutTab(win, 'Output').closest('.dv-groupview') as HTMLElement;
    act(() => { fireEvent.click(within(group).getByRole('button', { name: 'Dock back into the main layout' })); });

    expect(tab('Output')).toBeInTheDocument();
    fireEvent.keyDown(win, { key: 'Escape' });
    expect(props.onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onEscape).toHaveBeenCalledTimes(1);
  });
});

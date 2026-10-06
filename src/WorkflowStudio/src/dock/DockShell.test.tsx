import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockShell, type DockDocument, type DockShellProps } from './DockShell';
import { LAYOUT_KEY } from './layoutPersistence';
import { memoryStorage } from '../test/memoryStorage';
import { DockviewWillShowOverlayLocationEvent, type DockviewApi, type DockviewGroupPanel } from 'dockview-react';

// The dock's dockview api, for tests that must read its state or drive an event no jsdom gesture can
// (a drag's drop overlay). DockviewReact itself is the real one; only its onReady is listened to.
const dockApi = vi.hoisted(() => ({ current: null as DockviewApi | null }));
vi.mock('dockview-react', async (importOriginal) => {
  const real = await importOriginal<typeof import('dockview-react')>();
  const { createElement, useCallback, useRef } = await import('react');
  type Props = Parameters<typeof real.DockviewReact>[0];
  function DockviewReact(props: Props) {
    const onReady = useRef(props.onReady);
    onReady.current = props.onReady;
    const ready = useCallback<NonNullable<Props['onReady']>>((e) => { dockApi.current = e.api; onReady.current?.(e); }, []);
    return createElement(real.DockviewReact, { ...props, onReady: ready });
  }
  return { ...real, DockviewReact };
});

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

describe('DockShell, pop-out windows', () => {
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

/**
 * The Esc order (switcher, menu, picker, flyout, then the selection) as a real keypress drives it:
 * every key goes to the focused element of the window it is pressed in, so an overlay that takes
 * keys itself (the picker's search box, a menu's items) is in the path. The menu, the picker and
 * the switcher are mutually exclusive: opening one closes the others.
 */
describe.each(['main window', 'pop-out'] as const)('DockShell, the Esc order in the %s', (where) => {
  async function start() {
    const view = setup();
    view.update({ documents: [doc('a'), doc('b')], activeDocumentId: 'a' });
    const win = where === 'pop-out' ? await popOut('Output') : window;
    const d = win.document;
    fireEvent.contextMenu(tab('Inspector'));
    choose(/Auto hide/);
    fireEvent.click(railTab('inspector')!);
    vi.mocked(view.props.onActivateDocument).mockClear();
    const key = (key: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(d.activeElement ?? d.body, { key, ...init });
    const scope = within(d.body);
    const shown = () => ({
      switcher: scope.queryByRole('dialog', { name: 'Switch window' }) !== null,
      menu: scope.queryByRole('menu') !== null,
      picker: scope.queryByRole('dialog', { name: 'Open workflow' }) !== null,
      flyout: flyout() !== null,
    });
    const openMenuHere = () => {
      if (where === 'pop-out') fireEvent.contextMenu(popoutTab(win, 'Output'));
      else openMenu('View');
    };
    return { ...view, win, d, key, shown, openMenuHere };
  }
  const none = { switcher: false, menu: false, picker: false };

  /** After the overlays are gone: Esc slides the flyout back, and only the next Esc clears the selection. */
  function expectFlyoutThenSelection(run: Awaited<ReturnType<typeof start>>) {
    expect(run.shown()).toEqual({ ...none, flyout: true });
    run.key('Escape');
    expect(run.shown()).toEqual({ ...none, flyout: false });
    expect(run.props.onEscape).not.toHaveBeenCalled();
    run.key('Escape');
    expect(run.props.onEscape).toHaveBeenCalledTimes(1);
  }

  it('closes the switcher, then the flyout, then clears the selection', async () => {
    const run = await start();
    run.key('e', { ctrlKey: true });
    expect(run.shown()).toEqual({ ...none, switcher: true, flyout: true });
    run.key('Escape');
    expectFlyoutThenSelection(run);
  });

  it('closes a menu (Esc on its focused item), then the flyout, then clears the selection', async () => {
    const run = await start();
    run.openMenuHere();
    expect(run.shown()).toEqual({ ...none, menu: true, flyout: true });
    expect(run.d.activeElement?.getAttribute('role')).toBe('menuitem');
    run.key('Escape');
    expectFlyoutThenSelection(run);
  });

  it('closes the picker (Esc in its search box), then the flyout, then clears the selection', async () => {
    const run = await start();
    run.key('o', { ctrlKey: true });
    expect(run.shown()).toEqual({ ...none, picker: true, flyout: true });
    expect(run.d.activeElement?.getAttribute('aria-label')).toBe('Search workflows');
    run.key('Escape');
    expectFlyoutThenSelection(run);
  });

  it('replaces the switcher with the picker on Ctrl+E then O, so one Esc closes what is shown', async () => {
    const run = await start();
    run.key('e', { ctrlKey: true });
    run.key('o', { ctrlKey: true });
    expect(run.shown()).toEqual({ ...none, picker: true, flyout: true });
    run.key('Escape');
    expectFlyoutThenSelection(run);
  });

  it('replaces the switcher with a menu, and the picker with the switcher', async () => {
    const run = await start();
    run.key('e', { ctrlKey: true });
    run.openMenuHere();
    expect(run.shown()).toEqual({ ...none, menu: true, flyout: true });
    run.key('Escape');
    run.key('o', { ctrlKey: true });
    run.key('e', { ctrlKey: true });
    expect(run.shown()).toEqual({ ...none, switcher: true, flyout: true });
    run.key('Escape');
    expectFlyoutThenSelection(run);
  });

  it('lets Enter in the picker open the workflow without finishing a switcher', async () => {
    const run = await start();
    run.key('e', { ctrlKey: true });
    run.key('o', { ctrlKey: true });
    // billing is document b: picking it focuses that tab, and nothing else may be activated after it
    fireEvent.change(run.d.activeElement!, { target: { value: 'BILL' } });
    run.key('Enter');
    act(() => { fireEvent.keyUp(run.win, { key: 'Control' }); });

    expect(run.props.onOpenWorkflow).toHaveBeenCalledWith('b');
    expect(vi.mocked(run.props.onActivateDocument).mock.calls).toEqual([['b']]);
    expect(run.shown()).toEqual({ ...none, flyout: true });
  });
});

const groupOf = (name: string) => tab(name).closest('.dv-groupview') as HTMLElement;
const floating = (name: string) => groupOf(name).classList.contains('dv-groupview-floating');
const api = () => dockApi.current!;

describe('DockShell, tab gestures and the window-position menu (spec 6.2)', () => {
  const withDocuments = () => {
    const view = setup();
    view.update({ documents: [doc('a'), doc('b')], activeDocumentId: 'a' });
    return view;
  };

  it('floats a tab on Ctrl+double-click and docks it back on the next', () => {
    withDocuments();
    fireEvent.doubleClick(tab('Toolbox'), { ctrlKey: true });
    expect(floating('Toolbox')).toBe(true);
    fireEvent.doubleClick(tab('Toolbox'), { ctrlKey: true });
    expect(floating('Toolbox')).toBe(false);

    fireEvent.doubleClick(tab('wf-a'), { ctrlKey: true });
    expect(floating('wf-a')).toBe(true);
    fireEvent.doubleClick(tab('wf-a'), { ctrlKey: true });
    expect(floating('wf-a')).toBe(false);
    expect(groupOf('wf-a')).toBe(groupOf('wf-b'));
  });

  it('maximizes a tab group on double-click and restores it on the next', () => {
    withDocuments();
    const group = () => api().getPanel('doc:a')!.group;
    fireEvent.doubleClick(tab('wf-a'));
    expect(group().api.isMaximized()).toBe(true);
    fireEvent.contextMenu(tab('wf-a'));
    expect(screen.getByRole('menuitem', { name: /Restore/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.doubleClick(tab('wf-a'));
    expect(group().api.isMaximized()).toBe(false);
    fireEvent.contextMenu(tab('wf-a'));
    expect(screen.getByRole('menuitem', { name: /Maximize/ })).toBeInTheDocument();
  });

  it('opens the window-position menu from a tool group header', () => {
    withDocuments();
    fireEvent.click(within(groupOf('Toolbox')).getByRole('button', { name: 'Window position' }));
    const menu = screen.getByRole('menu', { name: 'Window position' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.querySelector('.ml')!.textContent)).toEqual(
      ['⧉Float', '▤Dock as tabbed document', '⇥Auto hide', '×Close'],
    );
  });

  it('floats a pane from the menu, and docks it back from the floating menu', () => {
    withDocuments();
    fireEvent.contextMenu(tab('Toolbox'));
    choose(/^.Float/);
    expect(floating('Toolbox')).toBe(true);

    fireEvent.contextMenu(tab('Toolbox'));
    expect(screen.queryByRole('menuitem', { name: /^.Float/ })).toBeNull();
    choose(/^⤓Dock/);
    expect(floating('Toolbox')).toBe(false);
    expect(api().getPanel('toolbox')!.group.api.location.type).toBe('grid');
  });

  it('docks a pane as a tabbed document from the menu', () => {
    withDocuments();
    fireEvent.contextMenu(tab('Toolbox'));
    choose(/Dock as tabbed document/);
    expect(groupOf('Toolbox')).toBe(groupOf('wf-a'));
    expect(api().activePanel?.id).toBe('toolbox');
  });

  it('closes a pane from the menu, and asks the page to close a document', () => {
    const { props } = withDocuments();
    fireEvent.contextMenu(tab('Toolbox'));
    choose(/^.Close/);
    expect(screen.queryAllByText('Toolbox', { selector: '.doctab .nm' })).toHaveLength(0);
    expect(api().getPanel('toolbox')).toBeUndefined();

    fireEvent.contextMenu(tab('wf-b'));
    choose(/Close document/);
    expect(props.onCloseDocument).toHaveBeenCalledWith('b');
    expect(api().getPanel('doc:b')).toBeDefined(); // the page's new documents remove it
  });

  it('focuses an open workflow picked again, adding nothing', () => {
    const { props } = withDocuments();
    const before = api().panels.length;
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    fireEvent.click(screen.getByRole('option', { name: /billing/ }));
    expect(props.onOpenWorkflow).toHaveBeenCalledWith('b');
    expect(api().activePanel?.id).toBe('doc:b');
    expect(api().panels).toHaveLength(before);
    expect(screen.getAllByText('wf-b', { selector: '.doctab .nm' })).toHaveLength(1);
  });

  it('keeps F5 and Shift+F5 from reaching the browser (never a reload)', () => {
    setup();
    expect(fireEvent.keyDown(window, { key: 'F5' })).toBe(false);
    expect(fireEvent.keyDown(window, { key: 'F5', shiftKey: true })).toBe(false);
  });
});

describe('DockShell, the drop rules on a drag overlay (spec 6.2.4)', () => {
  /**
   * Fires dockview's onWillShowOverlay as a drag over `group` would (jsdom has no layout, so a real
   * drag never reaches an overlay) and reports whether the dock let the overlay show.
   */
  function overlay(dragged: { panelId: string } | { groupOf: string }, kind: 'tab' | 'header_space' | 'content' | 'edge', over: string | null): boolean {
    const dv = api();
    const source = 'panelId' in dragged ? dv.getPanel(dragged.panelId)! : dv.getPanel(dragged.groupOf)!;
    const data = { viewId: dv.id, groupId: source.group.id, panelId: 'panelId' in dragged ? dragged.panelId : null };
    const native = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    const group: DockviewGroupPanel | undefined = over === null ? undefined : dv.getPanel(over)!.group;
    const event = new DockviewWillShowOverlayLocationEvent(native as never, { kind, group, panel: undefined, api: dv, getData: () => data } as never);
    (dv as unknown as { component: { _onWillShowOverlay: { fire(e: unknown): void } } }).component._onWillShowOverlay.fire(event);
    return !event.defaultPrevented;
  }

  it('refuses a document over a tool pane or the outer edge, and allows it into the document area', () => {
    const { update } = setup();
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'a' });
    expect(overlay({ panelId: 'doc:a' }, 'content', 'toolbox')).toBe(false);
    expect(overlay({ panelId: 'doc:a' }, 'tab', 'problems')).toBe(false);
    expect(overlay({ panelId: 'doc:a' }, 'edge', null)).toBe(false);
    expect(overlay({ groupOf: 'doc:a' }, 'content', 'inspector')).toBe(false);
    expect(overlay({ panelId: 'doc:a' }, 'tab', 'doc:b')).toBe(true);
    expect(overlay({ panelId: 'doc:a' }, 'content', 'doc:b')).toBe(true);
  });

  it('allows a tool pane anywhere', () => {
    const { update } = setup();
    update({ documents: [doc('a')], activeDocumentId: 'a' });
    expect(overlay({ panelId: 'toolbox' }, 'content', 'doc:a')).toBe(true);
    expect(overlay({ panelId: 'toolbox' }, 'tab', 'problems')).toBe(true);
    expect(overlay({ panelId: 'toolbox' }, 'edge', null)).toBe(true);
    expect(overlay({ groupOf: 'problems' }, 'content', 'inspector')).toBe(true);
  });
});

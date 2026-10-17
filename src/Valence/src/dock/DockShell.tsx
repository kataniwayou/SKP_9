import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DockviewReact, themeVisualStudio, type DockviewApi, type DockviewGroupPanel, type DockviewPanelApi, type DockviewReadyEvent } from 'dockview-react';
import { AutoHide } from './AutoHide';
import { canDrop } from './dropRules';
import type { Rect } from './home';
import { docPanelId, documentIdOf, isDocPanelId, isToolId, TOOL_IDS, TOOL_TITLES, type PaneId, type ToolId } from './ids';
import { keyCommand } from './keys';
import { browserStorage, readLayout, writeLayout, type SavedLayout } from './layoutPersistence';
import { anchorBelow, Menu, type Anchor, type MenuEntry } from './Menu';
import { DocumentHost, GroupActions, ShellProvider, StudioTab, ToolHost, Watermark, type DockDocument, type GroupAction, type ShellApi } from './parts';
import { Picker, type PickerItem } from './Picker';
import { Switcher, switcherOrder, touch } from './Switcher';
import { Tooltips } from './Tooltip';
import { windowKey } from './windowKey';
import {
  addDocument, applyLayout, autoHide, captureLayout, closeTool, dockAsDocument, dockBack, documentArea, ensureDocumentArea, floatGroup,
  floatPanel, markDocumentArea, newMemory, pinBack as pinToolBack, resetLayout, showTool, toggleFloatMaximize, toolSide,
} from './windowActions';

export type { DockDocument } from './parts';
export type { PickerItem } from './Picker';

export interface DockShellProps {
  /** The open documents, in the order they were opened. The dock adds and removes their panels to match. */
  documents: readonly DockDocument[];
  /** The document the shared panes follow; when it changes, its tab is focused. */
  activeDocumentId: string | null;
  onActivateDocument: (id: string) => void;
  /** `doc`: the window the close came from (a pop-out's, for one there), where the page may ask first. */
  onCloseDocument: (id: string, doc?: Document) => void;
  /**
   * The picker's list (spec §6.1: searchable, by unique name). Valence: absent, there is nothing to load (it shows
   * one document, the whole project): no Ctrl+O, no + on the document group, no picker.
   */
  workflows?: readonly PickerItem[];
  /** The status area at the right of the menu strip (2026-10-10: the "live updates reconnecting" mark). */
  status?: ReactNode;
  /** Shown in the picker when `workflows` is empty, e.g. why the list could not be read. */
  pickerNote?: string;
  /** Called each time the picker opens, so the page can re-read the list. */
  onPickerOpen?: () => void;
  onOpenWorkflow: (id: string) => void;
  renderDocument: (id: string, panel: DockviewPanelApi) => ReactNode;
  renderTool: (id: ToolId) => ReactNode;
  /** Changes when the Inspector's content changes; a hidden Inspector's rail tab then glows (spec §6.2.5). */
  inspectorKey: string;
  /** Esc with no menu, picker, switcher or flyout open: the page clears the selection. */
  onEscape: (doc: Document) => void;
  /** Rendered into every pop-out window's body: what panels there need from the page (SVG definitions). */
  popoutContent?: ReactNode;
  /** Where the window layout is kept; tests pass their own. Default: this browser's localStorage. */
  storage?: Storage | null;
  /** The dock as the page left it (the session, spec §6.1): restored at startup in place of the saved window layout. */
  restore?: SavedLayout | null;
  /** Called with the dock's state, documents included, whenever it changes: the page keeps it in its session. */
  onLayoutChange?: (dock: SavedLayout) => void;
  /** A message for the toast; a new id shows it (the page's notices, e.g. a refused session write). */
  notice?: { id: number; text: string };
  /**
   * F5 / Shift+F5 (2026-10-09): Start or Stop the active document's saved workflow. Returns why it cannot now (shown
   * as a toast), or null when it was pressed. Without it the keys say they are not available.
   */
  onRunCommand?: (op: 'start' | 'stop') => string | null;
  /** A tool pane's own entries at the top of its tab menu (e.g. Output's Clear, 2026-10-10). */
  toolMenu?: (id: ToolId) => MenuEntry[];
  /** Every key stroke and mouse gesture, for the Shortcuts menu (the user, 2026-10-17): a title per group. */
  shortcuts?: readonly { group: string; items: readonly { keys: string; does: string }[] }[];
}

const COMPONENTS = { document: DocumentHost, tool: ToolHost };
const TAB_COMPONENTS = { studio: StudioTab };
const TOAST_MS = 2600;
// Valence (2026-10-15): no Workspace and no Edit menu — every workflow is shown, and nothing is created or deleted from a menu
const STRIP = ['View', 'Window', 'Shortcuts'] as const;
type StripMenu = (typeof STRIP)[number];

const NO_RECT: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * The document a key event happened in: the main window's or a pop-out's. Duck-typed, because a
 * pop-out's nodes are not instances of the main window's `Node`.
 */
function documentOf(e: Event): Document {
  const t = e.target as { nodeType?: number; ownerDocument?: Document | null; document?: Document } | null;
  if (t?.nodeType === 9) return t as unknown as Document;
  return t?.ownerDocument ?? t?.document ?? document;
}

/**
 * The studio's chrome (spec §6): the menu strip, the dockview dock with documents and the four tool
 * panes, in-house auto-hide rails, the window-position menu, the switcher, layout persistence, the
 * studio's keys, toasts and tooltips. It knows documents only by id: what a document or a tool pane
 * shows comes from `renderDocument` and `renderTool`.
 */
export function DockShell(props: DockShellProps) {
  const { documents, activeDocumentId, workflows, inspectorKey } = props;
  const storage = props.storage === undefined ? browserStorage() : props.storage;
  const [api, setApi] = useState<DockviewApi | null>(null);
  const memory = useRef(newMemory()).current;
  const dockRef = useRef<HTMLDivElement>(null);
  const stripRefs = useRef<Partial<Record<StripMenu, HTMLButtonElement | null>>>({});
  const applying = useRef(false);
  const mru = useRef<string[]>([]);

  const [hidden, setHidden] = useState<PaneId[]>([]);
  const [flyId, setFlyId] = useState<PaneId | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<PaneId>>(new Set());
  const [menu, setMenu] = useState<{ label: string; entries: MenuEntry[]; anchor: Anchor; strip?: StripMenu } | null>(null);
  const [picker, setPicker] = useState<Anchor | null>(null);
  const [switcher, setSwitcher] = useState<{ order: string[]; index: number; doc: Document } | null>(null);
  const [toast, setToast] = useState<{ text: string; doc: Document }>({ text: '', doc: document });
  const [popouts, setPopouts] = useState<Window[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // dockview's events and the key handlers run outside React's render: they read the latest values here.
  const latest = useRef({ props, hidden, flyId, menu, picker, switcher });
  latest.current = { props, hidden, flyId, menu, picker, switcher };

  const dockRect = useCallback((): Rect => dockRef.current?.getBoundingClientRect() ?? NO_RECT, []);
  /** A toast in the window the user is in (`doc`: a pop-out's document when it came from there). */
  const showToast = useCallback((text: string, doc: Document = document) => {
    clearTimeout(toastTimer.current);
    setToast({ text, doc });
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, text: '' })), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  // the id is the trigger: the same text again, with a new id, shows again
  useEffect(() => { if (props.notice && props.notice.text) showToast(props.notice.text); }, [props.notice?.id]);

  /** Makes dockview's document panels match the open documents. */
  const syncDocuments = useCallback((dv: DockviewApi) => {
    const docs = latest.current.props.documents;
    const wanted = new Set(docs.map((d) => docPanelId(d.id)));
    for (const d of docs) if (!dv.getPanel(docPanelId(d.id))) addDocument(dv, memory, d.id, d.name);
    const stale = dv.panels.filter((p) => isDocPanelId(p.id) && !wanted.has(p.id));
    for (const p of stale) dv.removePanel(p);
    if (stale.length > 0 && !dv.panels.some((p) => isDocPanelId(p.id))) ensureDocumentArea(dv, memory);
  }, [memory]);

  const openFly = useCallback((id: PaneId) => {
    setFlyId(id);
    setFresh((f) => { const next = new Set(f); next.delete(id); return next; });
    mru.current = touch(mru.current, id);
  }, []);
  const closeFly = useCallback(() => setFlyId(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closePicker = useCallback(() => setPicker(null), []);

  const hide = useCallback((dv: DockviewApi, panel: Parameters<typeof autoHide>[2]) => {
    const ids = autoHide(dv, memory, panel, dockRect());
    if (ids.length > 0) setHidden((h) => [...h, ...ids.filter((id) => !h.includes(id))]);
  }, [memory, dockRect]);

  const pinBack = useCallback((id: PaneId) => {
    if (!api) return;
    setFlyId(null);
    const back = pinToolBack(api, memory, id);
    setHidden((h) => h.filter((x) => !back.includes(x)));
  }, [api, memory]);

  const toggleTool = useCallback((id: ToolId) => {
    if (!api) return;
    if (latest.current.hidden.includes(id)) {
      if (latest.current.flyId === id) closeFly(); else openFly(id);
      return;
    }
    const panel = api.getPanel(id);
    if (panel) closeTool(api, memory, panel, dockRect()); else showTool(api, memory, id);
  }, [api, memory, openFly, closeFly, dockRect]);

  const reset = useCallback((dv: DockviewApi) => {
    resetLayout(dv, memory, dockRect().right - dockRect().left || 1200);
    setHidden([]);
    setFlyId(null);
  }, [memory, dockRect]);

  /** Applies the saved layout; at startup, silently, and the default layout when there is none. */
  const apply = useCallback((dv: DockviewApi, atStartup: boolean): void => {
    const restore = atStartup ? latest.current.props.restore ?? null : null;
    const saved = restore ?? readLayout(storage);
    if (!saved) {
      if (atStartup) reset(dv); else showToast('No saved layout yet — Window › Save window layout first');
      return;
    }
    applying.current = true;
    try {
      setHidden(applyLayout(dv, memory, saved));
      setFlyId(null);
      if (!atStartup) showToast('Saved window layout applied');
    } catch {
      reset(dv);
      showToast(restore
        ? "The last session's layout could not be restored; the default layout is shown."
        : 'The saved window layout could not be applied; the default layout is shown.');
    } finally {
      applying.current = false;
      // at startup onReady puts the documents in itself, keeping the page's active one
      if (!atStartup) syncDocuments(dv);
    }
  }, [storage, memory, reset, showToast, syncDocuments]);

  /**
   * Startup: puts in the documents the layout did not bring back, then shows the page's active one.
   * Adding a panel activates it, which must not reach the page: the last document added would
   * replace the active document the page restored. The layout is reported afterwards, once `api` is set.
   */
  const startDocuments = useCallback((dv: DockviewApi) => {
    applying.current = true;
    try {
      syncDocuments(dv);
      const activeId = latest.current.props.activeDocumentId;
      const panel = activeId === null ? undefined : dv.getPanel(docPanelId(activeId));
      if (panel && dv.activePanel !== panel) panel.api.setActive();
    } finally {
      applying.current = false;
    }
  }, [syncDocuments]);

  /** Hands the page the dock's current state for its session; never while a layout is being applied. */
  const report = useCallback((dv: DockviewApi) => {
    const onLayoutChange = latest.current.props.onLayoutChange;
    if (!onLayoutChange || applying.current) return;
    onLayoutChange(captureLayout(dv, memory, latest.current.hidden, { keepDocuments: true }));
  }, [memory]);

  // the dock lives as long as the page, so these subscriptions are never disposed
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const dv = event.api;
    dv.onDidActivePanelChange((e) => {
      const id = e.panel?.id;
      if (!id) return;
      mru.current = touch(mru.current, id);
      const documentId = documentIdOf(id);
      if (documentId !== null && !applying.current) latest.current.props.onActivateDocument(documentId);
    });
    dv.onDidRemovePanel((panel) => {
      const documentId = documentIdOf(panel.id);
      if (documentId !== null && !applying.current && latest.current.props.documents.some((d) => d.id === documentId)) {
        latest.current.props.onCloseDocument(documentId);
        // the page may keep the document (it asks first, and the user can cancel): then its panel comes
        // back. Checked once React has applied a close the page made at once, so a closed one is not re-added.
        queueMicrotask(() => {
          if (latest.current.props.documents.some((d) => d.id === documentId)) syncDocuments(dv);
        });
      }
    });
    dv.onWillShowOverlay((e) => {
      const data = e.getData();
      const dragged = !data ? [] : data.panelId !== null ? [data.panelId] : (dv.getGroup(data.groupId)?.panels.map((p) => p.id) ?? []);
      const target = e.group ? e.group.panels.map((p) => p.id) : null;
      const emptyArea = !!e.group && e.group.panels.length === 0 && e.group.id === memory.documentGroupId;
      if (!canDrop(dragged, e.kind, target, emptyArea)) e.preventDefault();
    });
    // the document area takes the resize slack: keep its groups marked through drags, splits and moves
    dv.onDidLayoutChange(() => { markDocumentArea(dv, memory); report(dv); });
    dv.onDidAddPopoutGroup((p) => setPopouts((ws) => (ws.includes(p.window) ? ws : [...ws, p.window])));
    dv.onDidRemovePopoutGroup((p) => setPopouts((ws) => ws.filter((w) => w !== p.window)));
    apply(dv, true);
    startDocuments(dv);
    setApi(dv);
  }, [apply, memory, startDocuments, report, syncDocuments]);

  // the rails live in React state, not in dockview's layout: report when they change
  // this effect always reports last, with the current `hidden`: a transient report with a stale `hidden` is corrected
  useEffect(() => { if (api) report(api); }, [api, hidden, report]);

  // the open documents decide which document panels exist
  useEffect(() => { if (api) syncDocuments(api); }, [api, documents, syncDocuments]);

  // a newly active document (opened, or the next one after a close) gets its tab focused
  useEffect(() => {
    if (!api || activeDocumentId === null) return;
    const panel = api.getPanel(docPanelId(activeDocumentId));
    if (panel && api.activePanel !== panel) panel.api.setActive();
  }, [api, activeDocumentId]);

  // a hidden Inspector's rail tab glows when what it shows changes
  const lastInspectorKey = useRef(inspectorKey);
  useEffect(() => {
    if (lastInspectorKey.current === inspectorKey) return;
    lastInspectorKey.current = inspectorKey;
    if (hidden.includes('inspector') && flyId !== 'inspector') setFresh((f) => new Set(f).add('inspector'));
  }, [inspectorKey, hidden, flyId]);

  // the menu, the picker and the switcher are mutually exclusive: opening one closes the others,
  // so Esc (and Enter) always reach the one that is shown
  const openPicker = useCallback((anchor: Anchor) => {
    setMenu(null);
    setSwitcher(null);
    setPicker(anchor);
    latest.current.props.onPickerOpen?.();
  }, []);
  const stripAnchor = useCallback((): Anchor => {
    const first = stripRefs.current[STRIP[0]];
    return first ? anchorBelow(first) : { x: 8, y: 36, doc: document };
  }, []);

  const pick = useCallback((workflowId: string) => {
    const open = api?.getPanel(docPanelId(workflowId));
    if (open) open.api.setActive();
    latest.current.props.onOpenWorkflow(workflowId);
  }, [api]);

  const closePanel = useCallback((panelId: string) => {
    const documentId = documentIdOf(panelId);
    const panel = api?.getPanel(panelId);
    if (documentId !== null) { latest.current.props.onCloseDocument(documentId, panel?.api.getWindow().document ?? document); return; }
    if (api && panel) closeTool(api, memory, panel, dockRect());
  }, [api, memory, dockRect]);

  const toggleMaximize = useCallback((group: DockviewGroupPanel) => {
    const where = group.api.location.type;
    if (where === 'floating') { toggleFloatMaximize(group); return; }
    if (where !== 'grid') return;
    if (group.api.isMaximized()) group.api.exitMaximized(); else group.api.maximize();
  }, []);

  const windowMenu = useCallback((panelId: string, anchor: Anchor) => {
    const panel = api?.getPanel(panelId);
    if (!api || !panel) return;
    const group = panel.group;
    const docked = group.api.location.type === 'grid';
    const isDoc = isDocPanelId(panelId);
    const own = !isDocPanelId(panelId) && isToolId(panelId) ? latest.current.props.toolMenu?.(panelId) ?? [] : [];
    const entries: MenuEntry[] = [
      ...own, ...(own.length > 0 ? ['separator' as const] : []),
      docked
        ? { id: 'float', icon: '⧉', label: 'Float', kbd: 'Ctrl+dbl-click', onSelect: () => floatPanel(api, memory, panel, dockRect()) }
        : { id: 'dock', icon: '⤓', label: 'Dock', kbd: 'Ctrl+dbl-click', onSelect: () => dockBack(api, memory, group) },
    ];
    if (isDoc && docked) {
      entries.push({ id: 'max', icon: '▢', label: group.api.isMaximized() ? 'Restore' : 'Maximize', kbd: 'dbl-click', onSelect: () => toggleMaximize(group) });
    }
    if (!isDoc && documentArea(api, memory, group)) {
      entries.push({ id: 'tabbed', icon: '▤', label: 'Dock as tabbed document', onSelect: () => dockAsDocument(api, memory, panel, dockRect()) });
    }
    entries.push({ id: 'autohide', icon: '⇥', label: 'Auto hide', onSelect: () => hide(api, panel) });
    // a pinned document (Valence's one document) is never closed
    const pinned = isDoc && latest.current.props.documents.find((d) => d.id === documentIdOf(panelId))?.pinned === true;
    if (!pinned) entries.push('separator', { id: 'close', icon: '×', label: isDoc ? 'Close document' : 'Close', kbd: isDoc ? 'Alt+W' : '', onSelect: () => closePanel(panelId) });
    setPicker(null);
    setSwitcher(null);
    setMenu({ label: 'Window position', entries, anchor });
  }, [api, memory, dockRect, hide, closePanel, toggleMaximize]);

  const shell: ShellApi = useMemo(() => ({
    documentInfo: (id) => latest.current.props.documents.find((d) => d.id === id),
    renderDocument: (id, panel) => latest.current.props.renderDocument(id, panel),
    renderTool: (id) => latest.current.props.renderTool(id),
    closePanel,
    windowMenu,
    toggleFloat: (panelId) => {
      const panel = api?.getPanel(panelId);
      if (!api || !panel) return;
      if (panel.group.api.location.type === 'grid') floatPanel(api, memory, panel, dockRect());
      else dockBack(api, memory, panel.group);
    },
    toggleMaximize: (panelId) => { const panel = api?.getPanel(panelId); if (panel) toggleMaximize(panel.group); },
    openPicker,
    canLoad: latest.current.props.workflows !== undefined,
    groupAction: (group, action: GroupAction, anchor) => {
      if (!api) return;
      switch (action) {
        case 'open': openPicker(anchor); break;
        case 'menu': if (group.activePanel) windowMenu(group.activePanel.id, anchor); break;
        case 'hide': if (group.activePanel) hide(api, group.activePanel); break;
        case 'float': floatGroup(api, memory, group, dockRect()); break;
        case 'maximize': toggleMaximize(group); break;
        case 'dock': dockBack(api, memory, group); break;
      }
    },
  // documents and props are read through `latest`; re-create when the documents change so tabs re-render
  }), [api, memory, dockRect, closePanel, windowMenu, openPicker, hide, toggleMaximize, documents]);

  const stripEntries = (name: StripMenu): MenuEntry[] => {
    const activePanel = api?.activePanel;
    const docked = activePanel?.group.api.location.type === 'grid';
    switch (name) {
      case 'View':
        return TOOL_IDS.map((id) => ({
          id, icon: api?.getPanel(id) || hidden.includes(id) ? '✓' : '', label: TOOL_TITLES[id], onSelect: () => toggleTool(id),
        }));
      case 'Window':
        return [
          { id: 'float', icon: '⧉', label: 'Float', kbd: 'Ctrl+dbl-click', disabled: !activePanel || !docked, onSelect: () => { if (api && activePanel) floatPanel(api, memory, activePanel, dockRect()); } },
          { id: 'dock', icon: '⤓', label: 'Dock', kbd: 'Ctrl+dbl-click', disabled: !activePanel || docked, onSelect: () => { if (api && activePanel) dockBack(api, memory, activePanel.group); } },
          'separator',
          { id: 'switch', icon: '⇄', label: 'Switch window…', kbd: 'Ctrl+E', onSelect: () => advanceSwitcher(1, document) },
          'separator',
          { id: 'save', icon: '⤓', label: 'Save window layout', onSelect: () => {
            if (!api) return;
            showToast(writeLayout(storage, captureLayout(api, memory, hidden)) ? 'Window layout saved in this browser' : 'This browser would not store the layout');
          } },
          { id: 'apply', icon: '⤒', label: 'Apply saved layout', onSelect: () => { if (api) apply(api, false); } },
          { id: 'reset', icon: '↺', label: 'Reset window layout', onSelect: () => { if (api) { reset(api); syncDocuments(api); showToast('Window layout reset'); } } },
        ];
      case 'Shortcuts':
        // to read, not to run: choosing one only closes the menu
        return (latest.current.props.shortcuts ?? []).flatMap((g, i): MenuEntry[] => [
          ...(i > 0 ? ['separator' as const] : []),
          { heading: g.group },
          ...g.items.map((s, j): MenuEntry => ({ id: `sc-${i}-${j}`, label: s.does, kbd: s.keys, onSelect: () => {} })),
        ]);
    }
  };

  const switcherEntries = (order: readonly string[]) => order.map((id) => {
    const documentId = documentIdOf(id);
    const info = documentId === null ? undefined : documents.find((d) => d.id === documentId);
    return info
      ? { id, label: info.name, document: true, hint: info.version }
      : { id, label: isToolId(id) ? TOOL_TITLES[id] : id, document: false, hint: hidden.includes(id) ? 'auto-hidden' : undefined };
  });

  function advanceSwitcher(step: 1 | -1, doc: Document) {
    const current = latest.current.switcher;
    if (current) {
      const n = current.order.length;
      setSwitcher({ ...current, index: (current.index + step + n) % n });
      return;
    }
    if (!api) return;
    const present = [...new Set([...api.panels.map((p) => p.id), ...latest.current.hidden])];
    const order = switcherOrder(mru.current, present);
    if (order.length === 0) return;
    setMenu(null);
    setPicker(null);
    setSwitcher({ order, index: (step + order.length) % order.length, doc });
  }

  function finishSwitcher(target?: string) {
    const current = latest.current.switcher;
    if (!current) return;
    setSwitcher(null);
    const id = target ?? current.order[current.index];
    if (!id) return;
    if (latest.current.hidden.includes(id)) openFly(id);
    else api?.getPanel(id)?.api.setActive();
  }

  // the studio's keys, in the main window and in every pop-out window
  const keyHandlers = useRef({ down: (_e: KeyboardEvent) => {}, up: (_e: KeyboardEvent) => {} });
  keyHandlers.current.down = (e: KeyboardEvent) => {
    const now = latest.current;
    const doc = documentOf(e);
    // a key an overlay already handled (the picker's Enter, a menu's arrows) is not the studio's
    if (e.defaultPrevented) return;
    if (now.switcher) {
      if (e.key === 'ArrowDown') { e.preventDefault(); advanceSwitcher(1, doc); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); advanceSwitcher(-1, doc); return; }
      if (e.key === 'Enter') { e.preventDefault(); finishSwitcher(); return; }
    }
    const command = keyCommand(e);
    if (command === null) return;
    switch (command) {
      case 'switcher': case 'switcherBack':
        e.preventDefault(); advanceSwitcher(command === 'switcher' ? 1 : -1, doc); break;
      case 'closeDocument': {
        e.preventDefault();
        const active = now.props.activeDocumentId;
        if (active && !now.props.documents.find((d) => d.id === active)?.pinned) now.props.onCloseDocument(active, doc);
        break;
      }
      case 'open':
        if (!now.props.workflows) break;
        e.preventDefault(); openPicker(doc === document ? stripAnchor() : { x: 8, y: 8, doc }); break;
      case 'start': case 'stop': {
        e.preventDefault();
        // a dialog (a question, the picker, the switcher) is open: the key does nothing
        if (doc.querySelector('[role="dialog"], [role="alertdialog"]')) break;
        const run = now.props.onRunCommand;
        const why = run ? run(command) : 'Start and Stop are not available.';
        if (why !== null) showToast(why, doc);
        break;
      }
      case 'escape':
        if (now.switcher) setSwitcher(null);
        else if (now.menu) setMenu(null);
        else if (now.picker) setPicker(null);
        else if (now.flyId) closeFly();
        else now.props.onEscape(doc);
        break;
    }
  };
  keyHandlers.current.up = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Meta') finishSwitcher(); };

  const windows = useMemo(() => [window, ...popouts], [popouts]);
  /** `doc` while its window is still open, else the main document (a pop-out closed under an overlay). */
  const liveDocument = (doc: Document): Document => (popouts.some((w) => w.document === doc) ? doc : document);
  const toastDoc = liveDocument(toast.doc);

  // an overlay left open in a pop-out that closed goes with it (Esc would otherwise close it unseen first)
  useEffect(() => {
    const live = (doc: Document) => doc === document || popouts.some((w) => w.document === doc);
    setMenu((m) => (m && !live(m.anchor.doc) ? null : m));
    setPicker((p) => (p && !live(p.doc) ? null : p));
    setSwitcher((s) => (s && !live(s.doc) ? null : s));
  }, [popouts]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyHandlers.current.down(e);
    const up = (e: KeyboardEvent) => keyHandlers.current.up(e);
    for (const w of windows) { w.addEventListener('keydown', down); w.addEventListener('keyup', up); }
    return () => { for (const w of windows) { w.removeEventListener('keydown', down); w.removeEventListener('keyup', up); } };
  }, [windows]);

  return (
    <ShellProvider value={shell}>
      <div className="studio-shell">
        <div className="menubar" role="menubar" aria-label="Main menu">
          <div className="brand">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <defs><radialGradient id="brandSphere" cx="35%" cy="30%"><stop offset="0" stopColor="#7CCBF5" /><stop offset=".5" stopColor="#1B5594" /><stop offset="1" stopColor="#05142D" /></radialGradient></defs>
              <circle cx="8" cy="8" r="7" fill="url(#brandSphere)" stroke="rgba(125,211,252,.6)" />
            </svg>
            SKP Valence
          </div>
          <div className="menus">
            {STRIP.map((name) => (
              <button
                key={name}
                type="button"
                role="menuitem"
                ref={(el) => { stripRefs.current[name] = el; }}
                className={menu?.strip === name ? 'menu open' : 'menu'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (menu?.strip === name) { setMenu(null); return; }
                  setPicker(null);
                  setSwitcher(null);
                  setMenu({ label: name, entries: stripEntries(name), anchor: anchorBelow(e.currentTarget), strip: name });
                }}
              >
                {name}
              </button>
            ))}
          </div>
          {props.status !== undefined && <div className="mstatus">{props.status}</div>}
        </div>
        <div className="dockwrap">
          <div className="dock" ref={dockRef}>
            <DockviewReact
              components={COMPONENTS}
              tabComponents={TAB_COMPONENTS}
              defaultTabComponent={StudioTab}
              rightHeaderActionsComponent={GroupActions}
              watermarkComponent={Watermark}
              theme={themeVisualStudio}
              proportionalLayout={false}
              onReady={onReady}
            />
          </div>
          <AutoHide
            hidden={hidden}
            sideOf={(id) => toolSide(memory, id)}
            flyId={flyId}
            fresh={fresh}
            onOpen={openFly}
            onClose={closeFly}
            onPin={pinBack}
            titleOf={(id) => (isToolId(id) ? TOOL_TITLES[id] : documents.find((d) => docPanelId(d.id) === id)?.name ?? id)}
            renderPane={(id) => {
              if (isToolId(id)) return props.renderTool(id);
              const documentId = documentIdOf(id);
              const panel = api?.getPanel(id);
              return documentId !== null && panel ? props.renderDocument(documentId, panel.api) : null;
            }}
          />
        </div>
      </div>
      {/* keyed: switching menus opens a new one, which focuses its first item and gives focus back to its own trigger */}
      {menu && <Menu key={menu.label} label={menu.label} entries={menu.entries} anchor={menu.anchor} onClose={closeMenu} />}
      {picker && workflows && (
        <Picker
          anchor={picker}
          items={workflows}
          note={props.pickerNote}
          onPick={pick}
          onClose={closePicker}
        />
      )}
      {switcher && createPortal(
        <Switcher entries={switcherEntries(switcher.order)} selected={switcher.order[switcher.index] ?? null} onPick={finishSwitcher} />,
        liveDocument(switcher.doc).body,
      )}
      {/* the main window's toast is always there (a live region); a pop-out gets its own while it shows one */}
      <div className={toast.text && toastDoc === document ? 'toast on' : 'toast'} role="status" aria-live="polite">{toastDoc === document ? toast.text : ''}</div>
      {toastDoc !== document && toast.text && createPortal(<div className="toast on" role="status" aria-live="polite">{toast.text}</div>, toastDoc.body)}
      <Tooltips windows={windows} />
      {props.popoutContent !== undefined && popouts.map((w) => createPortal(props.popoutContent, w.document.body, windowKey(w)))}
    </ShellProvider>
  );
}

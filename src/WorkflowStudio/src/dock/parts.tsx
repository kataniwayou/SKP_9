import { createContext, useContext, type ReactNode } from 'react';
import type { DockviewGroupPanel, DockviewPanelApi, IDockviewHeaderActionsProps, IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview-react';
import { documentIdOf, isDocPanelId, isToolId, TOOL_TITLES, type ToolId } from './ids';
import { anchorAt, anchorBelow, type Anchor } from './Menu';

/** One open document, as the dock shows it. */
export interface DockDocument {
  id: string;
  name: string;
  version: string;
  /** The tab's tooltip: the unique entity name (spec §7). */
  tooltip: string;
}

export type GroupAction = 'open' | 'menu' | 'hide' | 'float' | 'popout' | 'maximize' | 'dock';

/** What the dock's parts (tabs, header buttons, hosts) ask of the shell. */
export interface ShellApi {
  documentInfo(id: string): DockDocument | undefined;
  renderDocument(id: string, panel: DockviewPanelApi): ReactNode;
  renderTool(id: ToolId): ReactNode;
  closePanel(panelId: string): void;
  windowMenu(panelId: string, anchor: Anchor): void;
  toggleFloat(panelId: string): void;
  toggleMaximize(panelId: string): void;
  openPicker(anchor: Anchor): void;
  groupAction(group: DockviewGroupPanel, action: GroupAction, anchor: Anchor): void;
}

const ShellContext = createContext<ShellApi | null>(null);
export const ShellProvider = ShellContext.Provider;

/** dockview renders these through React portals, so they read the shell from context. */
export function useShell(): ShellApi {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('A dock part needs the DockShell above it.');
  return shell;
}

/** A document panel's body: whatever the page renders for that document. */
export function DocumentHost({ api }: IDockviewPanelProps) {
  const shell = useShell();
  const id = documentIdOf(api.id);
  return id === null ? null : <>{shell.renderDocument(id, api)}</>;
}

/** A tool pane's body, docked or floating (the flyout renders the same body). */
export function ToolHost({ api }: IDockviewPanelProps) {
  const shell = useShell();
  return isToolId(api.id) ? <>{shell.renderTool(api.id)}</> : null;
}

/**
 * Every tab, documents and tool panes alike (mockup v49 .doctab): right-click opens the
 * window-position menu, double-click maximizes, Ctrl+double-click floats or docks, a middle click
 * or × closes (spec §6.2.1, §6.2.6). A document's tooltip is its unique name.
 */
export function StudioTab({ api }: IDockviewPanelHeaderProps) {
  const shell = useShell();
  const id = api.id;
  const documentId = documentIdOf(id);
  const info = documentId === null ? undefined : shell.documentInfo(documentId);
  const name = info?.name ?? (isToolId(id) ? TOOL_TITLES[id] : id);
  return (
    <div
      className="doctab"
      data-tip={info?.tooltip}
      onContextMenu={(e) => { e.preventDefault(); shell.windowMenu(id, anchorAt(e)); }}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest('.x')) return;
        if (e.ctrlKey || e.metaKey) shell.toggleFloat(id);
        else shell.toggleMaximize(id);
      }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); shell.closePanel(id); } }}
    >
      <span className="nm">{name}</span>
      {info && <span className="tv">{info.version}</span>}
      <span
        className="x"
        role="button"
        tabIndex={0}
        aria-label={`Close ${name}`}
        data-tip="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); shell.closePanel(id); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          shell.closePanel(id);
        }}
      >
        ×
      </span>
    </div>
  );
}

/**
 * A group's header buttons (mockup v49 GroupActions). Docked: + (documents), ▾ and ⇥ (tool
 * panes), float, pop out, maximize. Floating or popped out: ▾ (tool panes), Dock, and pop out
 * (floating only). An empty group is the document area waiting for a document.
 */
export function GroupActions({ group, panels, location }: IDockviewHeaderActionsProps) {
  const shell = useShell();
  const where = location?.type ?? group.api.location.type;
  const documents = panels.length === 0 || panels.some((p) => isDocPanelId(p.id));
  const button = (action: GroupAction, glyph: string, tip: string) => (
    <button
      type="button"
      aria-label={tip}
      data-tip={tip}
      onClick={(e) => { e.stopPropagation(); shell.groupAction(group, action, anchorBelow(e.currentTarget)); }}
    >
      {glyph}
    </button>
  );
  return (
    <div className="ghead">
      {where === 'grid' ? (
        <>
          {documents && button('open', '+', 'Open workflow')}
          {!documents && button('menu', '▾', 'Window position')}
          {!documents && button('hide', '⇥', 'Auto-hide to a side tab')}
          {panels.length > 0 && button('float', '⧉', 'Float this group (or Shift+drag a tab)')}
          {panels.length > 0 && button('popout', '⇱', 'Pop out to its own window')}
          {panels.length > 0 && button('maximize', '▢', 'Maximize / restore')}
        </>
      ) : (
        <>
          {!documents && button('menu', '▾', 'Window position')}
          {button('dock', '⤓', 'Dock back into the main layout')}
          {where === 'floating' && button('popout', '⇱', 'Pop out to its own window')}
        </>
      )}
    </div>
  );
}

/** An empty document area (mockup v49 .empty). */
export function Watermark() {
  const shell = useShell();
  return (
    <div className="empty">
      <div>
        <div className="e1">No workflow open</div>
        <div className="e2">File › Open workflow… or Ctrl+O</div>
        <button type="button" className="btn primary" onClick={(e) => shell.openPicker(anchorBelow(e.currentTarget))}>Open workflow…</button>
      </div>
    </div>
  );
}

import type { GroupviewPanelState, SerializedDockview, SerializedFloatingGroup, SerializedGridObject } from 'dockview-react';
import { isDocPanelId, isToolId, type ToolId } from './ids';
import type { Direction, Home, Side } from './home';

/** localStorage key of the saved window layout (spec §6.2.2: per browser, never in the database). */
export const LAYOUT_KEY = 'skp.studio.layout';
/** Bumped whenever the saved shape changes; an older or unknown version is ignored, never migrated. */
export const LAYOUT_VERSION = 1;

type GroupState = NonNullable<SerializedFloatingGroup['data']>;

/** What Window › Save window layout stores. It never holds a document: they are not restored. */
export interface SavedLayout {
  version: typeof LAYOUT_VERSION;
  /** `DockviewApi.toJSON()` with every document panel taken out and no pop-out windows. */
  dock: SerializedDockview;
  /** The main-grid group the documents sat in, kept (possibly empty) so they go back there. */
  documentGroupId: string | null;
  /** Tool panes on an auto-hide rail. */
  hidden: ToolId[];
  sides: Partial<Record<ToolId, Side>>;
  homes: Partial<Record<ToolId, Home>>;
}

/** `window.localStorage`, or null where reading it throws (blocked storage, sandboxed frames). */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Writes the layout. False when the browser refuses (quota, blocked storage): never throws. */
export function writeLayout(storage: Storage | null, layout: SavedLayout): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

/**
 * The saved layout, or null when there is none, it cannot be read, it is not JSON, it is from
 * another version or its dock part is not a dockview layout. Unknown tool ids, sides and malformed
 * homes are dropped rather than failing the whole layout.
 */
export function readLayout(storage: Storage | null): SavedLayout | null {
  let text: string | null;
  try {
    text = storage?.getItem(LAYOUT_KEY) ?? null;
  } catch {
    return null;
  }
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== LAYOUT_VERSION || !isDockLayout(value.dock)) return null;

  const hidden = Array.isArray(value.hidden) ? value.hidden.filter((id): id is ToolId => typeof id === 'string' && isToolId(id)) : [];
  const sides: Partial<Record<ToolId, Side>> = {};
  const homes: Partial<Record<ToolId, Home>> = {};
  if (isRecord(value.sides)) {
    for (const [id, side] of Object.entries(value.sides)) if (isToolId(id) && isSide(side)) sides[id] = side;
  }
  if (isRecord(value.homes)) {
    for (const [id, home] of Object.entries(value.homes)) if (isToolId(id) && isHome(home)) homes[id] = home;
  }
  return {
    version: LAYOUT_VERSION,
    dock: value.dock,
    documentGroupId: typeof value.documentGroupId === 'string' ? value.documentGroupId : null,
    hidden: [...new Set(hidden)],
    sides,
    homes,
  };
}

/**
 * A copy of `toJSON()` without documents: their panels and tab entries go, a floating window left
 * empty goes, and pop-out windows go (Apply never opens a browser window). The main-grid group that
 * held documents stays, empty, and its id is returned as the document area.
 */
export function stripDocuments(layout: SerializedDockview): { dock: SerializedDockview; documentGroupId: string | null } {
  const dock = JSON.parse(JSON.stringify(layout)) as SerializedDockview;
  let documentGroupId: string | null = null;
  forEachGroup(dock.grid.root, (g) => {
    if (documentGroupId === null && g.views.some(isDocPanelId)) documentGroupId = g.id;
  });

  const clean = (g: GroupState) => {
    g.views = g.views.filter((v) => !isDocPanelId(v));
    if (g.activeView !== undefined && !g.views.includes(g.activeView)) {
      if (g.views.length > 0) g.activeView = g.views[0];
      else delete g.activeView;
    }
  };
  forEachGroup(dock.grid.root, clean);
  for (const id of Object.keys(dock.panels)) if (isDocPanelId(id)) delete dock.panels[id];

  dock.floatingGroups = (dock.floatingGroups ?? []).filter((f) => {
    let views = 0;
    const visit = (g: GroupState) => { clean(g); views += g.views.length; };
    if (f.data) visit(f.data);
    if (f.grid) forEachGroup(f.grid.root, visit);
    return views > 0;
  });
  dock.popoutGroups = [];
  return { dock, documentGroupId };
}

/**
 * A copy of a stripped layout with the given document panels put back as tabs of the document
 * area (the saved group, or the first group of the main grid when that group is gone). Applied
 * with `reuseExistingPanels`, dockview then moves the open documents there instead of re-creating
 * them, so their canvases keep their viewport.
 */
export function withDocuments(
  stripped: SerializedDockview, documentGroupId: string | null, documents: readonly GroupviewPanelState[], activeId: string | null,
): SerializedDockview {
  const dock = JSON.parse(JSON.stringify(stripped)) as SerializedDockview;
  if (documents.length === 0) return dock;
  let target: GroupState | null = null;
  forEachGroup(dock.grid.root, (g) => { if (g.id === documentGroupId) target = g; });
  if (target === null) forEachGroup(dock.grid.root, (g) => { target ??= g; });
  const area = target as GroupState | null;
  if (area === null) return dock;
  for (const panel of documents) {
    dock.panels[panel.id] = panel;
    if (!area.views.includes(panel.id)) area.views.push(panel.id);
  }
  if (activeId !== null && area.views.includes(activeId)) area.activeView = activeId;
  return dock;
}

/** Every group (grid leaf) in a serialized grid, depth first. */
function forEachGroup(node: SerializedGridObject<GroupState>, visit: (group: GroupState) => void): void {
  if (node.type === 'leaf') visit(node.data as GroupState);
  else for (const child of node.data as SerializedGridObject<GroupState>[]) forEachGroup(child, visit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDockLayout(value: unknown): value is SerializedDockview {
  if (!isRecord(value) || !isRecord(value.grid) || !isRecord(value.panels)) return false;
  const root = value.grid.root;
  return isRecord(root) && root.type === 'branch' && Array.isArray(root.data);
}

function isSide(value: unknown): value is Side {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom';
}

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'above', 'below', 'within'];

function isHome(value: unknown): value is Home {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const isBox = (b: unknown) => isRecord(b) && typeof b.ref === 'string' && finite(b.left) && finite(b.top) && finite(b.width) && finite(b.height);
  return isRecord(value) && typeof value.ref === 'string' && DIRECTIONS.includes(value.direction as Direction)
    && finite(value.size) && (value.size as number) > 0 && Array.isArray(value.layout) && value.layout.every(isBox);
}

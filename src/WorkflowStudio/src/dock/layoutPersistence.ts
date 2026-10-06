import { Orientation, type GroupviewPanelState, type SerializedDockview, type SerializedFloatingGroup, type SerializedGridObject } from 'dockview-react';
import { isDocPanelId, isToolId, type ToolId } from './ids';
import type { Direction, Home, Side } from './home';

/** localStorage key of the saved window layout (spec §6.2.2: per browser, never in the database). */
export const LAYOUT_KEY = 'skp.studio.layout';
/** Bumped whenever the saved shape changes; an older or unknown version is ignored, never migrated. */
export const LAYOUT_VERSION = 1;

type GroupState = NonNullable<SerializedFloatingGroup['data']>;

/** What Window › Save window layout stores. Window › Save keeps no document; the session (app/session.ts) keeps the same shape with its documents. */
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
  /**
   * Tool panes that were in a pop-out window, in the order they go back into the dock (each one's
   * home says where). Apply never opens a window, so they are docked instead of lost.
   */
  popped: ToolId[];
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
  return parseLayout(value);
}

/** The layout in an already-parsed value (the saved layout, or the session's dock), or null when it is not one. */
export function parseLayout(value: unknown): SavedLayout | null {
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
  const popped = Array.isArray(value.popped) ? value.popped.filter((id): id is ToolId => typeof id === 'string' && isToolId(id)) : [];
  return {
    version: LAYOUT_VERSION,
    dock: value.dock,
    documentGroupId: typeof value.documentGroupId === 'string' ? value.documentGroupId : null,
    hidden: [...new Set(hidden)],
    sides,
    homes,
    popped: [...new Set(popped)],
  };
}

/**
 * A copy of `toJSON()` without documents: their panels and tab entries go, a floating window left
 * empty goes, and pop-out windows go (Apply never opens a browser window). The main-grid group that
 * held documents stays, empty, and its id is returned as the document area. The panes the pop-out
 * windows held go too; they are returned, one list per group, so they can be docked on Apply.
 */
export function stripDocuments(layout: SerializedDockview): { dock: SerializedDockview; documentGroupId: string | null; popped: string[][] } {
  const dock = JSON.parse(JSON.stringify(layout)) as SerializedDockview;
  let documentGroupId: string | null = null;
  const heldDocuments = new Set<string>();
  forEachGroup(dock.grid.root, (g) => {
    if (!g.views.some(isDocPanelId)) return;
    heldDocuments.add(g.id);
    if (documentGroupId === null) documentGroupId = g.id;
  });

  const clean = (g: GroupState) => {
    g.views = g.views.filter((v) => !isDocPanelId(v));
    if (g.activeView !== undefined && !g.views.includes(g.activeView)) {
      if (g.views.length > 0) g.activeView = g.views[0];
      else delete g.activeView;
    }
  };
  forEachGroup(dock.grid.root, clean);
  pruneGrid(dock, (g, leaf) => (g.id !== documentGroupId && heldDocuments.has(g.id) && g.views.length === 0) || isHiddenEmpty(g, leaf));
  for (const id of Object.keys(dock.panels)) if (isDocPanelId(id)) delete dock.panels[id];

  dock.floatingGroups = (dock.floatingGroups ?? []).filter((f) => {
    let views = 0;
    const visit = (g: GroupState) => { clean(g); views += g.views.length; };
    if (f.data) visit(f.data);
    if (f.grid) forEachGroup(f.grid.root, visit);
    return views > 0;
  });
  const popped = takePopouts(dock);
  fixRootSize(dock);
  return { dock, documentGroupId, popped };
}

/** Takes the pop-out windows out of a layout copy and returns the tool panes each held; their documents just go. */
function takePopouts(dock: SerializedDockview): string[][] {
  const popped: string[][] = [];
  for (const p of dock.popoutGroups ?? []) {
    const visit = (g: GroupState) => {
      const tools = g.views.filter((v) => !isDocPanelId(v));
      if (tools.length > 0) popped.push(tools);
      for (const v of g.views) delete dock.panels[v];
    };
    if (p.data) visit(p.data);
    if (p.grid) forEachGroup(p.grid.root, visit);
  }
  dock.popoutGroups = [];
  return popped;
}

/**
 * A copy of `toJSON()` for the session: documents stay where they are. Pop-out windows go (a reload
 * cannot reopen a browser window); the tool panes they held are returned so they can be docked on
 * restore, and the documents they held come back in the document area (the page adds every open
 * document the layout does not hold).
 */
export function sessionDock(layout: SerializedDockview): { dock: SerializedDockview; documentGroupId: string | null; popped: string[][] } {
  const dock = JSON.parse(JSON.stringify(layout)) as SerializedDockview;
  let documentGroupId: string | null = null;
  forEachGroup(dock.grid.root, (g) => { if (documentGroupId === null && g.views.some(isDocPanelId)) documentGroupId = g.id; });
  const popped = takePopouts(dock);
  // A pop-out leaves its group's place in the grid hidden and empty. It would come back hidden, and
  // pile up refresh after refresh; its documents come back in the document area, its panes docked.
  pruneGrid(dock, isHiddenEmpty);
  fixRootSize(dock);
  return { dock, documentGroupId, popped };
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
  fixRootSize(dock);
  if (documents.length === 0) return dock;
  // never a hidden group: dockview does not show a group a panel is added to
  let target: GroupState | null = null;
  const shown = (node: GridNode, visit: (g: GroupState) => void): void => {
    if (node.type === 'leaf') { if (node.visible !== false) visit(node.data as GroupState); }
    else for (const child of node.data as GridNode[]) shown(child, visit);
  };
  shown(dock.grid.root, (g) => { if (g.id === documentGroupId) target = g; });
  if (target === null) shown(dock.grid.root, (g) => { target ??= g; });
  const area = target as GroupState | null;
  if (area === null) return dock;
  for (const panel of documents) {
    dock.panels[panel.id] = panel;
    if (!area.views.includes(panel.id)) area.views.push(panel.id);
  }
  if (activeId !== null && area.views.includes(activeId)) area.activeView = activeId;
  return dock;
}

type GridNode = SerializedGridObject<GroupState>;

/**
 * The root branch's size is its cross size: the grid's height when it runs horizontally, else its
 * width. dockview can write the other dimension (seen after Reset window layout re-created the
 * panes; pruneGrid flipping the orientation would too), and `fromJSON` then lays the nested
 * branches out against the wrong size, squeezing the document area to its minimum.
 */
function fixRootSize(dock: SerializedDockview): void {
  dock.grid.root = { ...dock.grid.root, size: dock.grid.orientation === Orientation.HORIZONTAL ? dock.grid.height : dock.grid.width };
}

/** The place a pop-out left in the grid: hidden and empty. A hidden group that holds panes is a rail and stays. */
const isHiddenEmpty = (group: GroupState, leaf: GridNode): boolean => leaf.visible === false && group.views.length === 0;

/**
 * Removes the leaves `drop` picks from the main grid. A branch left with no child goes, one left
 * with a single leaf becomes that leaf (keeping its own size), one left with a single branch gives
 * its children to its parent, since a branch's orientation is its depth: the child's children run
 * the way the parent's do. At the root that flips the grid's orientation instead.
 */
function pruneGrid(dock: SerializedDockview, drop: (group: GroupState, leaf: GridNode) => boolean): void {
  const prune = (node: GridNode): GridNode[] => {
    if (node.type === 'leaf') return drop(node.data as GroupState, node) ? [] : [node];
    const children = (node.data as GridNode[]).flatMap(prune);
    if (children.length === 0) return [];
    if (children.length === 1) {
      const only = children[0]!;
      return only.type === 'leaf' ? [{ ...only, size: node.size }] : (only.data as GridNode[]);
    }
    return [{ ...node, data: children }];
  };
  const root = dock.grid.root;
  let children = (root.data as GridNode[]).flatMap(prune);
  if (children.length === 1 && children[0]!.type === 'branch') {
    children = children[0]!.data as GridNode[];
    dock.grid.orientation = dock.grid.orientation === Orientation.HORIZONTAL ? Orientation.VERTICAL : Orientation.HORIZONTAL;
  }
  dock.grid.root = { ...root, data: children };
}

/** Whether the layout's main grid holds the group. */
export function gridHolds(dock: SerializedDockview, groupId: string): boolean {
  let found = false;
  forEachGroup(dock.grid.root, (g) => { found ||= g.id === groupId; });
  return found;
}

/** Every group (grid leaf) in a serialized grid, depth first. */
function forEachGroup(node: SerializedGridObject<GroupState>, visit: (group: GroupState) => void): void {
  if (node.type === 'leaf') visit(node.data as GroupState);
  else for (const child of node.data as SerializedGridObject<GroupState>[]) forEachGroup(child, visit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the value is a layout dockview can load: the whole grid tree (every branch and leaf), the
 * floating and pop-out groups, and every tab pointing at a panel that exists. A layout failing
 * halfway through `fromJSON` would cost the open documents, so nothing doubtful may reach it.
 */
function isDockLayout(value: unknown): value is SerializedDockview {
  if (!isRecord(value) || !isRecord(value.grid) || !isRecord(value.panels)) return false;
  const panels = value.panels;
  if (!Object.values(panels).every((p) => isRecord(p) && typeof p.id === 'string')) return false;
  const root = value.grid.root;
  if (!isRecord(root) || root.type !== 'branch' || !isGridNode(root, panels)) return false;
  for (const key of ['floatingGroups', 'popoutGroups'] as const) {
    const groups = value[key];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return false;
    for (const g of groups) {
      if (!isRecord(g)) return false;
      const hasData = g.data !== undefined, hasGrid = g.grid !== undefined;
      if (!hasData && !hasGrid) return false;
      if (hasData && !isGroupState(g.data, panels)) return false;
      if (hasGrid && !(isRecord(g.grid) && isGridNode(g.grid.root, panels))) return false;
    }
  }
  return true;
}

function isGridNode(node: unknown, panels: Record<string, unknown>): boolean {
  if (!isRecord(node)) return false;
  if (node.type === 'leaf') return isGroupState(node.data, panels);
  if (node.type === 'branch') return Array.isArray(node.data) && node.data.every((child) => isGridNode(child, panels));
  return false;
}

function isGroupState(data: unknown, panels: Record<string, unknown>): boolean {
  return isRecord(data) && typeof data.id === 'string' && Array.isArray(data.views)
    && data.views.every((v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(panels, v))
    && (data.activeView === undefined || typeof data.activeView === 'string');
}

function isSide(value: unknown): value is Side {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom';
}

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'above', 'below', 'within'];

function isHome(value: unknown): value is Home {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const isBox = (b: unknown) => isRecord(b) && typeof b.ref === 'string' && finite(b.left) && finite(b.top) && finite(b.width) && finite(b.height);
  // a home `within` a group (a tab of it) needs no size
  return isRecord(value) && typeof value.ref === 'string' && DIRECTIONS.includes(value.direction as Direction)
    && finite(value.size) && ((value.size as number) > 0 || (value.direction === 'within' && value.size === 0))
    && Array.isArray(value.layout) && value.layout.every(isBox);
}

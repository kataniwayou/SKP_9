import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { findHome, SIDE_DIRECTION, sideOf, toPosition, type GroupBox, type Home, type Rect, type Side } from './home';
import { docPanelId, documentIdOf, isDocPanelId, isToolId, TOOL_IDS, TOOL_TITLES, type ToolId } from './ids';
import { gridHolds, sessionDock, stripDocuments, withDocuments, type SavedLayout } from './layoutPersistence';

/**
 * What the dock remembers beyond dockview's own state (mockup v49 SIDE and HOME): the edge each tool
 * pane belongs to, where each group sat before it left the layout, and which group is the document
 * area. Mutated in place by the actions below; the shell keeps one per dock.
 */
export interface DockMemory {
  sides: Partial<Record<ToolId, Side>>;
  homes: Partial<Record<string, Home>>;
  documentGroupId: string | null;
}

export const newMemory = (): DockMemory => ({ sides: {}, homes: {}, documentGroupId: null });

export const DEFAULT_SIDES: Readonly<Record<ToolId, Side>> = { inspector: 'right', toolbox: 'right', problems: 'bottom', output: 'bottom' };
/** The default sizes (mockup v49 TOOLS): Inspector 340 wide, Toolbox 290 wide, Problems and Output 150 high. */
const TOOL_SIZE: Readonly<Record<ToolId, number>> = { inspector: 340, toolbox: 290, problems: 150, output: 150 };
/** Problems and Output share a group when they share a side. */
const MATE: Readonly<Partial<Record<ToolId, ToolId>>> = { problems: 'output', output: 'problems' };

export const toolSide = (memory: DockMemory, id: ToolId): Side => memory.sides[id] ?? DEFAULT_SIDES[id];

const toolPanel = (id: ToolId) => ({ id, component: 'tool', title: TOOL_TITLES[id] });
const inGrid = (group: DockviewGroupPanel | undefined): group is DockviewGroupPanel => group?.api.location.type === 'grid';
const hasDocument = (group: DockviewGroupPanel) => group.panels.some((p) => isDocPanelId(p.id));
const rectOf = (el: Element): Rect => el.getBoundingClientRect();
/** A docked group the user can see: a hidden (auto-hidden) group must not take panes in. */
const shownInGrid = (group: DockviewGroupPanel | undefined): group is DockviewGroupPanel => inGrid(group) && group.api.isVisible;
/** Whether the panel or group is still in this dock: a stale handle (a closed pane) is a no-op, never a throw. */
const livePanel = (api: DockviewApi, panel: IDockviewPanel): boolean => api.getPanel(panel.id) === panel;
const liveGroup = (api: DockviewApi, group: DockviewGroupPanel): boolean => api.groups.includes(group);

/** A group of the document area: it holds a document, or it is the remembered (empty) area. */
const isDocumentGroup = (group: DockviewGroupPanel, memory: DockMemory) => hasDocument(group) || group.id === memory.documentGroupId;

/** dockview's layout priority: a view marked 'high' takes a resize's difference before the others. */
const SLACK = 'high';
type Prioritised = { readonly priority?: string; _priority?: string };

/**
 * The document area takes the resize slack (Visual Studio): when the dock grows or shrinks, the
 * document groups get or give the difference and the tool panes keep their width or height.
 * dockview has no public option for a dock group's layout priority: its grid reads `priority` from
 * the group, which only `init` sets, so it is written here. `setConstraints({})` changes nothing
 * but makes the branches above drop the priority they cached. Call it whenever the document area
 * may have changed; it does nothing when every group is already marked right.
 */
export function markDocumentArea(api: DockviewApi, memory: DockMemory): void {
  for (const group of api.groups) {
    const want = inGrid(group) && isDocumentGroup(group, memory) ? SLACK : undefined;
    const g = group as unknown as Prioritised;
    if (g.priority === want) continue;
    g._priority = want;
    group.api.setConstraints({});
  }
}

/**
 * Notes the width of every docked tall tool group and the height of every wide one, and returns
 * what puts them back after a change that adds a group to the grid or takes one out: dockview
 * would otherwise take the space from, or give it to, the change's neighbours. The document area
 * takes it instead.
 */
function noteToolSizes(api: DockviewApi, memory: DockMemory): () => void {
  const kept = api.groups.filter((g) => shownInGrid(g) && !isDocumentGroup(g, memory))
    .map((group) => ({ group, tall: group.api.height > group.api.width, width: group.api.width, height: group.api.height }));
  return () => {
    markDocumentArea(api, memory);
    for (const { group, tall, width, height } of kept) {
      if (!liveGroup(api, group) || !shownInGrid(group) || isDocumentGroup(group, memory)) continue;
      if (tall ? group.api.width !== width : group.api.height !== height) group.api.setSize(tall ? { width } : { height });
    }
  };
}

/** Runs a change that adds a group to the grid or takes one out, keeping the other tool groups' sizes. */
function keepingToolSizes<T>(api: DockviewApi, memory: DockMemory, change: () => T): T {
  const putBack = noteToolSizes(api, memory);
  const result = change();
  putBack();
  return result;
}

/** The remembered document area, when it is still a group of the main grid. */
const rememberedArea = (api: DockviewApi, memory: DockMemory): DockviewGroupPanel | undefined => {
  const group = memory.documentGroupId === null ? undefined : api.groups.find((g) => g.id === memory.documentGroupId);
  return inGrid(group) ? group : undefined;
};

/**
 * The main-grid group documents go into: one that holds a document, else the remembered empty
 * area. Never a hidden group: dockview does not show a group a panel is added to, so a document
 * put there would be invisible (a pop-out leaves its group's place in the grid hidden).
 */
export function documentArea(api: DockviewApi, memory: DockMemory, except?: DockviewGroupPanel): DockviewGroupPanel | null {
  const withDoc = api.groups.find((g) => g !== except && shownInGrid(g) && hasDocument(g));
  if (withDoc) return withDoc;
  const remembered = rememberedArea(api, memory);
  return remembered && remembered !== except && shownInGrid(remembered) ? remembered : null;
}

/**
 * The document area. When the remembered area is hidden and empty (the place a popped-out document
 * group left), it is shown again; otherwise one is created as an empty group left of the Inspector
 * (or of everything).
 */
export function ensureDocumentArea(api: DockviewApi, memory: DockMemory): DockviewGroupPanel {
  const area = documentArea(api, memory);
  if (area) return area;
  const left = rememberedArea(api, memory);
  if (left && !left.api.isVisible && left.panels.length === 0) {
    left.api.setVisible(true);
    markDocumentArea(api, memory);
    return left;
  }
  const inspector = api.getPanel('inspector');
  const group = inGrid(inspector?.group)
    ? api.addGroup({ referencePanel: 'inspector', direction: 'left' })
    : api.groups.length === 0 ? api.addGroup() : api.addGroup({ direction: 'left' });
  memory.documentGroupId = group.id;
  markDocumentArea(api, memory);
  return group;
}

/** Opens a document as a tab of the document area. `renderer: 'always'` keeps its canvas mounted (spec §6.3). */
export function addDocument(api: DockviewApi, memory: DockMemory, documentId: string, title: string): IDockviewPanel {
  const area = ensureDocumentArea(api, memory);
  const panel = api.addPanel({
    id: docPanelId(documentId), component: 'document', tabComponent: 'studio', title, renderer: 'always',
    position: { referenceGroup: area },
  });
  memory.documentGroupId = panel.group.id;
  markDocumentArea(api, memory);
  return panel;
}

/** The box of every docked group, named by its first panel. */
function dockedBoxes(api: DockviewApi): GroupBox[] {
  return api.groups.filter((g) => inGrid(g) && g.panels.length > 0).map((g) => {
    const r = rectOf(g.element);
    return { ref: g.panels[0]!.id, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.right - r.left), height: Math.round(r.bottom - r.top) };
  });
}

/**
 * Remembers where panels sat before they leave the layout (spec §6.2.3): a tab taken out of a
 * group goes back into that group; a whole group goes back beside the neighbour it shared the
 * longest edge with. Either way the boxes of all docked groups are kept, to put sizes back.
 */
export function recordHome(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel, dock: Rect, leaving: readonly IDockviewPanel[] = group.panels): void {
  if (!inGrid(group)) return;
  const rect = rectOf(group.element);
  if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return;
  const side = sideOf(rect, dock);
  const layout = dockedBoxes(api);
  const staying = group.panels.find((p) => !leaving.includes(p));
  const beside = staying ? null : findHome(rect, layout.filter((b) => !group.panels.some((p) => p.id === b.ref))
    .map((b) => ({ ref: b.ref, rect: { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height } })));
  const home: Home | null = staying
    ? { ref: staying.id, direction: 'within', size: 0, layout }
    : beside ? { ...beside, layout } : null;
  for (const panel of leaving) {
    if (isToolId(panel.id)) memory.sides[panel.id] = side;
    if (home) memory.homes[panel.id] = home;
    else delete memory.homes[panel.id];
  }
}

/**
 * Puts every docked group back to the box it had when the home was recorded, left to right and
 * top to bottom, twice: dockview gives each resize's difference to the other groups, so a second
 * pass settles what the first disturbed. Groups that no longer exist are skipped.
 */
function restoreLayout(api: DockviewApi, layout: readonly GroupBox[]): void {
  const ordered = [...layout].sort((a, b) => a.left - b.left || a.top - b.top);
  for (let pass = 0; pass < 2; pass++) {
    for (const box of ordered) {
      const group = api.getPanel(box.ref)?.group;
      if (inGrid(group)) group.api.setSize({ width: box.width, height: box.height });
    }
  }
}

/** Shows a tool pane: focused if open, else back at its home, else on its side (next to its mate). */
export function showTool(api: DockviewApi, memory: DockMemory, id: ToolId): IDockviewPanel {
  const existing = api.getPanel(id);
  if (existing) { existing.api.setActive(); return existing; }
  const base = toolPanel(id);
  const home = memory.homes[id];
  // a home is used once: kept, a later reopen would replay its snapshot over the user's layout
  delete memory.homes[id];
  const ref = home ? api.getPanel(home.ref) : undefined;
  if (home && ref && shownInGrid(ref.group)) {
    const add = () => home.direction === 'within'
      ? api.addPanel({ ...base, position: { referencePanel: home.ref } })
      : api.addPanel({ ...base, position: { referencePanel: home.ref, direction: home.direction }, initialWidth: home.size, initialHeight: home.size });
    // a home with a snapshot puts every group back as it was; one without keeps the others as they are
    if (home.layout.length === 0) return keepingToolSizes(api, memory, add);
    const panel = add();
    restoreLayout(api, home.layout);
    return panel;
  }
  const side = toolSide(memory, id);
  const mate = MATE[id];
  const matePanel = mate ? api.getPanel(mate) : undefined;
  if (mate && matePanel && shownInGrid(matePanel.group) && toolSide(memory, mate) === side) {
    return api.addPanel({ ...base, position: { referencePanel: mate } });
  }
  return keepingToolSizes(api, memory, () =>
    api.addPanel({ ...base, position: { direction: SIDE_DIRECTION[side] }, initialWidth: TOOL_SIZE[id], initialHeight: TOOL_SIZE[id] }));
}

/**
 * Closes a tool pane (its × or View), remembering where it sat and its side, so View brings it
 * back there. Only its own place is kept, not the other groups' sizes: they stay as the user
 * leaves them. A floating pane keeps the place it was floated from, on the same terms.
 */
export function closeTool(api: DockviewApi, memory: DockMemory, panel: IDockviewPanel, dock: Rect): void {
  if (!livePanel(api, panel)) return;
  if (isToolId(panel.id)) {
    recordHome(api, memory, panel.group, dock, [panel]);
    const home = memory.homes[panel.id];
    if (home) memory.homes[panel.id] = { ...home, layout: [] };
  }
  keepingToolSizes(api, memory, () => api.removePanel(panel));
}

/** Floats a panel (the whole group when it is alone in it), remembering where it was. */
export function floatPanel(api: DockviewApi, memory: DockMemory, panel: IDockviewPanel, dock: Rect): void {
  if (!livePanel(api, panel)) return;
  const alone = panel.group.panels.length === 1;
  recordHome(api, memory, panel.group, dock, [panel]);
  keepingToolSizes(api, memory, () => api.addFloatingGroup(alone ? panel.group : panel));
}

/** Floats a whole group (the header's ⧉), remembering where it was. */
export function floatGroup(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel, dock: Rect): void {
  if (!liveGroup(api, group)) return;
  recordHome(api, memory, group, dock);
  keepingToolSizes(api, memory, () => api.addFloatingGroup(group));
}

/** Pops a group out into its own browser window, remembering where it was. */
export function popOut(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel, dock: Rect): void {
  if (!liveGroup(api, group)) return;
  recordHome(api, memory, group, dock);
  // the group leaves the grid once the window has opened
  const putBack = noteToolSizes(api, memory);
  void api.addPopoutGroup(group).then(putBack);
}

/**
 * Dock: a floating or popped-out group returns to the exact spot it left (spec §6.2.3); without a
 * home, a document goes into the document area and a tool pane back to its side.
 */
export function dockBack(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel): void {
  if (!liveGroup(api, group)) return;
  const panels = [...group.panels];
  const first = panels[0];
  if (!first) return;
  const home = memory.homes[first.id];
  for (const p of panels) delete memory.homes[p.id];
  const ref = home ? api.getPanel(home.ref) : undefined;
  // A hidden home group is passed over: the pane would vanish into it, on no rail. It falls
  // through to the no-home path (a tool pane to its side, in a group the user can see).
  if (home && ref && ref.group !== group && shownInGrid(ref.group)) {
    if (home.direction === 'within') {
      for (const p of panels) p.api.moveTo({ group: ref.group, position: 'center' });
      restoreLayout(api, home.layout);
      first.api.setActive();
      return;
    }
    first.api.moveTo({ group: ref.group, position: toPosition(home.direction) });
    const landed = first.group;
    for (const p of panels.slice(1)) p.api.moveTo({ group: landed, position: 'center' });
    restoreLayout(api, home.layout);
    first.api.setActive();
    return;
  }
  if (!isDocPanelId(first.id)) {
    for (const p of panels) api.removePanel(p);
    for (const p of panels) if (isToolId(p.id)) showTool(api, memory, p.id);
    return;
  }
  const area = documentArea(api, memory, group) ?? ensureDocumentArea(api, memory);
  for (const p of panels) p.api.moveTo({ group: area, position: 'center' });
  first.api.setActive();
}

/**
 * Auto hide (spec §6.2.5). A docked group of tool panes is hidden in place (dockview keeps its
 * slot and size, so pinning it back is exact); a floating, popped-out or document-sharing pane
 * leaves the layout instead, remembering where it was. Returns the panes that go to a rail.
 */
export function autoHide(api: DockviewApi, memory: DockMemory, panel: IDockviewPanel, dock: Rect): ToolId[] {
  if (!isToolId(panel.id) || !livePanel(api, panel)) return [];
  const group = panel.group;
  if (inGrid(group) && !hasDocument(group)) {
    for (const p of group.panels) if (isToolId(p.id)) memory.sides[p.id] = sideOf(rectOf(group.element), dock);
    group.api.setVisible(false);
    return group.panels.map((p) => p.id).filter(isToolId);
  }
  recordHome(api, memory, group, dock, [panel]);
  keepingToolSizes(api, memory, () => api.removePanel(panel));
  return [panel.id];
}

/** Pin back from a rail: a hidden group shows again where it was; a removed pane goes home. Returns the panes that leave the rail. */
export function pinBack(api: DockviewApi, memory: DockMemory, id: ToolId): ToolId[] {
  const panel = api.getPanel(id);
  if (panel && !panel.group.api.isVisible) {
    panel.group.api.setVisible(true);
    panel.api.setActive();
    return panel.group.panels.map((p) => p.id).filter(isToolId);
  }
  showTool(api, memory, id);
  return [id];
}

/** "Dock as tabbed document": a tool pane becomes a tab of the document area. */
export function dockAsDocument(api: DockviewApi, memory: DockMemory, panel: IDockviewPanel, dock: Rect): void {
  if (!livePanel(api, panel)) return;
  const area = documentArea(api, memory, panel.group) ?? ensureDocumentArea(api, memory);
  if (area === panel.group) return;
  recordHome(api, memory, panel.group, dock, [panel]);
  keepingToolSizes(api, memory, () => panel.api.moveTo({ group: area, position: 'center' }));
  panel.api.setActive();
}

/**
 * Reset window layout (mockup v49 resetLayout): every document into one document area, every
 * tool pane at its default place and size, nothing remembered. Open documents are moved, never
 * re-created, so their canvases keep their viewport.
 */
export function resetLayout(api: DockviewApi, memory: DockMemory, dockWidth: number): void {
  memory.sides = {};
  memory.homes = {};
  for (const id of TOOL_IDS) { const p = api.getPanel(id); if (p) api.removePanel(p); }
  const area = ensureDocumentArea(api, memory);
  for (const p of api.panels.filter((x) => isDocPanelId(x.id))) {
    if (p.group !== area) p.api.moveTo({ group: area, position: 'center' });
  }
  memory.documentGroupId = area.id;
  api.addPanel({ ...toolPanel('inspector'), position: { referenceGroup: area, direction: 'right' }, initialWidth: TOOL_SIZE.inspector });
  api.addPanel({ ...toolPanel('toolbox'), position: { referencePanel: 'inspector', direction: 'right' }, initialWidth: TOOL_SIZE.toolbox });
  api.addPanel({ ...toolPanel('problems'), position: { referenceGroup: area, direction: 'below' }, initialHeight: TOOL_SIZE.problems });
  api.addPanel({ ...toolPanel('output'), position: { referencePanel: 'problems' }, inactive: true });
  // the document area takes what the panes leave (it takes the slack), but keeps 480 px at least
  markDocumentArea(api, memory);
  api.getPanel('inspector')?.group.api.setSize({ width: TOOL_SIZE.inspector });
  api.getPanel('toolbox')?.group.api.setSize({ width: TOOL_SIZE.toolbox });
  api.getPanel('problems')?.group.api.setSize({ height: TOOL_SIZE.problems });
  if (dockWidth - TOOL_SIZE.inspector - TOOL_SIZE.toolbox < 480) area.api.setSize({ width: 480 });
  area.activePanel?.api.setActive();
}

/**
 * Window › Save window layout: dockview's layout without documents, plus what the dock remembers.
 * With `keepDocuments` it is the session's snapshot: the documents stay where they are.
 */
export function captureLayout(api: DockviewApi, memory: DockMemory, hidden: readonly ToolId[], { keepDocuments = false }: { keepDocuments?: boolean } = {}): SavedLayout {
  const { dock, documentGroupId, popped: poppedGroups } = (keepDocuments ? sessionDock : stripDocuments)(api.toJSON());
  const homes: SavedLayout['homes'] = {};
  for (const id of TOOL_IDS) { const h = memory.homes[id]; if (h) homes[id] = h; }
  // a popped-out group goes back docked: its first pane to the home it left (its place only, not
  // the old sizes of the others), the rest as tabs beside it
  const popped: ToolId[] = [];
  for (const group of poppedGroups) {
    const [first, ...rest] = group.filter(isToolId);
    if (!first) continue;
    popped.push(first, ...rest);
    const home = homes[first];
    if (home) homes[first] = { ...home, layout: [] };
    for (const id of rest) homes[id] = { ref: first, direction: 'within', size: 0, layout: [] };
  }
  // the remembered area only when the snapshot still holds it (the session drops a pop-out's hidden place)
  const remembered = memory.documentGroupId !== null && gridHolds(dock, memory.documentGroupId) ? memory.documentGroupId : null;
  return { version: 1, dock, documentGroupId: documentGroupId ?? remembered, hidden: [...hidden], sides: { ...memory.sides }, homes, popped };
}

/**
 * Window › Apply saved layout. The open documents are put into the saved document area and
 * dockview moves them there (`reuseExistingPanels`), so their canvases are not re-created.
 * Returns the panes that go back on a rail. Throws when dockview rejects the layout.
 */
export function applyLayout(api: DockviewApi, memory: DockMemory, saved: SavedLayout): ToolId[] {
  // a tool pane the dock does not know would be an empty tab (ToolHost renders nothing): reject it up front
  for (const panel of Object.values(saved.dock.panels)) {
    if (isToolId(panel.id) !== (panel.contentComponent === 'tool')) throw new Error(`The layout holds a tool pane the dock does not know: ${panel.id}`);
  }
  const current = api.toJSON();
  const documents = Object.values(current.panels).filter((p) => isDocPanelId(p.id));
  const staged = api.panels.filter((p) => isDocPanelId(p.id));
  const active = api.activePanel && isDocPanelId(api.activePanel.id) ? api.activePanel.id : documents[0]?.id ?? null;
  try {
    api.fromJSON(withDocuments(saved.dock, saved.documentGroupId, documents, active), { reuseExistingPanels: true });
  } catch (error) {
    // dockview clears the whole dock when a layout fails halfway, the re-attached documents
    // included. Open them again (new panels: their canvases start from the default view) so no
    // document is lost, then report the failure; the caller resets to the default layout.
    memory.sides = {};
    memory.homes = {};
    memory.documentGroupId = null;
    // With reuseExistingPanels dockview first parks the open documents in staging groups; when the
    // layout fails before reaching them it empties those groups without disposing the panels, so
    // their content (renderer 'always': still mounted in the render overlay) would outlive them
    // beside the re-opened copies. Dispose every one dockview no longer holds.
    for (const panel of staged) if (api.getPanel(panel.id) !== panel) panel.dispose();
    for (const doc of documents) {
      const documentId = documentIdOf(doc.id);
      if (documentId !== null && !api.getPanel(doc.id)) addDocument(api, memory, documentId, doc.title ?? documentId);
    }
    const reopened = active === null ? undefined : api.getPanel(active);
    reopened?.api.setActive();
    throw error;
  }
  memory.sides = { ...saved.sides };
  memory.homes = { ...saved.homes };
  memory.documentGroupId = saved.documentGroupId;
  markDocumentArea(api, memory);
  for (const id of saved.popped) if (!api.getPanel(id)) showTool(api, memory, id);
  return saved.hidden.filter((id) => { const p = api.getPanel(id); return !p || !p.group.api.isVisible; });
}

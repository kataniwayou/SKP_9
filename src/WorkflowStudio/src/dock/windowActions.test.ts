import { createDockview, type DockviewApi, type IContentRenderer, type ITabRenderer } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDocument, applyLayout, autoHide, captureLayout, dockAsDocument, dockBack, documentArea, ensureDocumentArea, floatGroup, floatPanel,
  closeTool, newMemory, pinBack, resetLayout, showTool, type DockMemory,
} from './windowActions';
import { parseLayout, readLayout, writeLayout } from './layoutPersistence';
import { memoryStorage } from '../test/memoryStorage';

// dockview's core runs in jsdom (no sizes, so recordHome finds no home: tests set homes directly).
class Part implements IContentRenderer {
  readonly element = document.createElement('div');
  init() {}
}
class Tab implements ITabRenderer {
  readonly element = document.createElement('div');
  init() {}
}
const NO_RECT = { left: 0, top: 0, right: 0, bottom: 0 };

let hosts: HTMLElement[] = [];
afterEach(() => { hosts.forEach((h) => h.remove()); hosts = []; });

function dock(): { api: DockviewApi; memory: DockMemory } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const api = createDockview(host, { createComponent: () => new Part(), createTabComponent: () => new Tab() });
  api.layout(1200, 700);
  return { api, memory: newMemory() };
}

const where = (api: DockviewApi, id: string) => {
  const panel = api.getPanel(id);
  return panel ? { group: panel.group.id, location: panel.group.api.location.type } : null;
};

/** Toolbox moved in as a tab of the Inspector's group: a tab group of two tool panes (none is tabbed by default since Problems went). */
const tabToolbox = (api: DockviewApi) => api.getPanel('toolbox')!.api.moveTo({ group: api.getPanel('inspector')!.group, position: 'center' });

describe('window actions on a real dockview', () => {
  it('keeps one document area: an empty group at first, then the documents as its tabs', () => {
    const { api, memory } = dock();
    const area = ensureDocumentArea(api, memory);
    expect(area.panels).toHaveLength(0);
    expect(ensureDocumentArea(api, memory)).toBe(area);

    addDocument(api, memory, 'a', 'orders');
    addDocument(api, memory, 'b', 'billing');

    expect(where(api, 'doc:a')).toEqual({ group: area.id, location: 'grid' });
    expect(where(api, 'doc:b')?.group).toBe(area.id);
    expect(api.getPanel('doc:a')!.api.renderer).toBe('always');
  });

  it('shows the tool panes at their default places, each in a group of its own (no Problems pane, 2026-10-09)', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    for (const id of ['inspector', 'toolbox', 'output'] as const) showTool(api, memory, id);

    expect(api.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'inspector', 'output', 'toolbox']);
    expect(new Set(['doc:a', 'inspector', 'toolbox', 'output'].map((id) => where(api, id)!.group)).size).toBe(4);
    expect(showTool(api, memory, 'inspector')).toBe(api.getPanel('inspector'));
  });

  it('docks a floated pane back to the exact neighbour and side it remembered', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    showTool(api, memory, 'inspector');
    showTool(api, memory, 'output');
    floatPanel(api, memory, api.getPanel('output')!, NO_RECT);
    expect(where(api, 'output')!.location).toBe('floating');
    memory.homes.output = { ref: 'inspector', direction: 'below', size: 150, layout: [] };

    dockBack(api, memory, api.getPanel('output')!.group);

    const branch = JSON.stringify(api.toJSON().grid.root);
    expect(where(api, 'output')!.location).toBe('grid');
    expect(branch.indexOf('"inspector"')).toBeLessThan(branch.indexOf('"output"'));
    expect(where(api, 'output')!.group).not.toBe(where(api, 'inspector')!.group);
  });

  it('docks a tab floated out of a tab group back into that group', () => {
    // jsdom lays nothing out; give every group a box so the home is recorded
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, width: 100, height: 100 } as DOMRect);
    try {
      const { api, memory } = dock();
      resetLayout(api, memory, 1200);
      tabToolbox(api);
      floatPanel(api, memory, api.getPanel('toolbox')!, { left: 0, top: 0, right: 1200, bottom: 700 });
      expect(where(api, 'toolbox')!.location).toBe('floating');
      expect(memory.homes.toolbox).toMatchObject({ ref: 'inspector', direction: 'within' });

      dockBack(api, memory, api.getPanel('toolbox')!.group);

      expect(where(api, 'toolbox')).toEqual(where(api, 'inspector'));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('without a home, docks a document into the document area and a tool pane back to its side', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    addDocument(api, memory, 'b', 'billing');
    showTool(api, memory, 'toolbox');
    floatPanel(api, memory, api.getPanel('doc:b')!, NO_RECT);
    floatPanel(api, memory, api.getPanel('toolbox')!, NO_RECT);

    dockBack(api, memory, api.getPanel('doc:b')!.group);
    dockBack(api, memory, api.getPanel('toolbox')!.group);

    expect(where(api, 'doc:b')).toEqual(where(api, 'doc:a'));
    expect(where(api, 'toolbox')!.location).toBe('grid');
  });

  it('auto-hides a docked tool group in place and pins it back where it was', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    tabToolbox(api);
    const inspector = api.getPanel('inspector')!;

    expect(autoHide(api, memory, inspector, NO_RECT)).toEqual(['inspector', 'toolbox']);
    expect(inspector.group.api.isVisible).toBe(false);
    expect(api.getPanel('toolbox')!.group).toBe(inspector.group);

    expect(pinBack(api, memory, 'toolbox')).toEqual(['inspector', 'toolbox']);
    expect(inspector.group.api.isVisible).toBe(true);
  });

  it('auto-hides a pane that shares the document area by taking it out, and shows it again', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    showTool(api, memory, 'inspector');
    dockAsDocument(api, memory, api.getPanel('inspector')!, NO_RECT);

    expect(autoHide(api, memory, api.getPanel('inspector')!, NO_RECT)).toEqual(['inspector']);
    expect(api.getPanel('inspector')).toBeUndefined();
    expect(api.getPanel('doc:a')).toBeDefined();
    expect(autoHide(api, memory, api.getPanel('doc:a')!, NO_RECT)).toEqual([]);

    expect(pinBack(api, memory, 'inspector')).toEqual(['inspector']);
    expect(where(api, 'inspector')!.location).toBe('grid');
  });

  it('docks a tool pane as a tab of the document area', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    showTool(api, memory, 'output');
    dockAsDocument(api, memory, api.getPanel('output')!, NO_RECT);
    expect(where(api, 'output')).toEqual(where(api, 'doc:a'));
  });

  it('resets the layout without re-creating the open documents', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    const docA = api.getPanel('doc:a');
    showTool(api, memory, 'inspector');
    floatPanel(api, memory, docA!, NO_RECT);
    memory.homes.inspector = { ref: 'gone', direction: 'left', size: 10, layout: [] };

    resetLayout(api, memory, 1200);

    expect(api.getPanel('doc:a')).toBe(docA);
    expect(where(api, 'doc:a')!.location).toBe('grid');
    expect(api.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'inspector', 'output', 'toolbox']);
    expect(memory.homes).toEqual({});
  });

  it('saves a layout without documents and applies it back around the open documents', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    floatPanel(api, memory, api.getPanel('toolbox')!, NO_RECT);
    const hidden = autoHide(api, memory, api.getPanel('output')!, NO_RECT);
    const saved = captureLayout(api, memory, hidden);
    expect(JSON.stringify(saved.dock)).not.toContain('doc:a');
    expect(saved.hidden).toEqual(['output']);

    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'b', 'billing');
    const docA = api.getPanel('doc:a'), docB = api.getPanel('doc:b');

    expect(applyLayout(api, memory, saved)).toEqual(['output']);

    expect(where(api, 'toolbox')!.location).toBe('floating');
    expect(api.getPanel('output')!.group.api.isVisible).toBe(false);
    expect(api.getPanel('doc:a')).toBe(docA);
    expect(api.getPanel('doc:b')).toBe(docB);
    expect(where(api, 'doc:a')!.group).toBe(saved.documentGroupId);
  });

  it('keeps the documents in the session snapshot (keepDocuments) and strips them by default', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    expect(captureLayout(api, memory, [], { keepDocuments: true }).dock.panels['doc:a']).toBeDefined();
    expect(captureLayout(api, memory, []).dock.panels['doc:a']).toBeUndefined();
  });

  it('throws when dockview rejects a layout, and keeps the open documents open', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    addDocument(api, memory, 'b', 'billing');
    api.getPanel('doc:a')!.api.setActive();
    const saved = captureLayout(api, memory, []);
    saved.dock = { ...saved.dock, grid: { ...saved.dock.grid, root: { type: 'branch', data: [{ type: 'leaf', data: { views: [] } }] } } } as never;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => applyLayout(api, memory, saved)).toThrow();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('failed to deserialize layout'), expect.anything());
    } finally {
      logged.mockRestore();
    }

    expect(api.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'doc:b']);
    expect(api.getPanel('doc:a')!.group).toBe(api.getPanel('doc:b')!.group);
    expect(api.getPanel('doc:a')!.title).toBe('orders');
    expect(api.getPanel('doc:a')!.api.renderer).toBe('always');
    expect(api.activePanel?.id).toBe('doc:a');
  });
});

describe('window actions on panels that are no longer in the dock', () => {
  it('do nothing for a closed tool pane, and report no rail entry', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    const toolbox = showTool(api, memory, 'toolbox');
    const output = showTool(api, memory, 'output');
    const inspector = showTool(api, memory, 'inspector');
    api.removePanel(toolbox);
    api.removePanel(output);
    api.removePanel(inspector);
    const before = JSON.stringify(api.toJSON());

    expect(() => floatPanel(api, memory, toolbox, NO_RECT)).not.toThrow();
    expect(() => dockAsDocument(api, memory, toolbox, NO_RECT)).not.toThrow();
    expect(() => dockAsDocument(api, memory, output, NO_RECT)).not.toThrow();
    expect(autoHide(api, memory, inspector, NO_RECT)).toEqual([]);
    expect(autoHide(api, memory, toolbox, NO_RECT)).toEqual([]);
    expect(JSON.stringify(api.toJSON())).toBe(before);
  });

  it('do nothing for a group that has gone', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    const toolbox = showTool(api, memory, 'toolbox');
    const group = toolbox.group;
    api.removePanel(toolbox);
    expect(() => dockBack(api, memory, group)).not.toThrow();
    expect(() => floatGroup(api, memory, group, NO_RECT)).not.toThrow();
    expect(api.getPanel('toolbox')).toBeUndefined();
  });
});

describe('docking next to a hidden group', () => {
  it('never puts a pane into a hidden group: Toolbox docks to a visible group of its own', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, width: 100, height: 100 } as DOMRect);
    try {
      const { api, memory } = dock();
      resetLayout(api, memory, 1200);
      tabToolbox(api);
      const inspector = api.getPanel('inspector')!;
      floatPanel(api, memory, api.getPanel('toolbox')!, { left: 0, top: 0, right: 1200, bottom: 700 });
      expect(autoHide(api, memory, inspector, NO_RECT)).toEqual(['inspector']);

      dockBack(api, memory, api.getPanel('toolbox')!.group);

      const landed = api.getPanel('toolbox')!.group;
      expect(landed.api.location.type).toBe('grid');
      expect(landed.api.isVisible).toBe(true);
      expect(landed).not.toBe(inspector.group);
      expect(inspector.group.api.isVisible).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('shows a closed tool pane in a visible group, not beside a hidden group it was a tab of', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    tabToolbox(api);
    api.removePanel(api.getPanel('toolbox')!);
    autoHide(api, memory, api.getPanel('inspector')!, NO_RECT);
    memory.homes.toolbox = { ref: 'inspector', direction: 'within', size: 0, layout: [] };

    const panel = showTool(api, memory, 'toolbox');

    expect(panel.group.api.isVisible).toBe(true);
  });
});

describe('dockAsDocument without a document area', () => {
  it('creates the document area when the last document has closed', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    api.removePanel(api.getPanel('doc:a')!);
    const inspector = showTool(api, memory, 'inspector');

    dockAsDocument(api, memory, inspector, NO_RECT);

    expect(where(api, 'inspector')!.location).toBe('grid');
    expect(where(api, 'inspector')!.group).toBe(ensureDocumentArea(api, memory).id);
  });
});

describe('tool pane homes (review Important 2)', () => {
  const DOCK = { left: 0, top: 0, right: 1200, bottom: 700 };

  it('forgets a home once it was used: a later reopen does not put back old sizes', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    const area = () => api.getPanel('doc:a')!.group;
    floatPanel(api, memory, api.getPanel('inspector')!, NO_RECT);
    memory.homes.inspector = { ref: 'toolbox', direction: 'left', size: 340, layout: [{ ref: 'doc:a', left: 0, top: 0, width: 300, height: 500 }] };

    dockBack(api, memory, api.getPanel('inspector')!.group);
    expect(area().api.width).toBe(300);
    expect(memory.homes.inspector).toBeUndefined();

    // the user widens the document area, then closes the Inspector and reopens it from View
    area().api.setSize({ width: 600 });
    api.removePanel(api.getPanel('inspector')!);
    const resize = vi.spyOn(area().api, 'setSize');
    showTool(api, memory, 'inspector');

    expect(resize).not.toHaveBeenCalled();
    expect(area().api.width).not.toBe(300);
  });

  it('forgets a home once showTool used it', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    api.removePanel(api.getPanel('output')!);
    memory.homes.output = { ref: 'toolbox', direction: 'within', size: 0, layout: [] };

    showTool(api, memory, 'output');

    expect(api.getPanel('output')!.group).toBe(api.getPanel('toolbox')!.group);
    expect(memory.homes.output).toBeUndefined();
  });

  it('closing a pane remembers its side, and it reopens there', () => {
    // a tall group at the dock's left edge
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 600, x: 0, y: 0, width: 100, height: 600 } as DOMRect);
    try {
      const { api, memory } = dock();
      resetLayout(api, memory, 1200);
      addDocument(api, memory, 'a', 'orders');

      closeTool(api, memory, api.getPanel('inspector')!, DOCK);
      expect(api.getPanel('inspector')).toBeUndefined();
      expect(memory.sides.inspector).toBe('left');

      showTool(api, memory, 'inspector');
      const root = JSON.stringify(api.toJSON().grid.root);
      expect(root.indexOf('"inspector"')).toBeLessThan(root.indexOf('"doc:a"'));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('closing a tab of a group remembers that group, but no other group sizes', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, width: 100, height: 100 } as DOMRect);
    try {
      const { api, memory } = dock();
      resetLayout(api, memory, 1200);
      tabToolbox(api);

      closeTool(api, memory, api.getPanel('toolbox')!, DOCK);
      expect(memory.homes.toolbox).toEqual({ ref: 'inspector', direction: 'within', size: 0, layout: [] });

      showTool(api, memory, 'toolbox');
      expect(api.getPanel('toolbox')!.group).toBe(api.getPanel('inspector')!.group);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('closing a floating pane keeps where it came from, but not the old sizes of the others', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    floatPanel(api, memory, api.getPanel('toolbox')!, NO_RECT);
    memory.homes.toolbox = { ref: 'inspector', direction: 'right', size: 290, layout: [{ ref: 'inspector', left: 0, top: 0, width: 999, height: 500 }] };

    closeTool(api, memory, api.getPanel('toolbox')!, DOCK);

    expect(api.getPanel('toolbox')).toBeUndefined();
    expect(memory.homes.toolbox).toEqual({ ref: 'inspector', direction: 'right', size: 290, layout: [] });
  });
});

describe('a tool pane popped out when the layout was saved (review Minor 3)', () => {
  /** The dock's layout as if the given floating panes' group were popped out to its own window instead. */
  const asPoppedOut = (api: DockviewApi, ids: readonly string[]) => {
    const json = api.toJSON();
    const floating = (json.floatingGroups ?? []).filter((f) => f.data && ids.some((id) => f.data!.views.includes(id)));
    json.floatingGroups = (json.floatingGroups ?? []).filter((f) => !floating.includes(f));
    json.popoutGroups = floating.map((f) => ({ data: f.data, gridReferenceGroup: undefined, position: null, url: '/popout.html' }));
    return json;
  };

  it('is saved without its pop-out window, and comes back docked where it was after Apply', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    floatPanel(api, memory, api.getPanel('toolbox')!, NO_RECT);
    vi.spyOn(api, 'toJSON').mockReturnValueOnce(asPoppedOut(api, ['toolbox']));
    memory.homes.toolbox = { ref: 'inspector', direction: 'right', size: 290, layout: [{ ref: 'inspector', left: 0, top: 0, width: 999, height: 500 }] };

    const saved = captureLayout(api, memory, []);
    vi.restoreAllMocks();

    expect(saved.dock.popoutGroups).toEqual([]);
    expect(saved.dock.panels.toolbox).toBeUndefined();
    expect(saved.homes.toolbox).toEqual({ ref: 'inspector', direction: 'right', size: 290, layout: [] });

    resetLayout(api, memory, 1200);
    api.removePanel(api.getPanel('toolbox')!);
    applyLayout(api, memory, saved);

    expect(where(api, 'toolbox')?.location).toBe('grid');
    const root = JSON.stringify(api.toJSON().grid.root);
    expect(root.indexOf('"inspector"')).toBeLessThan(root.indexOf('"toolbox"'));
  });

  it('comes back after a reload too, a popped-out tab group as one group', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    tabToolbox(api);
    floatGroup(api, memory, api.getPanel('inspector')!.group, NO_RECT);
    vi.spyOn(api, 'toJSON').mockReturnValueOnce(asPoppedOut(api, ['inspector']));
    const storage = memoryStorage();
    writeLayout(storage, captureLayout(api, memory, []));
    vi.restoreAllMocks();

    const { api: fresh, memory: freshMemory } = dock();
    addDocument(fresh, freshMemory, 'b', 'billing');
    applyLayout(fresh, freshMemory, readLayout(storage)!);

    expect(where(fresh, 'inspector')?.location).toBe('grid');
    expect(where(fresh, 'toolbox')).toEqual(where(fresh, 'inspector'));
    expect(fresh.getPanel('inspector')!.group.api.isVisible).toBe(true);
  });
});

describe('the document area takes the resize slack (ruling)', () => {
  // as the studio's dock: no proportional layout
  function fixedDock(): { api: DockviewApi; memory: DockMemory } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const api = createDockview(host, { createComponent: () => new Part(), createTabComponent: () => new Tab(), proportionalLayout: false });
    api.layout(1200, 700);
    return { api, memory: newMemory() };
  }
  const sizes = (api: DockviewApi) => {
    const g = (id: string) => api.getPanel(id)!.group.api;
    return { area: g('doc:a').width, areaHeight: g('doc:a').height, inspector: g('inspector').width, toolbox: g('toolbox').width, output: g('output').height };
  };

  it('when the dock grows or shrinks, after Reset', () => {
    const { api, memory } = fixedDock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    const before = sizes(api);
    expect(before).toEqual({ area: 570, areaHeight: 550, inspector: 340, toolbox: 290, output: 150 });

    api.layout(1500, 800);
    expect(sizes(api)).toEqual({ ...before, area: before.area + 300, areaHeight: before.areaHeight + 100 });
    api.layout(1000, 650);
    expect(sizes(api)).toEqual({ ...before, area: before.area - 200, areaHeight: before.areaHeight - 50 });
  });

  it('when the dock grows or shrinks, after a saved layout is applied', () => {
    const { api, memory } = fixedDock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    const saved = captureLayout(api, memory, []);
    resetLayout(api, memory, 1200);
    applyLayout(api, memory, saved);
    const before = sizes(api);

    api.layout(1500, 700);
    expect(sizes(api)).toEqual({ ...before, area: before.area + 300 });
    api.layout(1000, 700);
    expect(sizes(api)).toEqual({ ...before, area: before.area - 200 });
  });

  it('when a pane is closed or opened, the other panes keep their size', () => {
    const { api, memory } = fixedDock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    const before = sizes(api);

    closeTool(api, memory, api.getPanel('toolbox')!, NO_RECT);
    expect(api.getPanel('inspector')!.group.api.width).toBe(before.inspector);
    expect(api.getPanel('doc:a')!.group.api.width).toBe(before.area + before.toolbox);

    showTool(api, memory, 'toolbox');
    expect(api.getPanel('inspector')!.group.api.width).toBe(before.inspector);
    expect(api.getPanel('toolbox')!.group.api.width).toBe(before.toolbox);
    expect(api.getPanel('doc:a')!.group.api.width).toBe(before.area);

    closeTool(api, memory, api.getPanel('output')!, NO_RECT);
    expect(api.getPanel('doc:a')!.group.api.height).toBe(700);
    showTool(api, memory, 'output');
    expect(api.getPanel('output')!.group.api.height).toBe(before.output);
    expect(api.getPanel('inspector')!.group.api.width).toBe(before.inspector);
  });
});

describe('applying a saved layout whose root size is the wrong dimension', () => {
  it('keeps the saved heights (dockview can write the root branch size as the width after a Reset)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const api = createDockview(host, { createComponent: () => new Part(), createTabComponent: () => new Tab(), proportionalLayout: false });
    api.layout(1200, 700);
    const memory = newMemory();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    const saved = captureLayout(api, memory, []);
    expect(saved.dock.grid.root.size).toBe(700);
    saved.dock.grid.root.size = 1200;

    resetLayout(api, memory, 1200);
    applyLayout(api, memory, saved);

    expect(api.getPanel('output')!.group.api.height).toBe(150);
    expect(api.getPanel('doc:a')!.group.api.height).toBe(550);
  });
});

describe('a document area left hidden (the place a popped-out document group left, review Critical 1)', () => {
  /** A dock whose remembered document area is in the grid but hidden and empty, as a pop-out leaves it. */
  const leftBehind = () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    const area = ensureDocumentArea(api, memory);
    area.api.setVisible(false);
    return { api, memory, area };
  };

  it('is never given a document while hidden: the document is shown', () => {
    const { api, memory } = leftBehind();
    const panel = addDocument(api, memory, 'a', 'orders');
    expect(panel.group.api.location.type).toBe('grid');
    expect(panel.group.api.isVisible).toBe(true);
  });

  it('is not offered as the document area while hidden', () => {
    const { api, memory } = leftBehind();
    expect(documentArea(api, memory)).toBeNull();
  });

  it('is left out of the session snapshot, so a restore cannot bring it back hidden', () => {
    const { api, memory, area } = leftBehind();
    const session = captureLayout(api, memory, [], { keepDocuments: true });
    expect(JSON.stringify(session.dock.grid.root)).not.toContain(`"${area.id}"`);
    expect(session.documentGroupId).not.toBe(area.id);

    const { api: fresh, memory: freshMemory } = dock();
    applyLayout(fresh, freshMemory, session);
    const panel = addDocument(fresh, freshMemory, 'a', 'orders');
    expect(panel.group.api.location.type).toBe('grid');
    expect(panel.group.api.isVisible).toBe(true);
    expect(fresh.groups.filter((g) => !g.api.isVisible)).toEqual([]);
  });
});

describe('Apply with a saved layout that lost its document group (a Save made while the group was popped out)', () => {
  /** Saves a layout the way Window > Save does while the only document is popped out (group left hidden and empty), then has the document back. */
  const savedWhilePopped = (railed: readonly ('inspector' | 'toolbox' | 'output')[]) => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    const hidden = [...railed].flatMap((id) => autoHide(api, memory, api.getPanel(id)!, NO_RECT));
    const area = api.getPanel('doc:a')!.group;
    api.getPanel('doc:a')!.api.close();
    area.api.setVisible(false);
    const saved = captureLayout(api, memory, hidden);
    expect(JSON.stringify(saved.dock.grid.root)).not.toContain(`"${area.id}"`);
    area.api.setVisible(true);
    addDocument(api, memory, 'a', 'orders');
    return { api, memory, saved };
  };
  const expectDocumentArea = (api: DockviewApi) => {
    const group = api.getPanel('doc:a')!.group;
    expect(group.api.isVisible).toBe(true);
    expect(group.api.location.type).toBe('grid');
    expect(group.panels.map((p) => p.id)).toEqual(['doc:a']);
  };

  it('keeps the document, shown in a document area, when every other group is a rail', () => {
    const { api, memory, saved } = savedWhilePopped(['inspector', 'toolbox', 'output']);
    applyLayout(api, memory, saved);
    expect(api.panels.filter((p) => p.id.startsWith('doc:')).map((p) => p.id)).toEqual(['doc:a']);
    expectDocumentArea(api);
    expect(memory.documentGroupId).toBe(api.getPanel('doc:a')!.group.id);
  });

  it('opens the document in a document area of its own, not as a tab of a tool group', () => {
    const { api, memory, saved } = savedWhilePopped([]);
    applyLayout(api, memory, saved);
    expectDocumentArea(api);
  });
});

describe('a session or saved layout from before Problems moved into Output (2026-10-09)', () => {
  it('applies without error and without an empty place, keeping the documents', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    // the old default: Problems and Output tabbed together below the documents
    api.addPanel({ id: 'problems', component: 'tool', title: 'Problems', position: { referencePanel: 'output' } });
    const old = JSON.parse(JSON.stringify(captureLayout(api, memory, ['problems', 'output'] as never, { keepDocuments: true })));
    expect(JSON.stringify(old)).toContain('"problems"');

    const { api: fresh, memory: freshMemory } = dock();
    addDocument(fresh, freshMemory, 'a', 'orders');
    const docA = fresh.getPanel('doc:a');
    const layout = parseLayout(old)!;
    expect(() => applyLayout(fresh, freshMemory, layout)).not.toThrow();

    expect(fresh.getPanel('problems')).toBeUndefined();
    expect(fresh.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'inspector', 'output', 'toolbox']);
    expect(fresh.getPanel('doc:a')).toBe(docA);
    expect(fresh.groups.filter((g) => g.panels.length === 0)).toEqual([]);
    expect(fresh.getPanel('output')!.group.activePanel?.id).toBe('output');
  });
});

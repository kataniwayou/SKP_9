import { createDockview, type DockviewApi, type IContentRenderer, type ITabRenderer } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDocument, applyLayout, autoHide, captureLayout, dockAsDocument, dockBack, ensureDocumentArea, floatGroup, floatPanel,
  newMemory, pinBack, resetLayout, showTool, type DockMemory,
} from './windowActions';

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

  it('shows the tool panes at their default places, Problems and Output tabbed together', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    for (const id of ['inspector', 'toolbox', 'problems', 'output'] as const) showTool(api, memory, id);

    expect(api.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'inspector', 'output', 'problems', 'toolbox']);
    expect(where(api, 'output')!.group).toBe(where(api, 'problems')!.group);
    expect(where(api, 'inspector')!.group).not.toBe(where(api, 'doc:a')!.group);
    expect(showTool(api, memory, 'inspector')).toBe(api.getPanel('inspector'));
  });

  it('docks a floated pane back to the exact neighbour and side it remembered', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    showTool(api, memory, 'inspector');
    showTool(api, memory, 'problems');
    floatPanel(api, memory, api.getPanel('problems')!, NO_RECT);
    expect(where(api, 'problems')!.location).toBe('floating');
    memory.homes.problems = { ref: 'inspector', direction: 'below', size: 150, layout: [] };

    dockBack(api, memory, api.getPanel('problems')!.group);

    const branch = JSON.stringify(api.toJSON().grid.root);
    expect(where(api, 'problems')!.location).toBe('grid');
    expect(branch.indexOf('"inspector"')).toBeLessThan(branch.indexOf('"problems"'));
    expect(where(api, 'problems')!.group).not.toBe(where(api, 'inspector')!.group);
  });

  it('docks a tab floated out of a tab group back into that group', () => {
    // jsdom lays nothing out; give every group a box so the home is recorded
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, width: 100, height: 100 } as DOMRect);
    try {
      const { api, memory } = dock();
      resetLayout(api, memory, 1200);
      floatPanel(api, memory, api.getPanel('output')!, { left: 0, top: 0, right: 1200, bottom: 700 });
      expect(where(api, 'output')!.location).toBe('floating');
      expect(memory.homes.output).toMatchObject({ ref: 'problems', direction: 'within' });

      dockBack(api, memory, api.getPanel('output')!.group);

      expect(where(api, 'output')).toEqual(where(api, 'problems'));
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
    const problems = api.getPanel('problems')!;

    expect(autoHide(api, memory, problems, NO_RECT)).toEqual(['problems', 'output']);
    expect(problems.group.api.isVisible).toBe(false);
    expect(api.getPanel('output')!.group).toBe(problems.group);

    expect(pinBack(api, memory, 'output')).toEqual(['problems', 'output']);
    expect(problems.group.api.isVisible).toBe(true);
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
    expect(api.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'inspector', 'output', 'problems', 'toolbox']);
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
    expect(saved.hidden).toEqual(['problems', 'output']);

    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'b', 'billing');
    const docA = api.getPanel('doc:a'), docB = api.getPanel('doc:b');

    expect(applyLayout(api, memory, saved)).toEqual(['problems', 'output']);

    expect(where(api, 'toolbox')!.location).toBe('floating');
    expect(api.getPanel('output')!.group.api.isVisible).toBe(false);
    expect(api.getPanel('doc:a')).toBe(docA);
    expect(api.getPanel('doc:b')).toBe(docB);
    expect(where(api, 'doc:a')!.group).toBe(saved.documentGroupId);
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
  it('never puts a pane into a hidden group: Output docks to a visible group of its own', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, width: 100, height: 100 } as DOMRect);
    try {
      const { api, memory } = dock();
      resetLayout(api, memory, 1200);
      const problems = api.getPanel('problems')!;
      floatPanel(api, memory, api.getPanel('output')!, { left: 0, top: 0, right: 1200, bottom: 700 });
      expect(autoHide(api, memory, problems, NO_RECT)).toEqual(['problems']);

      dockBack(api, memory, api.getPanel('output')!.group);

      const landed = api.getPanel('output')!.group;
      expect(landed.api.location.type).toBe('grid');
      expect(landed.api.isVisible).toBe(true);
      expect(landed).not.toBe(problems.group);
      expect(problems.group.api.isVisible).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('shows a closed tool pane in a visible group, not beside a hidden mate', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    api.removePanel(api.getPanel('output')!);
    autoHide(api, memory, api.getPanel('problems')!, NO_RECT);

    const panel = showTool(api, memory, 'output');

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

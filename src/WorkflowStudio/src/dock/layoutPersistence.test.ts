import { Orientation, type SerializedDockview } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';
import { LAYOUT_KEY, parseLayout, readLayout, sessionDock, stripDocuments, withDocuments, writeLayout, type SavedLayout } from './layoutPersistence';
import { memoryStorage } from '../test/memoryStorage';

const panel = (id: string, contentComponent = 'tool') => ({ id, contentComponent, title: id });

/** A layout as toJSON() writes it: two documents and the Inspector in g1, the Toolbox in g2, a floating
 *  document, a floating Problems pane and a popped-out Output pane. */
function layout(): SerializedDockview {
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { id: 'g1', views: ['doc:a', 'doc:b', 'inspector'], activeView: 'doc:b' }, size: 600 },
          { type: 'leaf', data: { id: 'g2', views: ['toolbox'], activeView: 'toolbox' }, size: 300 },
        ],
        size: 600,
      },
      width: 900, height: 600, orientation: Orientation.HORIZONTAL,
    },
    panels: {
      'doc:a': panel('doc:a', 'document'), 'doc:b': panel('doc:b', 'document'), 'doc:c': panel('doc:c', 'document'),
      inspector: panel('inspector'), toolbox: panel('toolbox'), problems: panel('problems'), output: panel('output'),
    },
    floatingGroups: [
      { data: { id: 'g3', views: ['doc:c'], activeView: 'doc:c' }, position: { left: 10, top: 10, width: 300, height: 200 } },
      { data: { id: 'g4', views: ['problems'], activeView: 'problems' }, position: { left: 40, top: 40, width: 300, height: 200 } },
    ],
    popoutGroups: [{ data: { id: 'g5', views: ['output'], activeView: 'output' }, position: null }],
  };
}


const saved = (over: Partial<SavedLayout> = {}): SavedLayout => ({
  version: 1, dock: stripDocuments(layout()).dock, documentGroupId: 'g1', hidden: ['output'], sides: { inspector: 'right' },
  homes: { output: { ref: 'problems', direction: 'below', size: 180, layout: [{ ref: 'problems', left: 0, top: 450, width: 700, height: 180 }] } }, popped: [], ...over,
});

describe('stripDocuments', () => {
  it('takes every document out and keeps the group they sat in as the document area', () => {
    const { dock, documentGroupId } = stripDocuments(layout());

    expect(documentGroupId).toBe('g1');
    // the popped-out Output's entry goes with its window (it is returned in `popped`)
    expect(Object.keys(dock.panels).sort()).toEqual(['inspector', 'problems', 'toolbox']);
    const g1 = (dock.grid.root.data as { data: { views: string[]; activeView?: string } }[])[0]!.data;
    expect(g1).toEqual({ id: 'g1', views: ['inspector'], activeView: 'inspector' });
  });

  it('drops a floating window left empty and every pop-out window, and keeps a floating tool pane', () => {
    const { dock, popped } = stripDocuments(layout());
    expect(dock.floatingGroups?.map((f) => f.data?.id)).toEqual(['g4']);
    expect(dock.popoutGroups).toEqual([]);
    expect(popped).toEqual([['output']]);
  });

  it('does not touch its input', () => {
    const input = layout();
    stripDocuments(input);
    expect(input).toEqual(layout());
  });

  it('has no document area when no grid group holds a document', () => {
    const input = layout();
    (input.grid.root.data as { data: { views: string[] } }[])[0]!.data.views = ['inspector'];
    expect(stripDocuments(input).documentGroupId).toBeNull();
  });
});

describe('sessionDock', () => {
  it('keeps the documents where they are, drops pop-out windows and returns the panes they held', () => {
    const input = layout();
    input.popoutGroups = [{ data: { id: 'g5', views: ['output', 'doc:c'], activeView: 'output' }, position: null }];
    input.floatingGroups = [];
    const { dock, documentGroupId, popped } = sessionDock(input);
    expect(Object.keys(dock.panels)).toEqual(expect.arrayContaining(['doc:a', 'doc:b']));
    expect(dock.panels['doc:c']).toBeUndefined();          // a popped-out document comes back in the document area
    expect(dock.panels['output']).toBeUndefined();
    expect(dock.popoutGroups).toEqual([]);
    expect(popped).toEqual([['output']]);
    expect(documentGroupId).toBe('g1');
  });

  it('keeps a floating document and does not touch its input', () => {
    const input = layout();
    const { dock } = sessionDock(input);
    expect(dock.floatingGroups?.map((f) => f.data?.id)).toEqual(['g3', 'g4']);
    expect(dock.panels['doc:c']).toBeDefined();
    expect(input).toEqual(layout());
  });
});

describe('stripDocuments with documents split across groups', () => {
  const split = (): SerializedDockview => {
    const l = layout();
    l.grid.root = {
      type: 'branch', size: 600,
      data: [
        { type: 'leaf', data: { id: 'g1', views: ['doc:a', 'inspector'], activeView: 'doc:a' }, size: 300 },
        { type: 'branch', size: 300, data: [
          { type: 'leaf', data: { id: 'g6', views: ['doc:b'], activeView: 'doc:b' }, size: 300 },
        ] },
        { type: 'leaf', data: { id: 'g2', views: ['toolbox'], activeView: 'toolbox' }, size: 300 },
      ],
    };
    return l;
  };
  const ids = (node: { type: string; data: unknown }): string[] =>
    node.type === 'leaf' ? [(node.data as { id: string }).id] : (node.data as { type: string; data: unknown }[]).flatMap(ids);

  it('removes the other document-only groups, keeping the first as the document area', () => {
    const { dock, documentGroupId } = stripDocuments(split());
    expect(documentGroupId).toBe('g1');
    expect(ids(dock.grid.root)).toEqual(['g1', 'g2']);
    expect((dock.grid.root.data as { type: string }[]).every((n) => n.type === 'leaf')).toBe(true);
  });

  it('collapses a branch left with one child into its parent', () => {
    const l = split();
    const root = l.grid.root.data as { type: string; data: unknown; size: number }[];
    root[1] = { type: 'branch', size: 300, data: [
      { type: 'leaf', data: { id: 'g6', views: ['doc:b'], activeView: 'doc:b' }, size: 150 },
      { type: 'leaf', data: { id: 'g8', views: ['problems'], activeView: 'problems' }, size: 150 },
    ] };
    const { dock } = stripDocuments(l);
    expect(ids(dock.grid.root)).toEqual(['g1', 'g8', 'g2']);
    expect((dock.grid.root.data as { type: string; size?: number }[])[1]).toMatchObject({ type: 'leaf', size: 300 });
  });
});

describe('withDocuments', () => {
  const docs = [panel('doc:x', 'document'), panel('doc:y', 'document')];

  it('puts the open documents back as tabs of the document area, the active one shown', () => {
    const dock = withDocuments(stripDocuments(layout()).dock, 'g1', docs, 'doc:y');
    const g1 = (dock.grid.root.data as { data: { views: string[]; activeView?: string } }[])[0]!.data;
    expect(g1.views).toEqual(['inspector', 'doc:x', 'doc:y']);
    expect(g1.activeView).toBe('doc:y');
    expect(dock.panels['doc:x']).toEqual(docs[0]);
  });

  it('uses the first group of the main grid when the document area is gone', () => {
    const dock = withDocuments(stripDocuments(layout()).dock, 'g9', docs, null);
    expect((dock.grid.root.data as { data: { views: string[] } }[])[0]!.data.views).toContain('doc:x');
  });
});

describe('parseLayout', () => {
  it('reads a value as readLayout reads the same text, valid or not', () => {
    const valid = JSON.stringify(saved());
    const invalid = JSON.stringify({ ...saved(), version: 2 });
    for (const text of [valid, invalid]) {
      expect(parseLayout(JSON.parse(text))).toEqual(readLayout(memoryStorage({ [LAYOUT_KEY]: text })));
    }
    expect(parseLayout(JSON.parse(valid))).not.toBeNull();
    expect(parseLayout(JSON.parse(invalid))).toBeNull();
    expect(parseLayout(undefined)).toBeNull();
  });
});

describe('readLayout and writeLayout (review focus 1: old, corrupt or unreadable layouts)', () => {
  it('round-trips a layout', () => {
    const storage = memoryStorage();
    expect(writeLayout(storage, saved())).toBe(true);
    expect(readLayout(storage)).toEqual(saved());
  });

  it.each([
    ['nothing saved', {}],
    ['text that is not JSON', { [LAYOUT_KEY]: '{"version":1,' }],
    ['JSON that is not an object', { [LAYOUT_KEY]: '[1,2]' }],
    ['an older version', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), version: 0 }) }],
    ['a newer version', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), version: 2 }) }],
    ['a dock part that is not a dockview layout', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), dock: { grid: { root: { type: 'leaf' } }, panels: {} } }) }],
    ['a dock part missing its panels', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), dock: { grid: { root: { type: 'branch', data: [] } } } }) }],
  ])('gives null for %s', (_name, initial) => {
    expect(readLayout(memoryStorage(initial))).toBeNull();
  });

  it.each([
    ['a leaf with no id', { type: 'leaf', data: { views: ['inspector'] } }],
    ['a leaf whose views are not an array', { type: 'leaf', data: { id: 'g1', views: 'inspector' } }],
    ['a leaf whose view has no panel', { type: 'leaf', data: { id: 'g1', views: ['ghost'] } }],
    ['a leaf with no data', { type: 'leaf' }],
    ['an unknown node type', { type: 'tree', data: [] }],
    ['a nested branch whose data is not an array', { type: 'branch', data: 'x' }],
  ])('gives null when the grid holds %s', (_name, node) => {
    const good = saved();
    const dock = { ...good.dock, grid: { ...good.dock.grid, root: { type: 'branch', data: [node] } } };
    expect(readLayout(memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ ...good, dock }) }))).toBeNull();
  });

  it('gives null when a floating group is malformed', () => {
    const good = saved();
    const dock = { ...good.dock, floatingGroups: [{ data: { id: 'f', views: 5 }, position: { left: 0, top: 0, width: 1, height: 1 } }] };
    expect(readLayout(memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ ...good, dock }) }))).toBeNull();
  });

  it('drops unknown tool ids, bad sides and malformed homes, and keeps the rest', () => {
    const storage = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({
        ...saved(),
        hidden: ['output', 'terminal', 7, 'output'],
        sides: { inspector: 'left', toolbox: 'middle', ghost: 'right' },
        homes: { problems: { ref: 'output', direction: 'sideways', size: 100 }, toolbox: { ref: 'inspector', direction: 'right', size: -5 }, output: { ref: 'problems', direction: 'below', size: 180, layout: [{ ref: 'problems', left: 0, top: 450, width: 700, height: 180 }] } },
        documentGroupId: 42,
      }),
    });

    const read = readLayout(storage)!;

    expect(read.hidden).toEqual(['output']);
    expect(read.sides).toEqual({ inspector: 'left' });
    expect(read.homes).toEqual({ output: { ref: 'problems', direction: 'below', size: 180, layout: [{ ref: 'problems', left: 0, top: 450, width: 700, height: 180 }] } });
    expect(read.documentGroupId).toBeNull();
  });

  it('keeps the popped-out panes (dropping unknown ids) and a home as a tab of a group, which has no size', () => {
    const within = { ref: 'problems', direction: 'within', size: 0, layout: [] };
    const storage = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({ ...saved(), popped: ['problems', 'terminal', 'output'], homes: { output: within, toolbox: { ref: 'inspector', direction: 'right', size: 0, layout: [] } } }),
    });

    const read = readLayout(storage)!;

    expect(read.popped).toEqual(['problems', 'output']);
    expect(read.homes).toEqual({ output: within });
  });

  it('reads a layout saved before pop-outs were kept as having none', () => {
    const { popped: _, ...older } = saved();
    expect(readLayout(memoryStorage({ [LAYOUT_KEY]: JSON.stringify(older) }))!.popped).toEqual([]);
  });

  it('never throws when the storage itself throws', () => {
    const hostile = { getItem: vi.fn(() => { throw new Error('SecurityError'); }), setItem: vi.fn(() => { throw new Error('QuotaExceededError'); }) } as unknown as Storage;
    expect(readLayout(hostile)).toBeNull();
    expect(writeLayout(hostile, saved())).toBe(false);
    expect(readLayout(null)).toBeNull();
    expect(writeLayout(null, saved())).toBe(false);
  });
});

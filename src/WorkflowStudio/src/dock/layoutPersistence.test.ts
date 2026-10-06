import { Orientation, type SerializedDockview } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';
import { LAYOUT_KEY, readLayout, stripDocuments, withDocuments, writeLayout, type SavedLayout } from './layoutPersistence';
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
  homes: { output: { ref: 'problems', direction: 'below', size: 180, layout: [{ ref: 'problems', left: 0, top: 450, width: 700, height: 180 }] } }, ...over,
});

describe('stripDocuments', () => {
  it('takes every document out and keeps the group they sat in as the document area', () => {
    const { dock, documentGroupId } = stripDocuments(layout());

    expect(documentGroupId).toBe('g1');
    expect(Object.keys(dock.panels).sort()).toEqual(['inspector', 'output', 'problems', 'toolbox']);
    const g1 = (dock.grid.root.data as { data: { views: string[]; activeView?: string } }[])[0]!.data;
    expect(g1).toEqual({ id: 'g1', views: ['inspector'], activeView: 'inspector' });
  });

  it('drops a floating window left empty and every pop-out window, and keeps a floating tool pane', () => {
    const { dock } = stripDocuments(layout());
    expect(dock.floatingGroups?.map((f) => f.data?.id)).toEqual(['g4']);
    expect(dock.popoutGroups).toEqual([]);
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

  it('never throws when the storage itself throws', () => {
    const hostile = { getItem: vi.fn(() => { throw new Error('SecurityError'); }), setItem: vi.fn(() => { throw new Error('QuotaExceededError'); }) } as unknown as Storage;
    expect(readLayout(hostile)).toBeNull();
    expect(writeLayout(hostile, saved())).toBe(false);
    expect(readLayout(null)).toBeNull();
    expect(writeLayout(null, saved())).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { canDrop } from './dropRules';
import { findHome, sideOf, spansEdge, toPosition } from './home';
import { docPanelId, documentIdOf, isDocPanelId, isToolId } from './ids';
import { keyCommand } from './keys';

describe('ids', () => {
  it('tells documents and tool panes apart', () => {
    expect(docPanelId('wf1')).toBe('doc:wf1');
    expect(isDocPanelId('doc:wf1')).toBe(true);
    expect(isDocPanelId('inspector')).toBe(false);
    expect(documentIdOf('doc:wf1')).toBe('wf1');
    expect(documentIdOf('problems')).toBeNull();
    expect(isToolId('output')).toBe(true);
    expect(isToolId('doc:output')).toBe(false);
  });
});

describe('canDrop (spec §6.2.4)', () => {
  it('lets a tool pane go anywhere, the layout edge included', () => {
    expect(canDrop(['inspector'], 'edge', null)).toBe(true);
    expect(canDrop(['problems'], 'content', ['doc:a'])).toBe(true);
    expect(canDrop(['problems'], 'tab', ['toolbox'])).toBe(true);
  });

  it('lets a document go only into or beside a group that holds a document', () => {
    expect(canDrop(['doc:a'], 'content', ['doc:b'])).toBe(true);
    expect(canDrop(['doc:a'], 'tab', ['inspector', 'doc:b'])).toBe(true);
    expect(canDrop(['doc:a'], 'content', ['inspector'])).toBe(false);
    expect(canDrop(['doc:a'], 'header_space', ['toolbox'])).toBe(false);
    expect(canDrop(['doc:a'], 'edge', null)).toBe(false);
    expect(canDrop(['doc:a'], 'content', null)).toBe(false);
  });

  it('lets a document go into the empty document area', () => {
    expect(canDrop(['doc:a'], 'content', [], true)).toBe(true);
    expect(canDrop(['doc:a'], 'content', [], false)).toBe(false);
  });

  it('treats a dragged group holding any document as a document', () => {
    expect(canDrop(['inspector', 'doc:a'], 'content', ['toolbox'])).toBe(false);
  });
});

describe('sideOf and findHome (spec §6.2.3)', () => {
  const dock = { left: 0, top: 0, right: 1000, bottom: 600 };

  it('names the dock edge a group is nearest to', () => {
    expect(sideOf({ left: 700, top: 0, right: 1000, bottom: 600 }, dock)).toBe('right');
    expect(sideOf({ left: 0, top: 0, right: 200, bottom: 600 }, dock)).toBe('left');
    expect(sideOf({ left: 0, top: 450, right: 700, bottom: 600 }, dock)).toBe('bottom');
    expect(sideOf({ left: 700, top: 0, right: 900, bottom: 600 }, dock)).toBe('right');
    expect(sideOf({ left: 0, top: 0, right: 700, bottom: 100 }, dock)).toBe('top');
  });

  it('remembers the neighbour sharing the longest edge, the side and the size', () => {
    const inspector = { left: 700, top: 0, right: 1000, bottom: 450 };
    const neighbours = [
      { ref: 'doc:a', rect: { left: 0, top: 0, right: 700, bottom: 450 } },
      { ref: 'problems', rect: { left: 0, top: 450, right: 1000, bottom: 600 } },
    ];
    expect(findHome(inspector, neighbours)).toEqual({ ref: 'doc:a', direction: 'right', size: 300 });
  });

  it('remembers a pane below its neighbour by height', () => {
    const problems = { left: 0, top: 450, right: 700, bottom: 600 };
    expect(findHome(problems, [{ ref: 'doc:a', rect: { left: 0, top: 0, right: 700, bottom: 450 } }]))
      .toEqual({ ref: 'doc:a', direction: 'below', size: 150 });
  });

  it('has no home when it touches nothing', () => {
    expect(findHome({ left: 0, top: 0, right: 10, bottom: 10 }, [{ ref: 'x', rect: { left: 500, top: 500, right: 600, bottom: 600 } }])).toBeNull();
  });

  it('turns a direction into a moveTo position', () => {
    expect([toPosition('left'), toPosition('right'), toPosition('above'), toPosition('below'), toPosition('within')])
      .toEqual(['left', 'right', 'top', 'bottom', 'center']);
  });
});

describe('keyCommand (spec §6.2.6)', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    keyCommand({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('maps the studio keys and nothing else', () => {
    expect(key('e', { ctrlKey: true })).toBe('switcher');
    expect(key('E', { ctrlKey: true, shiftKey: true })).toBe('switcherBack');
    expect(key('w', { altKey: true })).toBe('closeDocument');
    expect(key('o', { ctrlKey: true })).toBe('open');
    expect(key('Escape')).toBe('escape');
    expect(key('F5')).toBe('start');
    expect(key('F5', { shiftKey: true })).toBe('stop');
    expect(key('w', { ctrlKey: true })).toBeNull();
    expect(key('Tab', { ctrlKey: true })).toBeNull();
    expect(key('e')).toBeNull();
  });
});

describe('spansEdge (2026-10-11: a column of the dock\'s whole height docks back at the layout\'s edge)', () => {
  const dock = { left: 0, top: 34, right: 1600, bottom: 900 };
  it('a full-height column on the left or right, a full-width row at the bottom', () => {
    expect(spansEdge({ left: 0, top: 34, right: 290, bottom: 900 }, dock, 'left')).toBe(true);
    expect(spansEdge({ left: 1260, top: 34, right: 1600, bottom: 900 }, dock, 'right')).toBe(true);
    expect(spansEdge({ left: 0, top: 750, right: 1600, bottom: 900 }, dock, 'bottom')).toBe(true);
  });
  it('not one that shares its side with another group (shorter than the edge), nor one off the edge', () => {
    expect(spansEdge({ left: 0, top: 34, right: 290, bottom: 750 }, dock, 'left')).toBe(false);
    expect(spansEdge({ left: 290, top: 750, right: 1260, bottom: 900 }, dock, 'bottom')).toBe(false);
    expect(spansEdge({ left: 300, top: 34, right: 590, bottom: 900 }, dock, 'left')).toBe(false);
  });
});

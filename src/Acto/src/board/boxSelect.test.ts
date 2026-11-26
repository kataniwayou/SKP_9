import { describe, expect, it } from 'vitest';
import { boxPicks, rectOf, withBox, type Placed } from './boxSelect';

const at = (x: number, y: number, w = 100, h = 50) => ({ x, y, w, h });
const placed: Placed[] = [
  { pick: { kind: 'step', id: 'right' }, box: at(400, 0) },
  { pick: { kind: 'workflow', id: 'tri' }, box: at(0, 100, 60, 60) },
  { pick: { kind: 'step', id: 'low' }, box: at(200, 300) },
  { pick: { kind: 'step', id: 'high' }, box: at(200, 0) },
  { pick: { kind: 'cache', id: 'c' }, box: at(0, 400, 150, 56) },
  { pick: { kind: 'ghost', key: 'step:gone' }, box: at(250, 150) },
  { pick: null, box: at(300, 150) },
];
const ids = (ps: ReturnType<typeof boxPicks>) => ps.map((p) => ('id' in p ? p.id : p.kind));

describe('rectOf', () => {
  it('is the same box whichever corner the drag started from', () => {
    expect(rectOf({ x: 10, y: 20 }, { x: 0, y: 5 })).toEqual({ x: 0, y: 5, w: 10, h: 15 });
    expect(rectOf({ x: 0, y: 5 }, { x: 10, y: 20 })).toEqual({ x: 0, y: 5, w: 10, h: 15 });
  });
});

describe('boxPicks', () => {
  it('takes every triangle, step and cache the box touches, fully or partly, left to right then top to bottom', () => {
    expect(ids(boxPicks(placed, at(-10, -10, 1000, 1000)))).toEqual(['tri', 'c', 'high', 'low', 'ghost', 'right']);
  });
  it('a mixed box picks real items and ghosts together', () => {
    expect(boxPicks(placed, at(190, 0, 130, 200))).toEqual([{ kind: 'step', id: 'high' }, { kind: 'ghost', key: 'step:gone' }]);
  });
  it('a box over only a corner of an item takes it', () => {
    expect(ids(boxPicks(placed, at(290, 40, 20, 20)))).toEqual(['high']);
  });
  it('takes a ghost node like a real one, never a non-component; an empty box takes nothing', () => {
    expect(boxPicks(placed, at(240, 140, 120, 40))).toEqual([{ kind: 'ghost', key: 'step:gone' }]);
    expect(boxPicks(placed, at(310, 160, 5, 5))).toEqual([{ kind: 'ghost', key: 'step:gone' }]);
    expect(boxPicks(placed, at(500, 160, 5, 5))).toEqual([]);
    expect(boxPicks(placed, at(2000, 2000, 10, 10))).toEqual([]);
  });
});

describe('withBox', () => {
  const cur = [{ kind: 'step', id: 'a' } as const, { kind: 'wire', from: 'a', to: 'b' } as const];
  it('replaces the picks without Ctrl (an empty box clears them)', () => {
    expect(withBox(cur, [{ kind: 'cache', id: 'c' }], false)).toEqual([{ kind: 'cache', id: 'c' }]);
    expect(withBox(cur, [], false)).toEqual([]);
  });
  it('with Ctrl adds the new ones after the current ones, each once', () => {
    expect(withBox(cur, [{ kind: 'step', id: 'a' }, { kind: 'cache', id: 'c' }], true))
      .toEqual([...cur, { kind: 'cache', id: 'c' }]);
    expect(withBox(cur, [], true)).toEqual(cur);
  });

  it('a box over a schema card and a processor card picks both', () => {
    const cards: Placed[] = [
      { pick: { kind: 'schema', id: 's' }, box: at(0, 0, 150, 40) },
      { pick: { kind: 'processor', id: 'p' }, box: at(200, 0, 150, 60) },
      { pick: { kind: 'schema', id: 'far' }, box: at(2000, 0, 150, 40) },
    ];
    expect(boxPicks(cards, at(-5, -5, 400, 100))).toEqual([{ kind: 'schema', id: 's' }, { kind: 'processor', id: 'p' }]);
  });
});

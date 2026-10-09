import { describe, expect, it } from 'vitest';
import type { Circuit, End } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { LineIndex, mayShare, overlapShorts, overlapsOf, sharesNet } from './overlaps';
import type { Pt } from './router';

const line = (id: string, ...points: Pt[]) => ({ id, points });

describe('overlapsOf (the user\'s rule 2, 2026-10-09)', () => {
  it('two wires sharing a stretch of a horizontal line overlap there', () => {
    const o = overlapsOf([line('a', [0, 40], [200, 40]), line('b', [120, 40], [320, 40], [320, 80])]);
    expect(o).toEqual([{ a: 'a', b: 'b', stretches: [[[120, 40], [200, 40]]] }]);
  });

  it('and on a vertical line, whichever way each is drawn', () => {
    const o = overlapsOf([line('a', [0, 0], [64, 0], [64, 200], [128, 200]), line('b', [0, 160], [64, 160], [64, 40], [0, 40])]);
    expect(o).toEqual([{ a: 'a', b: 'b', stretches: [[[64, 40], [64, 160]]] }]);
  });

  it('crossing at a point, meeting end to end, or running side by side is no overlap', () => {
    expect(overlapsOf([line('a', [0, 40], [200, 40]), line('b', [100, 0], [100, 120])])).toEqual([]);
    expect(overlapsOf([line('a', [0, 40], [100, 40]), line('b', [100, 40], [200, 40])])).toEqual([]);
    expect(overlapsOf([line('a', [0, 40], [200, 40]), line('b', [0, 48], [200, 48])])).toEqual([]);
    // a T: one ends on the other's line
    expect(overlapsOf([line('a', [0, 40], [200, 40]), line('b', [100, 40], [100, 120])])).toEqual([]);
  });

  it('a wire never overlaps itself; several stretches of one pair are one overlap', () => {
    expect(overlapsOf([line('a', [0, 0], [100, 0], [100, 50], [40, 50], [40, 0])])).toEqual([]);
    const o = overlapsOf([line('a', [0, 0], [100, 0], [100, 80], [300, 80]), line('b', [40, 0], [140, 0], [140, 80], [260, 80])]);
    expect(o).toHaveLength(1);
    expect(o[0]!.stretches).toEqual([[[40, 0], [100, 0]], [[140, 80], [260, 80]]]);
  });

  it('three wires on one line: every pair', () => {
    const o = overlapsOf([line('a', [0, 8], [96, 8]), line('b', [32, 8], [128, 8]), line('c', [64, 8], [80, 8])]);
    expect(o.map((x) => `${x.a}+${x.b}`).sort()).toEqual(['a+b', 'a+c', 'b+c']);
  });
});

describe('LineIndex', () => {
  it('finds the stretches a path shares with the lines indexed, those it is told to leave out apart', () => {
    const ix = new LineIndex();
    ix.add('a', [[0, 40], [200, 40]]);
    ix.add('b', [[64, 0], [64, 400]]);
    const hits = ix.stretches([[100, 40], [300, 40], [300, 100]], () => true);
    expect([...hits]).toEqual([['a', [[[100, 40], [200, 40]]]]]);
    expect(ix.stretches([[100, 40], [300, 40]], (id) => id !== 'a').size).toBe(0);
    expect(ix.stretches([[64, 100], [64, 120]], () => true).get('b')).toEqual([[[64, 100], [64, 120]]]);
  });
});

describe('overlapShorts: which overlaps are short circuits', () => {
  const at = (step: string): End => ({ on: 'step', step, y: null });
  const open: End = { on: 'open', x: 0, y: 0 };
  const cond = (id: string) => (id === 's9' ? 2 : 1);

  it('two directed wires of one net (fan-out from a trunk) may share a line; wires of two nets may not', () => {
    // t: the trunk; a taps it (one net); z: another net
    // all shaped by hand (two automatic wires never make a short circuit: the coordinator's ruling)
    const shaped = { xs: [0], ys: [] };
    const c: Circuit = {
      t: { tail: at('s1'), head: at('s2'), bends: shaped },
      a: { tail: { on: 'wire', host: 't', at: 40 }, head: at('s3'), bends: shaped },
      z: { tail: at('s5'), head: at('s6'), bends: shaped },
    };
    const lines = [line('t', [0, 0], [200, 0]), line('a', [40, 0], [120, 0], [120, 80]), line('z', [100, 0], [300, 0])];
    const shorts = overlapShorts(lines, c, netsOf(c, cond));
    expect(shorts.map((o) => `${o.a}+${o.b}`)).toEqual(['t+z', 'a+z']);
  });

  it('a direction-less wire shares a line with nothing, not even a wire joined on it or another direction-less wire', () => {
    const c: Circuit = {
      f: { tail: open, head: open },
      g: { tail: open, head: open },
      x: { tail: { on: 'wire', host: 'f', at: 8 }, head: at('s2') },
    };
    const lines = [line('f', [0, 0], [100, 0]), line('g', [50, 0], [150, 0]), line('x', [8, 0], [60, 0], [60, 40])];
    expect(overlapShorts(lines, c, netsOf(c, cond)).map((o) => `${o.a}+${o.b}`)).toEqual(['f+g', 'f+x', 'g+x']);
  });

  it('sharesNet: one net and both directed', () => {
    const c: Circuit = { t: { tail: at('s1'), head: at('s2') }, a: { tail: { on: 'wire', host: 't', at: 40 }, head: at('s3') }, f: { tail: open, head: open } };
    const share = sharesNet(c, netsOf(c, cond));
    expect([share('t', 'a'), share('a', 't'), share('t', 't'), share('t', 'f'), share('t', 'gone')]).toEqual([true, true, false, false, false]);
  });
});

describe('LineIndex.count', () => {
  it('counts the stretches as `stretches` finds them', () => {
    const ix = new LineIndex();
    ix.add('a', [[0, 0], [100, 0], [100, 80], [300, 80]]);
    ix.add('b', [[64, 0], [64, 400]]);
    const path: Pt[] = [[40, 0], [140, 0], [140, 80], [260, 80]];
    const all = [...ix.stretches(path, () => true).values()].reduce((n, s) => n + s.length, 0);
    expect(ix.count(path, () => true)).toBe(all);
    expect(all).toBe(2);
    expect(ix.count(path, (id) => id !== 'a')).toBe(0);
    expect(ix.count([[64, 0], [64, 0]], () => true)).toBe(0);
  });
});

describe('sharesNet: siblings out of one step or the hub (the user\'s ruling, 2026-10-09)', () => {
  const at = (step: string): End => ({ on: 'step', step, y: null });
  const hub: End = { on: 'hub', angle: null };
  const open: End = { on: 'open', x: 0, y: 0 };
  // s2, s3 Completed (1); s4 Failed (2)
  const cond = (id: string) => (id === 's4' ? 2 : id === 's2' || id === 's3' ? 1 : undefined);
  const share = (c: Circuit) => sharesNet(c, netsOf(c, cond));

  it('two wires out of the same step\'s output with the same family may share a line (a bus); different families may not', () => {
    const c: Circuit = { a: { tail: at('s1'), head: at('s2') }, b: { tail: at('s1'), head: at('s3') }, d: { tail: at('s1'), head: at('s4') } };
    expect(share(c)('a', 'b')).toBe(true);
    expect(share(c)('a', 'd')).toBe(false);
    expect(share(c)('b', 'd')).toBe(false);
  });

  it('two wires out of the hub with the same family may share a line; out of different steps they may not', () => {
    const c: Circuit = { a: { tail: hub, head: at('s2') }, b: { tail: hub, head: at('s3') }, x: { tail: at('s5'), head: at('s3') }, y: { tail: at('s6'), head: at('s2') } };
    expect(share(c)('a', 'b')).toBe(true);
    expect(share(c)('x', 'y')).toBe(false);
    expect(share(c)('a', 'x')).toBe(false);
  });

  it('siblings of no family yet (grey) share their colour; a direction-less wire or a short-circuited net never does', () => {
    const c: Circuit = { a: { tail: at('s1'), head: open }, b: { tail: at('s1'), head: open }, f: { tail: open, head: open } };
    expect(share(c)('a', 'b')).toBe(true);
    expect(share(c)('a', 'f')).toBe(false);
    // b's net short-circuited (a tap on it into a Failed step while it goes into a Completed one)
    const shorted: Circuit = { a: { tail: at('s1'), head: at('s2') }, b: { tail: at('s1'), head: at('s3') }, t: { tail: { on: 'wire', host: 'b', at: 8 }, head: at('s4') } };
    expect(share(shorted)('a', 'b')).toBe(false);
  });
});

describe('mayShare: two fully automatic wires never make a short circuit (the coordinator\'s ruling, 2026-10-09)', () => {
  const at = (step: string, y: number | null = null): End => ({ on: 'step', step, y });
  const cond = (id: string) => (id === 's4' ? 2 : 1);
  const lines = [line('a', [0, 0], [200, 0]), line('b', [100, 0], [300, 0])];
  const shortsOf = (c: Circuit) => overlapShorts(lines, c, netsOf(c, cond)).map((o) => `${o.a}+${o.b}`);

  it('both automatic, of different nets and colours: the router laid them there, no short circuit', () => {
    const c: Circuit = { a: { tail: at('s1'), head: at('s2') }, b: { tail: at('s3'), head: at('s4') } };
    expect(mayShare(c, netsOf(c, cond))('a', 'b')).toBe(true);
    expect(shortsOf(c)).toEqual([]);
  });

  it('one of them shaped by hand, slid along a side, held, on a hub angle, open or joined: a short circuit', () => {
    const b: Circuit[string] = { tail: at('s3'), head: at('s4') };
    for (const a of [
      { tail: at('s1'), head: at('s2'), bends: { xs: [40], ys: [] } },
      { tail: at('s1', 48), head: at('s2') },
      { tail: at('s1'), head: at('s2', 64) },
      { tail: at('s1'), head: at('s2'), held: 'tail' as const },
      { tail: { on: 'hub', angle: 270 }, head: at('s2') },
      { tail: { on: 'hub', angle: null, dy: 8 }, head: at('s2') },
      { tail: at('s1'), head: { on: 'open', x: 0, y: 0 } },
      { tail: { on: 'wire', host: 'zz', at: 8 }, head: at('s2') },
    ] as Circuit[string][]) {
      expect(shortsOf({ a, b }), JSON.stringify(a)).toEqual(['a+b']);
    }
  });
});

describe('overlap matching tolerates float noise, no more (review 2026-10-09)', () => {
  it('a run at 551.9999999 is on the line at 552; one half a pixel off is not; nor is a crossing', () => {
    const o = overlapsOf([line('a', [552, 0], [552, 200]), line('b', [551.9999999, 40], [551.9999999, 120])]);
    expect(o.map((x) => [x.a, x.b])).toEqual([['a', 'b']]);
    expect(overlapsOf([line('a', [552, 0], [552, 200]), line('b', [552.5, 40], [552.5, 120])])).toEqual([]);
    expect(overlapsOf([line('a', [0, 100.00000001], [200, 100]), line('b', [50, 100], [150, 100])]).length).toBe(1);
    const ix = new LineIndex();
    ix.add('a', [[0, 7.9999999], [100, 7.9999999]]);
    expect(ix.count([[20, 8], [60, 8]], () => true)).toBe(1);
  });
});

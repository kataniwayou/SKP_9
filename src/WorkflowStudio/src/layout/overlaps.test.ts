import { describe, expect, it } from 'vitest';
import type { Circuit, End } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { LineIndex, mayShare, overlapShorts, overlapsOf } from './overlaps';
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
    const c: Circuit = {
      t: { tail: at('s1'), head: at('s2') },
      a: { tail: { on: 'wire', host: 't', at: 40 }, head: at('s3') },
      z: { tail: at('s5'), head: at('s6') },
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

  it('mayShare: one net and both directed', () => {
    const c: Circuit = { t: { tail: at('s1'), head: at('s2') }, a: { tail: { on: 'wire', host: 't', at: 40 }, head: at('s3') }, f: { tail: open, head: open } };
    const share = mayShare(c, netsOf(c, cond));
    expect([share('t', 'a'), share('a', 't'), share('t', 't'), share('t', 'f'), share('t', 'gone')]).toEqual([true, true, false, false, false]);
  });
});

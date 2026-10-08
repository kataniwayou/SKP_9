import { describe, expect, it } from 'vitest';
import type { Step } from '../model/graph';
import {
  addCircuitWire, holdEnd, isFree, legacyCircuit, moveWire, openJoinedOn, parseCircuit, plainCircuit, removeCircuitWires, reverseWire, sameEnd, setBends, setEnd, shapedByHand, snapAngle,
  type Circuit, type CircuitWire, type Side,
} from './circuit';

const step = (next: string[] = []) => ({ nextStepIds: next }) as unknown as Step;
const plain = (s: string, t: string): CircuitWire => ({ tail: { on: 'step', step: s, y: null }, head: { on: 'step', step: t, y: null } });
const bends = { xs: [400], ys: [] };

describe('plainCircuit', () => {
  it('makes an automatic wire per entry step and per next step whose two ends are on the canvas', () => {
    const steps = new Map([['s1', step(['s2', 'gone'])], ['s2', step()], ['s3', step(['s1'])]]);
    const c = plainCircuit(['s1', 's1'], steps, (id) => id !== 's3');
    expect(Object.keys(c)).toEqual(['wf->s1', 's1->s2']);
    expect(c['wf->s1']).toEqual({ tail: { on: 'hub', angle: null }, head: { on: 'step', step: 's1', y: null } });
    expect(c['s1->s2']).toEqual(plain('s1', 's2'));
  });
});

describe('editing a circuit', () => {
  const c: Circuit = { w: { ...plain('s1', 's2'), bends } };

  it('keeps the bends while an end stays on what it was on, and drops them onto anything else', () => {
    expect(setEnd(c, 'w', 'head', { on: 'step', step: 's2', y: 72 }).w).toEqual({ tail: c.w!.tail, head: { on: 'step', step: 's2', y: 72 }, bends });
    expect(setEnd(c, 'w', 'head', { on: 'step', step: 's3', y: 72 }).w).toEqual({ tail: c.w!.tail, head: { on: 'step', step: 's3', y: 72 } });
    expect(setEnd(c, 'w', 'tail', { on: 'open', x: 8, y: 16 }).w!.bends).toBeUndefined();
    const open: Circuit = { o: { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 96, y: 0 }, bends } };
    expect(setEnd(open, 'o', 'head', { on: 'open', x: 96, y: 40 }).o).toEqual({ tail: open.o!.tail, head: { on: 'open', x: 96, y: 40 }, bends });
    expect(setEnd(c, 'gone', 'head', { on: 'open', x: 0, y: 0 })).toBe(c);
  });

  it('sets and clears a wire\'s bends, and adds a wire', () => {
    expect(setBends(c, 'w', null).w).toEqual(plain('s1', 's2'));
    expect(setBends(c, 'w', { xs: [], ys: [] }).w).toEqual(plain('s1', 's2'));
    expect(setBends(c, 'gone', null)).toBe(c);
    expect(Object.keys(addCircuitWire(c, 'w:1', plain('s2', 's3')))).toEqual(['w', 'w:1']);
  });

  it('a deleted host opens only the ends on it, where they were drawn, keeping their bends (Review Focus 4)', () => {
    const chain: Circuit = {
      h: plain('s1', 's2'),
      x: { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 'h', at: 40 }, bends },
      y: { tail: { on: 'wire', host: 'x', at: 24 }, head: { on: 'step', step: 's4', y: null } },
    };
    const drawn = (id: string, side: Side) => (id === 'x' && side === 'head' ? { x: 160, y: 80 } : null);
    const out = removeCircuitWires(chain, ['h'], drawn);
    expect(Object.keys(out)).toEqual(['x', 'y']);
    expect(out.x).toEqual({ tail: chain.x!.tail, head: { on: 'open', x: 160, y: 80 }, bends });
    expect(out.y).toBe(chain.y);
    expect(removeCircuitWires(chain, ['gone'], drawn)).toBe(chain);
  });

  it('a detached host (an end dropped open) opens the ends joined on it where they are drawn, keeping itself and their bends (spec §2.2-6)', () => {
    const chain: Circuit = {
      h: { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'step', step: 's2', y: null } },
      x: { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 'h', at: 40 }, bends },
      z: { tail: { on: 'wire', host: 'h', at: 64 }, head: { on: 'step', step: 's5', y: null } },
      y: { tail: { on: 'wire', host: 'x', at: 24 }, head: { on: 'step', step: 's4', y: null } },
    };
    const drawn = (id: string, side: Side) => (id === 'x' && side === 'head' ? { x: 160, y: 80 } : id === 'z' && side === 'tail' ? { x: 184, y: 80 } : null);
    const out = openJoinedOn(chain, ['h'], drawn);
    expect(Object.keys(out)).toEqual(['h', 'x', 'z', 'y']);
    expect(out.h).toBe(chain.h);
    expect(out.x).toEqual({ tail: chain.x!.tail, head: { on: 'open', x: 160, y: 80 }, bends });
    expect(out.z).toEqual({ tail: { on: 'open', x: 184, y: 80 }, head: chain.z!.head });
    expect(out.y).toBe(chain.y);
    expect(openJoinedOn(chain, ['y'], drawn)).toBe(chain);
    expect(openJoinedOn(chain, ['gone'], drawn)).toBe(chain);
  });

  it('a wire moved whole is open at both ends where its moved path starts and ends, its shape kept as its bends; its junction ends break and the ends joined on it open where they are drawn', () => {
    const chain: Circuit = {
      h: { tail: { on: 'wire', host: 'g', at: 32 }, head: { on: 'step', step: 's2', y: null } },
      g: plain('s0', 's9'),
      x: { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 'h', at: 40 }, bends },
      y: { tail: { on: 'wire', host: 'x', at: 24 }, head: { on: 'step', step: 's4', y: null } },
    };
    const drawn = (id: string, side: Side) => (id === 'x' && side === 'head' ? { x: 160, y: 80 } : null);
    const out = moveWire(chain, 'h', [[64, 96], [64, 136], [200, 136], [200, 216], [288, 216]], drawn);
    expect(out.h).toEqual({ tail: { on: 'open', x: 64, y: 96 }, head: { on: 'open', x: 288, y: 216 }, bends: { xs: [64, 200], ys: [136] } });
    expect(out.g).toBe(chain.g);
    expect(out.x).toEqual({ tail: chain.x!.tail, head: { on: 'open', x: 160, y: 80 }, bends });
    expect(out.y).toBe(chain.y);
    // a straight wire keeps a one-run shape (a vertical run of no length at its tail), so it is never re-routed
    expect(moveWire(chain, 'g', [[0, 40], [96, 40]], drawn).g).toEqual({ tail: { on: 'open', x: 0, y: 40 }, head: { on: 'open', x: 96, y: 40 }, bends: { xs: [0], ys: [] } });
    expect(moveWire(chain, 'gone', [[0, 0], [8, 0]], drawn)).toBe(chain);
  });

  it('a wire already open at both ends, moved whole, just moves: its ends and its shape go with it, nothing else changes', () => {
    const c: Circuit = { o: { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 96, y: 40 }, bends: { xs: [48], ys: [] } }, w: plain('s1', 's2') };
    const out = moveWire(c, 'o', [[16, 24], [64, 24], [64, 64], [112, 64]], () => null);
    expect(out.o).toEqual({ tail: { on: 'open', x: 16, y: 24 }, head: { on: 'open', x: 112, y: 64 }, bends: { xs: [64], ys: [] } });
    expect(out.w).toBe(c.w);
  });

  it('an end held where it was drawn stays held while the other end is open, goes back to automatic when the other end connects, and is the user\'s once moved itself', () => {
    const c: Circuit = { w: { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 400, y: 200 }, bends } };
    const held = holdEnd(c, 'w', 'tail', { on: 'step', step: 's1', y: 88 });
    expect(held.w).toEqual({ tail: { on: 'step', step: 's1', y: 88 }, head: c.w!.head, bends, held: 'tail' });
    // the open end moved on: still held, the bends too
    expect(setEnd(held, 'w', 'head', { on: 'open', x: 440, y: 200 }).w).toEqual({ tail: { on: 'step', step: 's1', y: 88 }, head: { on: 'open', x: 440, y: 200 }, bends, held: 'tail' });
    expect(setBends(held, 'w', null).w!.held).toBe('tail');
    // connected again: the held end is automatic again, and no longer held
    expect(setEnd(held, 'w', 'head', { on: 'step', step: 's2', y: 64 }).w).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's2', y: 64 } });
    expect(setEnd(held, 'w', 'head', { on: 'wire', host: 'x', at: 40 }).w!.tail).toEqual({ on: 'step', step: 's1', y: null });
    // the held end moved by the user: it stays where it is put, no longer held
    expect(setEnd(held, 'w', 'tail', { on: 'step', step: 's1', y: 120 }).w).toEqual({ tail: { on: 'step', step: 's1', y: 120 }, head: c.w!.head, bends });
    // a held hub tail goes back to its automatic place too
    const hub = holdEnd({ h: { tail: { on: 'hub', angle: null }, head: { on: 'open', x: 400, y: 200 } } }, 'h', 'tail', { on: 'hub', angle: 15 });
    expect(setEnd(hub, 'h', 'head', { on: 'step', step: 's2', y: null }).h).toEqual({ tail: { on: 'hub', angle: null }, head: { on: 'step', step: 's2', y: null } });
    // it serializes
    expect(parseCircuit(JSON.parse(JSON.stringify(held)))).toEqual(held);
  });

  it('compares ends, snaps hub angles to 15 degrees, and tells a shaped wire', () => {
    expect(sameEnd({ on: 'step', step: 's1', y: 64 }, { on: 'step', step: 's1', y: 64 })).toBe(true);
    expect(sameEnd({ on: 'step', step: 's1', y: 64 }, { on: 'step', step: 's1', y: null })).toBe(false);
    expect(sameEnd({ on: 'hub', angle: 90 }, { on: 'open', x: 0, y: 0 })).toBe(false);
    expect([snapAngle(-88), snapAngle(359), snapAngle(97)]).toEqual([270, 0, 90]);
    expect(shapedByHand(plain('s1', 's2'))).toBe(false);
    expect(shapedByHand({ ...plain('s1', 's2'), bends })).toBe(true);
    expect(shapedByHand({ tail: { on: 'step', step: 's1', y: 72 }, head: { on: 'open', x: 0, y: 0 } })).toBe(true);
  });
});

describe('direction-less wires (the user\'s rule D, 2026-10-09)', () => {
  it('a wire with no end on a step or the hub has no direction: open at both ends, or joined on a line and open', () => {
    const open = { on: 'open' as const, x: 0, y: 0 };
    expect(isFree({ tail: open, head: open })).toBe(true);
    expect(isFree({ tail: { on: 'wire', host: 'h', at: 40 }, head: open })).toBe(true);
    expect(isFree({ tail: open, head: { on: 'wire', host: 'h', at: 40 } })).toBe(true);
    expect(isFree({ tail: { on: 'hub', angle: null }, head: open })).toBe(false);
    expect(isFree({ tail: open, head: { on: 'step', step: 's1', y: null } })).toBe(false);
    expect(isFree(plain('s1', 's2'))).toBe(false);
  });

  it('turned round: tail and head swapped, its bends reversed, a held end the same end, same id', () => {
    const c: Circuit = { 'w:f': { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'wire', host: 'h', at: 40 }, bends: { xs: [10, 20, 30], ys: [5, 6] }, held: 'tail' } };
    expect(reverseWire(c, 'w:f')['w:f']).toEqual({ tail: { on: 'wire', host: 'h', at: 40 }, head: { on: 'open', x: 0, y: 0 }, bends: { xs: [30, 20, 10], ys: [6, 5] }, held: 'head' });
    expect(reverseWire(reverseWire(c, 'w:f'), 'w:f')['w:f']).toEqual(c['w:f']);
    expect(reverseWire(c, 'gone')).toBe(c);
  });

  it('turned round with its drawn length, the ends joined on it keep their point: measured from its new tail', () => {
    const c: Circuit = {
      'w:f': { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 300, y: 0 } },
      'w:g': { tail: { on: 'step', step: 's1', y: null }, head: { on: 'wire', host: 'w:f', at: 40 } },
      'w:h': { tail: { on: 'wire', host: 'w:f', at: 280 }, head: { on: 'open', x: 9, y: 9 } },
    };
    const out = reverseWire(c, 'w:f', 300);
    expect(out['w:g']!.head).toEqual({ on: 'wire', host: 'w:f', at: 260 });
    expect(out['w:h']!.tail).toEqual({ on: 'wire', host: 'w:f', at: 20 });
    // with no length the joined ends are left as they are
    expect(reverseWire(c, 'w:f')['w:g']).toBe(c['w:g']);
  });
});

describe('reading a circuit back', () => {
  it('parses its own JSON and drops a wire it cannot read (a head on the hub, a junction with no host)', () => {
    const c: Circuit = { 'w:1': { tail: { on: 'hub', angle: 90 }, head: { on: 'wire', host: 's1->s2', at: 40 }, bends: { xs: [8, 16], ys: [40] } }, 's1->s2': plain('s1', 's2') };
    expect(parseCircuit(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseCircuit({
      a: { tail: { on: 'step', step: 's1', y: null }, head: { on: 'hub', angle: 0 } },
      b: { tail: { on: 'open', x: 1, y: 2 }, head: { on: 'wire', at: 4 } },
      c: 5,
    })).toEqual({});
    expect(parseCircuit('nope')).toBeNull();
  });

  it('reads plan 7 shapes and plan 8 loose wires as wires (spec §8)', () => {
    const c = legacyCircuit(
      {
        's1->s2': { bends: { xs: [400], ys: [] }, landing: 72, contact: null },
        's3->s4': { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } },
        bad: {},
      },
      {
        l1: { source: 's1', end: { x: 900, y: 64 } },
        l2: { open: 'start', target: 's2', start: { x: 8, y: 8 }, landing: null, contact: { host: 's1->s2', at: 24 }, was: 's9->s2' },
        l3: { open: 'both', start: { x: 0, y: 0 }, end: { x: 64, y: 0 }, bends: { xs: [32], ys: [] } },
        l4: { source: 'wf', end: 'nope' },
      },
    );
    expect(c).toEqual({
      's1->s2': { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's2', y: 72 }, bends: { xs: [400], ys: [] } },
      's3->s4': { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 's1->s2', at: 40 } },
      'w:l1': { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 900, y: 64 } },
      'w:l2': { tail: { on: 'open', x: 8, y: 8 }, head: { on: 'wire', host: 's1->s2', at: 24 } },
      'w:l3': { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 64, y: 0 }, bends: { xs: [32], ys: [] } },
    });
    expect(legacyCircuit(undefined, {})).toBeNull();
  });
});

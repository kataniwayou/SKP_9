import { describe, expect, it } from 'vitest';
import type { Step } from '../model/graph';
import {
  addCircuitWire, legacyCircuit, openJoinedOn, parseCircuit, plainCircuit, removeCircuitWires, sameEnd, setBends, setEnd, shapedByHand, snapAngle,
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

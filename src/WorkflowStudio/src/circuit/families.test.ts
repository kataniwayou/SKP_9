import { describe, expect, it } from 'vitest';
import type { CircuitWire, End } from './circuit';
import { circuitTrace, heldSources, netsOf, shortedWires } from './families';
import { linkKeys, trace } from './trace';

const at = (step: string): End => ({ on: 'step', step, y: null });
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });
const open: End = { on: 'open', x: 0, y: 0 };
const w = (tail: End, head: End): CircuitWire => ({ tail, head });
const cond = (m: Record<string, number>) => (id: string): number | undefined => m[id];

describe('families (plan 9 §4)', () => {
  it('a net is the wires joined through junctions; its families are the entry conditions of its heads on steps', () => {
    // x has a direction (its head on s7, which decides nothing): a wire joined only on a line and open is direction-less
    // and in no net (the user's rule 1, 2026-10-09)
    const c = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s7')), y: w(at('s3'), at('s4')), z: w(at('s1'), open) };
    const nets = netsOf(c, cond({ s2: 1, s4: 2 }));
    expect(nets.map((n) => [[...n.wires].sort(), n.families])).toEqual([[['h', 'x'], [1]], [['y'], [2]], [['z'], []]]);
  });

  it('a tail on a step or the hub decides nothing (rule 7); the decider gone, the net is undecided again', () => {
    expect(netsOf({ a: w({ on: 'hub', angle: null }, open) }, cond({})).map((n) => n.families)).toEqual([[]]);
    expect(netsOf({ h: w(at('s1'), open), x: w(on('h', 40), at('s7')) }, cond({ s2: 1 })).map((n) => n.families)).toEqual([[]]);
  });

  it('a net is decided by a tap head on a step while the host head is open', () => {
    const c = { h: w(at('s1'), open), x: w(on('h', 40), at('s3')) };
    expect(netsOf(c, cond({ s3: 2 })).map((n) => [[...n.wires].sort(), n.families])).toEqual([[['h', 'x'], [2]]]);
  });

  it('a junction on a host missing from the circuit makes no phantom net', () => {
    const nets = netsOf({ x: w(on('gone', 8), at('s2')) }, cond({ s2: 1 }));
    expect(nets.map((n) => [n.wires, n.families])).toEqual([[['x'], [1]]]);
  });

  it('the same circuit before and after its deciding head is taken off: decided, then undecided (grey)', () => {
    const conditions = cond({ s2: 1 });
    const before = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s7')) };
    const after = { ...before, h: w(at('s1'), open) };
    expect(netsOf(before, conditions).map((n) => n.families)).toEqual([[1]]);
    expect(netsOf(after, conditions).map((n) => n.families)).toEqual([[]]);
  });

  it('a net with two families is a short circuit: its wires are left out of the trace', () => {
    const c = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s3')), y: w(at('s5'), at('s6')) };
    const conditions = cond({ s2: 1, s3: 2, s6: 1 });
    const nets = netsOf(c, conditions);
    expect(nets[0]!.families).toEqual([1, 2]);
    expect([...shortedWires(nets)].sort()).toEqual(['h', 'x']);
    const t = circuitTrace(c, conditions);
    expect([...linkKeys(t.links)]).toEqual(['s5->s6']);
    expect(t.nets).toHaveLength(2);
  });

  it('a step fed its own input (through junctions, or by one wire) is a link like any other, and named in selfFed (2026-10-20)', () => {
    const hidden = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s1')) };
    expect(linkKeys(trace(hidden).links)).toContain('s1->s1');
    const t = circuitTrace(hidden, cond({ s1: 1, s2: 1 }));
    expect([...linkKeys(t.links)].sort()).toEqual(['s1->s1', 's1->s2']);
    expect(t.selfFed).toEqual(['s1']);
    const plain = circuitTrace({ a: w(at('s3'), at('s3')) }, cond({ s3: 1 }));
    expect([...linkKeys(plain.links)]).toEqual(['s3->s3']);
    expect(plain.selfFed).toEqual(['s3']);
    expect(circuitTrace({ a: w(at('s1'), at('s2')) }, cond({ s2: 1 })).selfFed).toEqual([]);
  });
});

describe('direction-less wires and overlaps (the user\'s rules 1 and 2, 2026-10-09)', () => {
  it('a direction-less wire is in no live net: it takes no family, and a wire joined on it takes none from it', () => {
    // f: open at both ends; x: its tail joined on f, its head on a red step; y: tail on a step, head joined on f
    const c = { f: w(open, open), x: w(on('f', 40), at('s2')), y: w(at('s1'), on('f', 80)) };
    const nets = netsOf(c, cond({ s2: 1 }));
    const byWire = new Map(nets.flatMap((n) => n.wires.map((x) => [x, n] as const)));
    expect(byWire.get('f')!.wires).toEqual(['f']);
    expect(byWire.get('f')!.families).toEqual([]);
    expect(byWire.get('y')!.wires).toEqual(['y']);
    expect(byWire.get('y')!.families).toEqual([]);
    expect(byWire.get('x')!.families).toEqual([1]);
  });

  it('two families joined only through a direction-less wire are no short circuit (nothing flows through it)', () => {
    const c = { f: w(open, open), x: w(on('f', 40), at('s2')), z: w(on('f', 80), at('s3')) };
    expect(shortedWires(netsOf(c, cond({ s2: 1, s3: 2 }))).size).toBe(0);
  });

  it('a directed wire joined on a directed host is in its net, as before', () => {
    const c = { h: w(at('s1'), open), x: w(on('h', 40), at('s3')) };
    expect(netsOf(c, cond({ s3: 2 })).map((n) => [...n.wires].sort())).toEqual([['h', 'x']]);
  });

  it('wires overlapping another net short both nets: every wire of them is shorted, and their tails\' sources are held back', () => {
    const c = {
      h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s4')), // one net
      b: w(at('s5'), at('s6')), // another
      k: w(at('s7'), at('s8')), // untouched
    };
    const nets = netsOf(c, cond({ s2: 1, s4: 1, s6: 1, s8: 1 }));
    const shorted = shortedWires(nets, ['x', 'b']);
    expect([...shorted].sort()).toEqual(['b', 'h', 'x']);
    expect([...heldSources(c, shorted)].sort()).toEqual(['s1', 's5']);
    const t = circuitTrace(c, cond({ s2: 1, s4: 1, s6: 1, s8: 1 }), ['x', 'b']);
    expect([...linkKeys(t.links)]).toEqual(['s7->s8']);
    expect([...t.shorted].sort()).toEqual(['b', 'h', 'x']);
  });
});

import { describe, expect, it } from 'vitest';
import type { CircuitWire, End } from './circuit';
import { circuitTrace, netsOf, shortedWires } from './families';
import { linkKeys, trace } from './trace';

const at = (step: string): End => ({ on: 'step', step, y: null });
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });
const open: End = { on: 'open', x: 0, y: 0 };
const w = (tail: End, head: End): CircuitWire => ({ tail, head });
const cond = (m: Record<string, number>) => (id: string): number | undefined => m[id];

describe('families (plan 9 §4)', () => {
  it('a net is the wires joined through junctions; its families are the entry conditions of its heads on steps', () => {
    const c = { h: w(at('s1'), at('s2')), x: w(on('h', 40), open), y: w(at('s3'), at('s4')), z: w(at('s1'), open) };
    const nets = netsOf(c, cond({ s2: 1, s4: 2 }));
    expect(nets.map((n) => [[...n.wires].sort(), n.families])).toEqual([[['h', 'x'], [1]], [['y'], [2]], [['z'], []]]);
  });

  it('a tail on a step or the hub decides nothing (rule 7); the decider gone, the net is undecided again', () => {
    expect(netsOf({ a: w({ on: 'hub', angle: null }, open) }, cond({})).map((n) => n.families)).toEqual([[]]);
    expect(netsOf({ h: w(at('s1'), open), x: w(on('h', 40), open) }, cond({ s2: 1 })).map((n) => n.families)).toEqual([[]]);
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

  it('a step fed its own input (through junctions, or by one wire) is never a link: it is named in selfFed (spec §2.2-4)', () => {
    const hidden = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s1')) };
    expect(linkKeys(trace(hidden).links)).toContain('s1->s1');
    const t = circuitTrace(hidden, cond({ s1: 1, s2: 1 }));
    expect([...linkKeys(t.links)]).toEqual(['s1->s2']);
    expect(t.selfFed).toEqual(['s1']);
    const plain = circuitTrace({ a: w(at('s3'), at('s3')) }, cond({ s3: 1 }));
    expect(plain.links.size).toBe(0);
    expect(plain.selfFed).toEqual(['s3']);
    expect(circuitTrace({ a: w(at('s1'), at('s2')) }, cond({ s2: 1 })).selfFed).toEqual([]);
  });
});

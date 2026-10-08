import { describe, expect, it } from 'vitest';
import type { Circuit, CircuitWire, End } from './circuit';
import { linkKeys, trace, wiresBetween } from './trace';

const at = (step: string): End => ({ on: 'step', step, y: null });
const hub: End = { on: 'hub', angle: null };
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });
const open: End = { on: 'open', x: 0, y: 0 };
const w = (tail: End, head: End): CircuitWire => ({ tail, head });
const links = (c: Circuit) => [...linkKeys(trace(c).links)].sort();

describe('trace (plan 9 §7)', () => {
  it('a plain wire links its tail step or the hub to its head step; an open end links nothing', () => {
    expect(links({ a: w(hub, at('s1')), b: w(at('s1'), at('s2')), c: w(at('s2'), open), d: w(open, at('s3')) })).toEqual(['s1->s2', 'wf->s1']);
  });

  it('a tail junction fans out: it takes its host\'s current', () => {
    expect(links({ h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s3')) })).toEqual(['s1->s2', 's1->s3']);
  });

  it('a head junction fans in: its current goes on into the host\'s head', () => {
    expect(links({ h: w(at('s1'), at('s2')), x: w(at('s3'), on('h', 40)) })).toEqual(['s1->s2', 's3->s2']);
  });

  it('a tail junction on an entry wire takes the hub\'s current: its head\'s step is an entry step', () => {
    expect(links({ e: w(hub, at('s1')), x: w(on('e', 24), at('s2')) })).toEqual(['wf->s1', 'wf->s2']);
  });

  it('position along the host decides: current poured in reaches only the tail junctions further along; equal points do not meet', () => {
    const c = (head: number): Circuit => ({ h: w(at('s1'), at('s2')), t: w(on('h', 64), at('s3')), x: w(at('s4'), on('h', head)) });
    expect(links(c(32))).toContain('s4->s3');
    expect(links(c(96))).not.toContain('s4->s3');
    expect(links(c(64))).not.toContain('s4->s3');
    expect(links(c(96))).toContain('s4->s2');
  });

  it('follows chains: a tail junction on a wire that is itself joined takes only that wire\'s current', () => {
    expect(links({ h: w(at('s1'), at('s2')), k: w(at('s3'), on('h', 64)), t: w(on('k', 16), at('s4')) })).toEqual(['s1->s2', 's3->s2', 's3->s4']);
  });

  it('two ways into one step write the link once, and removing one keeps it (Review Focus 3)', () => {
    const a = w(at('s1'), at('s2')), b = w(at('s1'), at('s2')), h = w(at('s1'), at('s3')), x = w(on('h', 40), at('s2'));
    expect(trace({ a, b, h, x }).links.get('s1')).toEqual(['s2', 's3']);
    expect(trace({ b, h, x }).links.get('s1')).toEqual(['s2', 's3']);
    expect(trace({ h, x }).links.get('s1')).toEqual(['s3', 's2']);
  });

  it('ignores a wire\'s end on itself, and leaves out the wires it is told to skip', () => {
    expect(trace({ a: w(at('s1'), on('a', 40)) }).links.size).toBe(0);
    expect([...linkKeys(trace({ a: w(at('s1'), at('s2')), b: w(at('s3'), at('s4')) }, new Set(['b'])).links)]).toEqual(['s1->s2']);
  });

  it('finds a closed loop of wires only (spec §2.2-3), never a loop through a step', () => {
    expect(trace({ h: w(at('s1'), on('x', 40)), x: w(at('s2'), on('h', 40)) }).loop).toBe(true);
    expect(trace({ a: w(at('s1'), at('s2')), b: w(at('s2'), at('s1')) }).loop).toBe(false);
  });

  it('names the wires current passes through from a source into a step', () => {
    const c = { h: w(at('s1'), at('s2')), x: w(on('h', 40), at('s3')), y: w(at('s4'), at('s3')) };
    expect([...wiresBetween(c, 's1', 's3')].sort()).toEqual(['h', 'x']);
    expect([...wiresBetween(c, 's4', 's3')]).toEqual(['y']);
    expect([...wiresBetween(c, 's4', 's2')]).toEqual([]);
  });
});

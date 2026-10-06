import { describe, expect, it } from 'vitest';
import type { Placement } from './placement';
import { computeDepartures, computeLandings, WORKFLOW_SOURCE, type WireEnd } from './ports';

const placement = (steps: Record<string, [number, number]>): Placement => ({
  sphere: { cx: 128, cy: 128 },
  steps: new Map(Object.entries(steps).map(([id, [x, y]]) => [id, { x, y }])),
  caches: new Map(),
});

describe('computeDepartures', () => {
  it('centres a fan-out group 16 apart on the source processor middle, ordered by target height', () => {
    const p = placement({ a: [288, 32], low: [576, 320], high: [576, 32] });
    const wires: WireEnd[] = [{ source: 'a', target: 'low' }, { source: 'a', target: 'high' }];

    const out = computeDepartures(wires, p).get('a')!;

    expect(out.get('high')).toBe(32 + 96 - 8);
    expect(out.get('low')).toBe(32 + 96 + 8);
  });

  it('starts entry wires at the sphere centre height', () => {
    const p = placement({ a: [288, 32] });
    expect(computeDepartures([{ source: WORKFLOW_SOURCE, target: 'a' }], p).get(WORKFLOW_SOURCE)!.get('a')).toBe(128);
  });
});

describe('computeLandings', () => {
  const land = (p: Placement, wires: WireEnd[]) => computeLandings(wires, p, computeDepartures(wires, p));

  it('keeps the departure height when it falls in the target band and the source is to the left', () => {
    const p = placement({ a: [288, 32], b: [576, 64] });
    // departure 128; band of b is 64+62 .. 64+130 = 126..194
    expect(land(p, [{ source: 'a', target: 'b' }]).get('b')!.get('a')).toBe(128);
  });

  it('lands a wire that must bend at the processor middle', () => {
    const p = placement({ a: [288, 32], b: [576, 320] });
    expect(land(p, [{ source: 'a', target: 'b' }]).get('b')!.get('a')).toBe(320 + 96);
  });

  it('treats a source that is not far enough left as bending', () => {
    const p = placement({ a: [288, 32], b: [400, 32] });
    expect(land(p, [{ source: 'a', target: 'b' }]).get('b')!.get('a')).toBe(32 + 96);
  });

  it('keeps every arrival into one step at least 16 apart, even for a fan-in of 8', () => {
    const steps: Record<string, [number, number]> = { t: [864, 320] };
    const wires: WireEnd[] = [];
    for (let k = 0; k < 8; k++) { steps[`s${k}`] = [288, 32 + k * 192]; wires.push({ source: `s${k}`, target: 't' }); }
    const ys = [...land(placement(steps), wires).get('t')!.values()].sort((a, b) => a - b);

    expect(ys).toHaveLength(8);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(16);
    for (const y of ys) expect(y % 8).toBe(0);
  });
});

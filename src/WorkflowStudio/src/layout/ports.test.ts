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

  const arrivals = (steps: Record<string, [number, number]>, wires: WireEnd[]) =>
    [...land(placement(steps), wires).get('t')!.values()].sort((a, b) => a - b);
  const spaced = (ys: number[]) => { for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(16); };

  it('terminates when departures fill the band, and every arrival stays on the step', () => {
    // t at y 320: band 382..450. Six sources whose departures (y + 96) all fall inside it. A band holds at most 5 slots 16 apart, so one wire takes the band-full path.
    const steps: Record<string, [number, number]> = { t: [864, 320] };
    const wires: WireEnd[] = [];
    for (let k = 0; k < 6; k++) { steps[`s${k}`] = [288, 288 + k * 8]; wires.push({ source: `s${k}`, target: 't' }); }
    const ys = arrivals(steps, wires);

    expect(ys).toHaveLength(6);
    spaced(ys);
    for (const y of ys) { expect(y % 8).toBe(0); expect(y).toBeGreaterThanOrEqual(320 + 40); expect(y).toBeLessThanOrEqual(320 + 160); }
  });

  it('keeps all 8 bent arrivals of a fan-in of 8 on the step', () => {
    const steps: Record<string, [number, number]> = { t: [864, 320] };
    const wires: WireEnd[] = [];
    for (let k = 0; k < 8; k++) { steps[`s${k}`] = [288, 32 + k * 192]; wires.push({ source: `s${k}`, target: 't' }); }
    const ys = arrivals(steps, wires);
    for (const y of ys) { expect(y).toBeGreaterThanOrEqual(320 + 40); expect(y).toBeLessThanOrEqual(320 + 160); }
  });

  it('terminates for a fan-in of 12, keeping every arrival 16 apart and on the grid', () => {
    const steps: Record<string, [number, number]> = { t: [864, 320] };
    const wires: WireEnd[] = [];
    for (let k = 0; k < 12; k++) { steps[`s${k}`] = [288, 32 + k * 192]; wires.push({ source: `s${k}`, target: 't' }); }
    const ys = arrivals(steps, wires);

    expect(ys).toHaveLength(12);
    spaced(ys);
    for (const y of ys) expect(y % 8).toBe(0);
    // a step has room for 8 slots 16 apart below its cap: the first 8 are on it
    expect(ys.filter((y) => y >= 320 + 40 && y <= 320 + 160).length).toBeGreaterThanOrEqual(8);
  });

  it('keeps all 8 arrivals on the step when one straight landing is 8 off the bent walk phase', () => {
    // p (fan-out 2: t then z) departs t at 448 - 8 = 440, in t's band: a straight landing at step-local 120.
    const steps: Record<string, [number, number]> = { t: [864, 320], p: [576, 352], z: [864, 640] };
    const wires: WireEnd[] = [{ source: 'p', target: 't' }, { source: 'p', target: 'z' }];
    for (let k = 1; k <= 7; k++) { steps[`r${k}`] = [1152, 32 + k * 96]; wires.push({ source: `r${k}`, target: 't' }); }
    const ys = arrivals(steps, wires);

    expect(ys).toHaveLength(8);
    spaced(ys);
    expect(ys).toContain(320 + 120);
    for (const y of ys) { expect(y % 8).toBe(0); expect(y).toBeGreaterThanOrEqual(320 + 40); expect(y).toBeLessThanOrEqual(320 + 160); }
  });

  it('property: a fan-in of 8 lands on the step whenever a 16-spaced packing around the straight landings exists', () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 300; trial++) {
      const steps: Record<string, [number, number]> = { t: [864, 320] };
      const wires: WireEnd[] = [];
      for (let k = 0; k < 8; k++) {
        const x = [288, 576, 1152][rnd(3)]!;
        steps[`s${k}`] = [x, rnd(100) * 8];
        wires.push({ source: `s${k}`, target: 't' });
        const extra = rnd(3); // fan-out 1..3, so departures are offset by 0, 8 or 16
        for (let e = 0; e < extra; e++) { steps[`z${k}_${e}`] = [2000, 1000 + 200 * (k * 3 + e)]; wires.push({ source: `s${k}`, target: `z${k}_${e}` }); }
      }
      const p = placement(steps);
      const deps = computeDepartures(wires, p);
      const landed = computeLandings(wires, p, deps).get('t')!;
      const ys = [...landed.values()].sort((a, b) => a - b);

      spaced(ys);
      for (const y of ys) expect(y % 8).toBe(0);

      const straight = [...landed].filter(([s, y]) => y === deps.get(s)!.get('t')).map(([, y]) => y);
      let packed = 0, last = -Infinity;
      for (let y = 320 + 40; y <= 320 + 160; y += 8) {
        if (straight.some((u) => Math.abs(u - y) < 16)) continue;
        if (y - last >= 16) { packed++; last = y; }
      }
      if (packed >= 8 - straight.length) for (const y of ys) { expect(y).toBeGreaterThanOrEqual(320 + 40); expect(y).toBeLessThanOrEqual(320 + 160); }
    }
  });
});

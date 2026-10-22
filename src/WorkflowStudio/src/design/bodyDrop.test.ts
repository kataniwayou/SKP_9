import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, plainCircuit, setBends, type Circuit } from '../circuit/circuit';
import { trace } from '../circuit/trace';
import { endPointOf, routeCircuit } from '../layout/circuitRoute';
import { GRID, SPHERE_R, STEP_W } from '../layout/geometry';
import { simplify, type Pt } from '../layout/router';
import { translatePoints } from '../layout/wireMove';
import { landBody } from './bodyDrop';
import { overlapJudge } from './overlapJudge';

// s1 -> s2 -> s3 (Completed) and s4 -> s5 (Failed); entries s1, s4
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's4'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { nextStepIds: ['s3'] }), stepDto('s3'), stepDto('s4', { nextStepIds: ['s5'] }), stepDto('s5', { entryCondition: 2 })],
}));
type Doc = Awaited<ReturnType<typeof doc>>;
const plain = (d: Doc): Circuit => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
const drawn = (d: Doc, c: Circuit, id: string) => routeCircuit(c, { placement: d.placement, steps: d.graph.steps }).find((r) => r.id === id)!.points;
const pos = (d: Doc, id: string) => d.placement.steps.get(id)!;
const land = (d: Doc, c: Circuit, id: string, pts: Pt[], dx: number, dy: number, first: 'tail' | 'head' | null = null) =>
  landBody(d, c, id, pts, endPointOf(d.wires), dx, dy, first, 8);
/** A wire open at both ends drawn as `pts` (from its tail to its head). */
const free = (c: Circuit, id: string, pts: Pt[]): Circuit =>
  addCircuitWire(c, id, { tail: { on: 'open', x: pts[0]![0], y: pts[0]![1] }, head: { on: 'open', x: pts.at(-1)![0], y: pts.at(-1)![1] } });

describe('a wire moved whole (the user\'s rule B, 2026-10-09)', () => {
  it('far from everything both ends are open where the moved path ends; nothing decides the shift', async () => {
    const d = await doc(), c = plain(d);
    const pts = drawn(d, c, 's1->s2');
    const l = land(d, c, 's1->s2', pts, 0, 2000);
    expect(l.first).toBeNull();
    expect(l.ends.map((e) => e.verdict)).toEqual(['move', 'move']);
    expect(l.points).toEqual(translatePoints(pts, 0, 2000));
    expect(l.result['s1->s2']!.tail).toEqual({ on: 'open', x: pts[0]![0], y: pts[0]![1] + 2000 });
    expect(l.result).toBe(l.preview);
  });

  it("an end 11 px off a line joins it: a line's reach is Visio's 12 to a block's 10 (spec §4.4; tidy-up 2026-10-22)", async () => {
    const d = await doc(), c0 = plain(d);
    // s1 -> s2 runs level between the two steps; a free upright wire below its middle, its upper end 100 under the line
    const line = drawn(d, c0, 's1->s2');
    const y = line[0]![1], x = (line[0]![0] + line.at(-1)![0]) / 2;
    const pts: Pt[] = [[x, y + 200], [x, y + 100]];
    const c = free(c0, 'w:f', pts);
    // moved up 89: its upper end 11 under the line, with a block's reach of 10
    const l = landBody(d, c, 'w:f', pts, endPointOf(d.wires), 0, -89, null, 10);
    expect(l.ends[1]).toMatchObject({ verdict: 'join', line: true, id: 's1->s2' });
  });

  it('dropped back a grid step off where it was: both ends connect again, a tail and a head, the shape exactly as moved', async () => {
    const d = await doc(), c = plain(d);
    const pts = drawn(d, c, 's1->s2');
    const l = land(d, c, 's1->s2', pts, 0, 8);
    expect(l.ends.map((e) => e.verdict)).toEqual(['connect', 'connect']);
    expect([l.dx, l.dy]).toEqual([0, 8]);
    const w = l.result['s1->s2']!;
    expect(w.tail).toMatchObject({ on: 'step', step: 's1' });
    expect(w.head).toMatchObject({ on: 'step', step: 's2' });
    expect(trace(l.result).links.get('s1')).toEqual(['s2']);
    expect(drawn(d, l.result, 's1->s2')).toEqual(translatePoints(pts, 0, 8));
  });

  it('an end inside a step\'s output half shifts the whole wire onto that side; the other end then meets its own side too', async () => {
    const d = await doc(), c = plain(d);
    const pts = drawn(d, c, 's1->s2');
    // 40 left: the tail is inside s1, 40 short of its output side; the head 40 short of s2
    const l = land(d, c, 's1->s2', pts, -40, 0);
    expect([l.dx, l.dy]).toEqual([0, 0]);
    expect(l.ends.map((e) => e.verdict)).toEqual(['connect', 'connect']);
    expect(l.points).toEqual(pts);
  });

  it('a shape that cannot meet both contacts: the end that got there first connects, the other stays open ("move")', async () => {
    const d = await doc();
    const s1 = pos(d, 's1'), s3 = pos(d, 's3');
    const y = s1.y + 96;
    // its tail 24 short of s1's output side, its head 20 inside s3's input side: no shift meets both
    const pts: Pt[] = [[s1.x + 200, y], [s1.x + 400, y], [s1.x + 400, s3.y + 96], [s3.x + 20, s3.y + 96]];
    const c = free(plain(d), 'w:f', pts);
    const l = land(d, c, 'w:f', pts, 0, 0);
    expect(l.first).toBe('tail');
    expect(l.ends.map((e) => e.verdict)).toEqual(['connect', 'move']);
    expect(l.result['w:f']!.tail).toMatchObject({ on: 'step', step: 's1' });
    expect(l.result['w:f']!.head.on).toBe('open');
    expect(l.dx).toBe(24);
    // the head got there first: it connects, the tail stays open
    const h = land(d, c, 'w:f', pts, 0, 0, 'head');
    expect(h.ends.map((e) => e.verdict)).toEqual(['move', 'connect']);
    expect(h.result['w:f']!.head).toMatchObject({ on: 'step', step: 's3' });
    expect(h.dx).toBe(-20);
  });

  it('a direction-less wire: the sides its ends land on decide which is the tail and which the head; drawn the same way round', async () => {
    const d = await doc();
    const s1 = pos(d, 's1'), s3 = pos(d, 's3');
    // stored from s3's input to s1's output: dropped there, its "tail" is the head
    const pts: Pt[] = [[s3.x, s3.y + 120], [s1.x + 400, s3.y + 120], [s1.x + 400, s1.y + 72], [s1.x + STEP_W, s1.y + 72]];
    const c = free(plain(d), 'w:f', pts);
    const l = land(d, c, 'w:f', pts, 0, 0);
    expect(l.ends.map((e) => e.verdict)).toEqual(['connect', 'connect']);
    const w = l.result['w:f']!;
    expect(w.tail).toMatchObject({ on: 'step', step: 's1' });
    expect(w.head).toMatchObject({ on: 'step', step: 's3' });
    expect(drawn(d, l.result, 'w:f')).toEqual([...pts].reverse());
    expect(trace(l.result).links.get('s1')).toContain('s3');
  });

  it('two inputs or two outputs at once: the second end is the wrong side and stays open', async () => {
    const d = await doc();
    const s2 = pos(d, 's2'), s3 = pos(d, 's3');
    const ins: Pt[] = [[s2.x, s2.y + 96], [s2.x - 32, s2.y + 96], [s2.x - 32, s3.y + 120], [s3.x, s3.y + 120]];
    const a = land(d, free(plain(d), 'w:f', ins), 'w:f', ins, 0, 0);
    expect(a.ends.map((e) => e.verdict)).toEqual(['connect', 'wrongSide']);
    expect(a.result['w:f']!.head).toMatchObject({ on: 'step', step: 's2' });
    expect(a.result['w:f']!.tail.on).toBe('open');
    const outs: Pt[] = [[s2.x + STEP_W, s2.y + 96], [s2.x + 260, s2.y + 96], [s2.x + 260, s3.y + 120], [s3.x + STEP_W, s3.y + 120]];
    const b = land(d, free(plain(d), 'w:f', outs), 'w:f', outs, 0, 0);
    expect(b.ends.map((e) => e.verdict)).toEqual(['connect', 'wrongSide']);
  });

  it('both ends on wire lines: the second is "needs a step first"', async () => {
    const d = await doc(), c = plain(d);
    const a = drawn(d, c, 's1->s2'), b = drawn(d, c, 's4->s5');
    const pa = a[0]!, pb = b[0]!;
    // from 48 along s1 -> s2's first run to 48 along s4 -> s5's
    const p: Pt = [pa[0] + 48, pa[1]], q: Pt = [pb[0] + 48, pb[1]];
    const pts: Pt[] = [p, [p[0], q[1]], q];
    const l = land(d, free(c, 'w:f', pts), 'w:f', pts, 0, 0);
    expect(l.ends.map((e) => e.verdict)).toEqual(['join', 'needsStep']);
    expect(l.result['w:f']!.tail).toMatchObject({ on: 'wire', host: 's1->s2' });
    expect(l.result['w:f']!.head.on).toBe('open');
  });
});

describe('a wire moved whole onto the hub (review 2026-10-09)', () => {
  const one = () => loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['a'] }), steps: [stepDto('a')] }));
  const onGrid = (v: number) => Math.abs(v / GRID - Math.round(v / GRID)) < 1e-9;

  it('its tail lands at the ring point snapped to the grid: everything stored stays on the grid and it is drawn as moved after a short lead from the ring', async () => {
    const d = await one();
    const { cx, cy } = d.placement.sphere;
    const ang = (165 * Math.PI) / 180;
    const tx = Math.round((cx + SPHERE_R * Math.cos(ang)) / 8) * 8, ty = Math.round((cy + SPHERE_R * Math.sin(ang)) / 8) * 8 + 400;
    const c = addCircuitWire(plain(d), 'w:f', { tail: { on: 'open', x: tx, y: ty }, head: { on: 'open', x: tx - 240, y: ty + 80 }, bends: { xs: [tx - 160], ys: [] } });
    const shown = { ...d, wires: routeCircuit(c, { placement: d.placement, steps: d.graph.steps }) };
    const before = drawn(shown, c, 'w:f');
    const l = landBody(shown, c, 'w:f', before, endPointOf(shown.wires), 0, -400, null, 8);
    expect(l.ends[0]!.verdict).toBe('connect');
    expect([onGrid(l.dx), onGrid(l.dy)]).toEqual([true, true]);
    const w = l.result['w:f']!;
    expect(w.tail).toEqual({ on: 'hub', angle: 165 });
    expect(w.head.on === 'open' && onGrid(w.head.x) && onGrid(w.head.y)).toBe(true);
    expect(w.bends!.xs.every(onGrid) && w.bends!.ys.every(onGrid)).toBe(true);
    const routed = drawn(d, l.result, 'w:f');
    const moved = translatePoints(before, l.dx, l.dy);
    // the ring point, one short jog onto the grid, then the shape exactly as moved
    const ring = routed[0]!;
    expect(routed).toEqual(simplify([ring, [ring[0], moved[0]![1]], ...moved]));
    expect(Math.hypot(ring[0] - cx, ring[1] - cy)).toBeCloseTo(SPHERE_R, 0);
    expect(Math.hypot(ring[0] - moved[0]![0], ring[1] - moved[0]![1])).toBeLessThanOrEqual(GRID);
  });

  it('after a hub landing the other end still connects: an entry wire moved down a little lands on the ring and on its step again', async () => {
    const d = await one();
    const c = plain(d);
    const before = drawn(d, c, 'wf->a');
    const l = land(d, c, 'wf->a', before, 0, 24);
    expect(l.ends.map((e) => e.verdict)).toEqual(['connect', 'connect']);
    const w = l.result['wf->a']!;
    expect(w.tail.on).toBe('hub');
    expect(w.head).toMatchObject({ on: 'step', step: 'a' });
    const moved = translatePoints(before, l.dx, l.dy);
    const routed = drawn(d, l.result, 'wf->a');
    expect(routed).toEqual(simplify([routed[0]!, [routed[0]![0], moved[0]![1]], ...moved]));
  });
});

describe('a wire moved whole onto another wire (the user\'s rule 2, 2026-10-09)', () => {
  it('lying on a wire out of another step, its ends that would connect are "short circuit" and stay open; the wire still moves', async () => {
    const d = await doc(), c = plain(d);
    // s1 -> s2 and s2 -> s3 run straight along one line: a wire from s1's output to s3's input lies on s2 -> s3 too
    const one = drawn(d, c, 's1->s2'), two = drawn(d, c, 's2->s3');
    expect([one.length, two.length, one[0]![1]]).toEqual([2, 2, two[0]![1]]);
    const pts: Pt[] = [one[0]!, two.at(-1)!];
    // a both-open wire 400 below that line, moved up onto it: its ends meet s1's output and s3's input
    const moved = translatePoints(pts, 0, 400);
    // s2 -> s3 shaped by hand where it is (automatic, it would move a track over: the coordinator's ruling)
    const c2 = free(setBends(c, 's2->s3', { xs: [two[0]![0]], ys: [] }), 'w:f', moved);
    expect(land(d, c2, 'w:f', moved, 0, -400).ends.map((e) => e.verdict)).toEqual(['connect', 'connect']);
    const l = landBody(d, c2, 'w:f', moved, endPointOf(d.wires), 0, -400, null, 8, overlapJudge(d, 'w:f', c));
    expect(l.ends.map((e) => e.verdict)).toEqual(['short', 'short']);
    expect(l.points).toEqual(pts);
    expect(l.result).toBe(l.preview);
    expect(l.result['w:f']!.tail).toMatchObject({ on: 'open' });
  });

  it('lying on a wire out of the same step of the same colour (the user\'s ruling, 2026-10-09), its ends connect: a bus', async () => {
    const d = await doc(), c = plain(d);
    const pts = drawn(d, c, 's2->s3');
    // a both-open wire 400 below s2 -> s3, moved up onto it: its ends meet s2's output and s3's input, as s2 -> s3's do
    const moved = translatePoints(pts, 0, 400);
    const l = landBody(d, free(c, 'w:f', moved), 'w:f', moved, endPointOf(d.wires), 0, -400, null, 8, overlapJudge(d, 'w:f', c));
    expect(l.ends.map((e) => e.verdict)).toEqual(['connect', 'connect']);
    expect(l.result['w:f']).toMatchObject({ tail: { on: 'step', step: 's2' }, head: { on: 'step', step: 's3' } });
  });

  it('beside another wire it connects as before', async () => {
    const d = await doc(), c = plain(d);
    const pts = drawn(d, c, 's1->s2');
    const l = landBody(d, c, 's1->s2', pts, endPointOf(d.wires), 0, 8, null, 8, overlapJudge(d, 's1->s2', c));
    expect(l.ends.map((e) => e.verdict)).toEqual(['connect', 'connect']);
  });
});

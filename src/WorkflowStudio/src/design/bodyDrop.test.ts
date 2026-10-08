import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, plainCircuit, type Circuit } from '../circuit/circuit';
import { trace } from '../circuit/trace';
import { endPointOf, routeCircuit } from '../layout/circuitRoute';
import { STEP_W } from '../layout/geometry';
import type { Pt } from '../layout/router';
import { translatePoints } from '../layout/wireMove';
import { landBody } from './bodyDrop';

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

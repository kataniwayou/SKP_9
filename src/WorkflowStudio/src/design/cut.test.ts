import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, isFree, plainCircuit, type Circuit } from '../circuit/circuit';
import { endPointOf, routeCircuit } from '../layout/circuitRoute';
import { lengthOf } from '../layout/junctions';
import { pointsOfShape } from '../layout/shape';
import { cutPaths, cutWire, squareAt, squaresOf } from './cut';

// s1 -> s2 (Completed); a Z-shaped wire w:z from s1 to s2's input with its own bends
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3')],
}));
type Doc = Awaited<ReturnType<typeof doc>>;
const ctx = (d: Doc) => ({ placement: d.placement, steps: d.graph.steps });
const routeOf = (d: Doc, c: Circuit, id: string) => routeCircuit(c, ctx(d)).find((r) => r.id === id)!;

/** w:z from s1's output to s2's input (at 136): right, down 160, right, up 80, right, up, right. */
async function zWire() {
  const d = await doc();
  const s1 = d.placement.steps.get('s1')!;
  const x0 = s1.x + 224;
  const bends = { xs: [x0 + 40, x0 + 120, x0 + 200], ys: [s1.y + 256, s1.y + 176] };
  const c = addCircuitWire(plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id)), 'w:z',
    { tail: { on: 'step', step: 's1', y: null }, head: { on: 'step', step: 's2', y: 136 }, bends });
  return { d, c, bends, wire: routeOf(d, c, 'w:z') };
}

describe('the squares of a picked wire (the targets of a cut)', () => {
  it('one per end, one per run of its core away from the ends; a point within half a square of one is over it', async () => {
    const { wire, bends } = await zWire();
    const sq = squaresOf(wire, bends, 1);
    expect(sq.filter((s) => s.kind === 'end').map((s) => s.kind === 'end' && s.side)).toEqual(['tail', 'head']);
    const runs = sq.filter((s) => s.kind === 'run');
    expect(runs.length).toBeGreaterThanOrEqual(5);
    const r = runs[2]!;
    expect(squareAt(sq, { x: r.x + 4, y: r.y - 4 }, 1)).toEqual(r);
    expect(squareAt(sq, { x: r.x + 6, y: r.y }, 1)).toBeNull();
    // at zoom 0.5 a square covers twice the flow units
    expect(squareAt(squaresOf(wire, bends, 2), { x: r.x + 8, y: r.y }, 2)).toMatchObject({ kind: 'run', k: r.kind === 'run' ? r.k : -1 });
  });
});

describe('cutting a wire at one of its run squares (the user\'s rule, 2026-10-09)', () => {
  it('its head dragged onto a run square: everything from that square to the head goes, the wire ends there open, its shape up to there kept', async () => {
    const { d, c, bends, wire } = await zWire();
    const core = pointsOfShape(wire.core.ends, bends);
    // run 3: the horizontal run between the second and third verticals
    const mid: [number, number] = [(core[3]![0] + core[4]![0]) / 2, (core[3]![1] + core[4]![1]) / 2];
    const out = cutWire(c, 'w:z', 'head', wire, bends, 3, endPointOf(d.wires), d.placement);
    // the tail stays where it is drawn: held at its height
    expect(out['w:z']!.tail).toEqual({ on: 'step', step: 's1', y: wire.points[0]![1] - d.placement.steps.get('s1')!.y });
    expect(out['w:z']!.held).toBe('tail');
    expect(out['w:z']!.head).toEqual({ on: 'open', x: mid[0], y: mid[1] });
    const drawn = routeOf(d, out, 'w:z').points;
    expect(drawn).toEqual([...wire.points.slice(0, 4), mid]);
    // its head is no longer on s2
    expect(routeOf(d, out, 'w:z').target).toBeNull();
  });

  it('its tail dragged onto a run square: the part from the tail to that square goes; with no end left on a step or the hub it has no direction', async () => {
    const { d, c, bends, wire } = await zWire();
    const core = pointsOfShape(wire.core.ends, bends);
    const mid: [number, number] = [(core[1]![0] + core[2]![0]) / 2, (core[1]![1] + core[2]![1]) / 2];
    const out = cutWire(c, 'w:z', 'tail', wire, bends, 1, endPointOf(d.wires), d.placement);
    expect(out['w:z']!.tail).toEqual({ on: 'open', x: mid[0], y: mid[1] });
    expect(out['w:z']!.head).toEqual({ on: 'step', step: 's2', y: 136 });
    expect(routeOf(d, out, 'w:z').points).toEqual([mid, ...wire.points.slice(2)]);
    // and its head cut too: no step end left, direction-less
    const w2 = routeOf(d, out, 'w:z');
    const both = cutWire(out, 'w:z', 'head', w2, out['w:z']!.bends!, 2, endPointOf(routeCircuit(out, ctx(d))), d.placement);
    expect(isFree(both['w:z']!)).toBe(true);
  });

  it('a straight wire cut keeps a straight one-run shape', async () => {
    const d = await doc();
    const c = plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
    const wire = routeOf(d, c, 's1->s2');
    expect(wire.points).toHaveLength(2);
    const bends = { xs: [wire.points[0]![0]], ys: [] };
    const out = cutWire(c, 's1->s2', 'head', wire, bends, 2, endPointOf(d.wires), d.placement);
    const mid = (wire.points[0]![0] + wire.points[1]![0]) / 2;
    expect(routeOf(d, out, 's1->s2').points).toEqual([wire.points[0], [mid, wire.points[0]![1]]]);
  });

  it('ends joined on the part that goes open where they are drawn; those on the part kept stay put', async () => {
    const { d, c: c0, bends, wire } = await zWire();
    const len = lengthOf([wire.points]);
    const c = addCircuitWire(addCircuitWire(c0, 'w:near', { tail: { on: 'wire', host: 'w:z', at: 24 }, head: { on: 'open', x: 0, y: 2000 } }),
      'w:far', { tail: { on: 'step', step: 's2', y: null }, head: { on: 'wire', host: 'w:z', at: len - 24 } });
    const routes = routeCircuit(c, ctx(d));
    const farAt = endPointOf(routes)('w:far', 'head')!;
    const out = cutWire(c, 'w:z', 'head', routes.find((r) => r.id === 'w:z')!, bends, 3, endPointOf(routes), d.placement);
    expect(out['w:near']!.tail).toEqual({ on: 'wire', host: 'w:z', at: 24 });
    expect(out['w:far']!.head).toEqual({ on: 'open', x: farAt.x, y: farAt.y });
    // cut at the tail instead: the near one goes open, the far one keeps its point (its distance from the new tail)
    const tailCut = cutWire(c, 'w:z', 'tail', routes.find((r) => r.id === 'w:z')!, bends, 3, endPointOf(routes), d.placement);
    expect(tailCut['w:near']!.tail.on).toBe('open');
    const kept = routeOf(d, tailCut, 'w:z').points;
    const end = tailCut['w:far']!.head;
    expect(end.on).toBe('wire');
    expect(lengthOf([kept]) - (end.on === 'wire' ? end.at : 0)).toBeCloseTo(24, 6);
  });

  it('the preview splits the drawn wire at the square: what stays and what goes', async () => {
    const { bends, wire } = await zWire();
    const core = pointsOfShape(wire.core.ends, bends);
    const mid: [number, number] = [(core[3]![0] + core[4]![0]) / 2, (core[3]![1] + core[4]![1]) / 2];
    const head = cutPaths(wire, bends, 'head', 3);
    expect(head.kept).toEqual([...wire.points.slice(0, 4), mid]);
    expect(head.gone).toEqual([mid, ...wire.points.slice(4)]);
    const tail = cutPaths(wire, bends, 'tail', 3);
    expect(tail.gone).toEqual(head.kept);
    expect(tail.kept).toEqual(head.gone);
  });
});

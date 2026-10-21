import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, isFree, plainCircuit, setEnd, shapedByHand, type Circuit } from '../circuit/circuit';
import { endPointOf, routeCircuit } from '../layout/circuitRoute';
import { lengthOf } from '../layout/junctions';
import { pointsOfShape, shapeFromPoints } from '../layout/shape';
import { bendsOf, cutPaths, cutTargets, cutWire, holdDrawn, squareAt, squaresOf } from './cut';
import { circuitOf, EMPTY_DRAFT, resetShape, withCircuit } from './draft';

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

/** Where run square k of a wire is: where a cut there ends it. */
const runAt = (w: Parameters<typeof squaresOf>[0], bends: Parameters<typeof squaresOf>[1], k: number): [number, number] => {
  const s = squaresOf(w, bends, 1).find((q) => q.kind === 'run' && q.k === k)!;
  return [s.x, s.y];
};

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
    // run 3: the horizontal run between the second and third verticals
    const mid = runAt(wire, bends, 3);
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
    const mid = runAt(wire, bends, 1);
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
    const mid = runAt(wire, bends, 3);
    const head = cutPaths(wire, bends, 'head', 3);
    expect(head.kept).toEqual([...wire.points.slice(0, 4), mid]);
    expect(head.gone).toEqual([mid, ...wire.points.slice(4)]);
    const tail = cutPaths(wire, bends, 'tail', 3);
    expect(tail.gone).toEqual(head.kept);
    expect(tail.kept).toEqual(head.gone);
  });
});

describe('a cut keeps what stays exactly where it was drawn (review 2026-10-09)', () => {
  // two entry wires: the hub's automatic tails fan out 8 above and below its centre, off the 15 degree ring points
  const fan = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3'), stepDto('s4')],
  }));
  const plainOf = (d: Doc) => plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));

  it('an entry wire cut at a run square: its automatic hub tail is held at its drawn point, the part kept and a junction on it do not move', async () => {
    const d = await fan();
    const c0 = plainOf(d);
    const before = routeOf(d, c0, 'wf->s1').points;
    const c = addCircuitWire(c0, 'w:j', { tail: { on: 'step', step: 's4', y: 40 }, head: { on: 'wire', host: 'wf->s1', at: 24 } });
    const routes = routeCircuit(c, ctx(d));
    const w = routes.find((r) => r.id === 'wf->s1')!;
    const bends = shapeFromPoints(w.core.points);
    const run = squaresOf(w, bends, 1).find((s) => s.kind === 'run' && s.vertical)!;
    const jAt = routes.find((r) => r.id === 'w:j')!.points.at(-1);
    const out = cutWire(c, 'wf->s1', 'head', w, bends, run.kind === 'run' ? run.k : -1, endPointOf(routes), d.placement);
    const after = routeOf(d, out, 'wf->s1').points;
    expect(after.slice(0, -1)).toEqual(before.slice(0, after.length - 1));
    expect(after.at(-1)).toEqual([run.x, run.y]);
    expect(routeOf(d, out, 'w:j').points.at(-1)).toEqual(jAt);
  });

  it('holding an automatic hub tail keeps it at its drawn point (the open drop of an entry wire\'s head too)', async () => {
    const d = await fan();
    const c = plainOf(d);
    for (const id of ['wf->s1', 'wf->s3']) {
      const p = routeOf(d, c, id).points[0]!;
      const held = holdDrawn(setEnd(c, id, 'head', { on: 'open', x: 900, y: 900 }), id, 'tail', { x: p[0], y: p[1] }, d.placement);
      expect(held[id]!.tail).toEqual({ on: 'hub', angle: null, dy: p[1] - d.placement.sphere.cy });
      expect(routeOf(d, held, id).points[0]).toEqual(p);
    }
  });

  it('a run of odd length is cut on the 8 px grid, and its square is drawn there', async () => {
    const d = await doc();
    const s1 = d.placement.steps.get('s1')!;
    const x0 = s1.x + 224;
    // a vertical run 40 long: its middle is half a grid step off
    const bends = { xs: [x0 + 40], ys: [] };
    const c = addCircuitWire(plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id)), 'w:o',
      { tail: { on: 'step', step: 's1', y: 96 }, head: { on: 'open', x: x0 + 120, y: s1.y + 136 }, bends });
    const w = routeOf(d, c, 'w:o');
    const sq = squaresOf(w, bends, 1).find((s) => s.kind === 'run' && s.vertical)!;
    expect([sq.x % 8, sq.y % 8]).toEqual([0, 0]);
    const out = cutWire(c, 'w:o', 'head', w, bends, sq.kind === 'run' ? sq.k : -1, endPointOf(routeCircuit(c, ctx(d))), d.placement);
    expect(out['w:o']!.head).toEqual({ on: 'open', x: sq.x, y: sq.y });
  });
});

describe('short runs and Reset route after a cut (re-review 2026-10-09)', () => {
  // an open wire leaving left: an 8 px first run, down 8, then left; its run squares must never sit on an end or a corner
  const shortRuns = async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1'), stepDto('s2')] }));
    const c = addCircuitWire(plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id)), 'w:s',
      { tail: { on: 'open', x: 800, y: 800 }, head: { on: 'open', x: 600, y: 900 }, bends: { xs: [792, 640], ys: [808] } });
    return { d, c, w: routeOf(d, c, 'w:s') };
  };

  it('a run square never sits on its run\'s end or a corner; one on a run with no grid point inside it is no cut target, at any zoom', async () => {
    const { c, w } = await shortRuns();
    const pts = pointsOfShape(w.core.ends, c['w:s']!.bends!);
    for (const k of [1, 0.25]) {
      const squares = squaresOf(w, c['w:s']!.bends!, k);
      for (const s of squares) {
        if (s.kind !== 'run') continue;
        const a = pts[s.k]!, b = pts[s.k + 1]!;
        expect([s.x, s.y]).not.toEqual(a);
        expect([s.x, s.y]).not.toEqual(b);
      }
      // the 8 px first run: its square is drawn (zoomed in) for run drags, but an end square cannot cut there
      const first = squares.find((s) => s.kind === 'run' && s.k === 0);
      if (first && first.kind === 'run') expect(first.cuts).toBe(false);
      expect(cutTargets(squares, 'head').some((s) => s.kind === 'run' && s.k === 0)).toBe(false);
      expect(cutTargets(squares, 'head').filter((s) => s.kind === 'end').map((s) => s.kind === 'end' && s.side)).toEqual(['tail']);
    }
    expect(squaresOf(w, c['w:s']!.bends!, 0.25).some((s) => s.kind === 'run' && s.k === 0)).toBe(true);
  });

  it('a cut never leaves a wire of no length: cut on such a run, nothing changes', async () => {
    const { d, c, w } = await shortRuns();
    const out = cutWire(c, 'w:s', 'head', w, c['w:s']!.bends!, 0, endPointOf([w]), d.placement);
    expect(out).toBe(c);
  });

  it('Reset route clears a hub tail held at its height: plain automatic again, and it is offered for that alone', async () => {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1'), stepDto('s2')] }));
    const c = plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
    const held = holdDrawn(setEnd(c, 'wf->s1', 'head', { on: 'open', x: 900, y: 900 }), 'wf->s1', 'tail', { x: 224, y: 168 }, d.placement);
    expect(held['wf->s1']!.tail).toMatchObject({ on: 'hub', dy: expect.any(Number) });
    expect(shapedByHand({ tail: held['wf->s1']!.tail, head: { on: 'open', x: 900, y: 900 } })).toBe(true);
    const draft = withCircuit(EMPTY_DRAFT, d, held);
    const reset = circuitOf(d, resetShape(draft, d, 'wf->s1'))['wf->s1']!;
    expect(reset.tail).toEqual({ on: 'hub', angle: null });
    expect(reset.held).toBeUndefined();
    // reconnected afterwards: plain again
    expect(setEnd(circuitOf(d, resetShape(draft, d, 'wf->s1')), 'wf->s1', 'head', { on: 'step', step: 's1', y: null })['wf->s1']!.tail).toEqual({ on: 'hub', angle: null });
  });
});

describe("a picked wire's ends and dots, as Visio's (plan 10 phase 2)", () => {
  const endOf = (sq: ReturnType<typeof squaresOf>, side: 'tail' | 'head') => sq.find((q) => q.kind === 'end' && q.side === side)!;

  it('an end on a step is glued; an open end is not', async () => {
    const { d, c, bends, wire } = await zWire();
    expect(endOf(squaresOf(wire, bends, 1), 'tail')).toMatchObject({ glued: true });
    expect(endOf(squaresOf(wire, bends, 1), 'head')).toMatchObject({ glued: true });
    const open = setEnd(c, 'w:z', 'head', { on: 'open', x: 1200, y: 600 });
    const w2 = routeOf(d, open, 'w:z');
    expect(endOf(squaresOf(w2, shapeFromPoints(w2.core.points), 1), 'head')).toMatchObject({ glued: false });
  });

  it('an end on another wire (a junction) is glued', async () => {
    const { d, c } = await zWire();
    const host = routeOf(d, c, 's1->s2');
    const joined = setEnd(c, 'w:z', 'head', { on: 'wire', host: 's1->s2', at: Math.round(lengthOf([host.points]) / 2) });
    const w2 = routeOf(d, joined, 'w:z');
    expect(endOf(squaresOf(w2, shapeFromPoints(w2.core.points), 1), 'head')).toMatchObject({ glued: true });
  });

  it("gives the core's corners as bend dots", async () => {
    const { wire, bends } = await zWire();
    const core = pointsOfShape(wire.core.ends, bends);
    expect(bendsOf(wire, bends)).toEqual(core.slice(1, -1).map(([x, y]) => ({ x, y })));
    expect(bendsOf(wire, bends).length).toBeGreaterThanOrEqual(4);
  });
});

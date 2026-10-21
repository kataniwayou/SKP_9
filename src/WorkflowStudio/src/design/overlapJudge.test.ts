import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, moveWire, setBends, setEnd, type Circuit } from '../circuit/circuit';
import type { Pt } from '../layout/router';
import { shapeFromPoints } from '../layout/shape';
import { applyDesign } from './apply';
import { EMPTY_EDITS } from './design';
import { circuitOf, EMPTY_DRAFT, withCircuit } from './draft';
import { overlapJudge } from './overlapJudge';
import { overlapsOf } from '../layout/overlaps';
import { routeCircuit } from '../layout/circuitRoute';

// s1 -> s2 (Completed), s3 -> s4 (Failed); entries s1, s3
const doc = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4', { entryCondition: 2 })],
}));
type Doc = Awaited<ReturnType<typeof doc>>;
const open = { on: 'open', x: 0, y: 0 } as const;
const pointsOf = (d: Doc, id: string) => d.wires.find((w) => w.id === id)!.points;
/** The circuit with a both-open wire `w:f` laid as `path` (as a drag leaves it: its shape its own). */
const laid = (d: Doc, path: Pt[]): Circuit => moveWire(addCircuitWire(circuitOf(d, EMPTY_DRAFT), 'w:f', { tail: open, head: open }), 'w:f', path, () => null);
/** Wire `id` shaped by hand where it is drawn: it stays there. */
const pin = (d: Doc, c: Circuit, id: string): Circuit => {
  const core = d.wires.find((w) => w.id === id)!.core.points;
  const shape = shapeFromPoints(core);
  // a straight wire keeps a one-run shape (as a moved wire does)
  return setBends(c, id, shape.xs.length > 0 ? shape : { xs: [core[0]![0]], ys: [] });
};

describe('overlapJudge (the user\'s rule 2, 2026-10-09)', () => {
  it('a dragged wire laid on a wire of another net is a new short circuit; beside it or across it is not', async () => {
    const d = await doc();
    const judge = overlapJudge(d, 'w:f', circuitOf(d, EMPTY_DRAFT));
    const [[ax, ay], [bx]] = [pointsOf(d, 's1->s2')[0]!, pointsOf(d, 's1->s2').at(-1)!];
    const on: Pt[] = [[ax, ay], [bx, ay]], beside: Pt[] = [[ax, ay + 8], [bx, ay + 8]], across: Pt[] = [[ax + 16, ay - 40], [ax + 16, ay + 40]];
    // s1 -> s2 shaped by hand: it stays (automatic, it would move a track over: the coordinator's ruling)
    expect(judge(on, () => pin(d, laid(d, on), 's1->s2'))).toBe(true);
    expect(judge(on, () => laid(d, on))).toBe(false);
    // a run dragged by hand (strict): on the automatic one too, which is not moved aside (the user's ruling, 2026-10-20)
    expect(overlapJudge(d, 'w:f', circuitOf(d, EMPTY_DRAFT), 'strict')(on, () => laid(d, on))).toBe(true);
    expect(judge(beside, () => laid(d, beside))).toBe(false);
    expect(judge(across, () => laid(d, across))).toBe(false);
  });

  it('a directed wire laid on its own net (joined on that wire) may share its line; direction-less, it may not', async () => {
    const d = await doc();
    // the hub's wire into s1 runs up x = 288 (its stub) from 272 to 128; w:t is joined on that run (104 along: at y 232)
    // and runs up it
    expect(pointsOf(d, 'wf->s1')).toEqual([[224, 272], [288, 272], [288, 128], [352, 128]]);
    const path: Pt[] = [[288, 232], [288, 144], [352, 144]];
    const tap = (head: Circuit[string]['head']): Circuit =>
      addCircuitWire(circuitOf(d, EMPTY_DRAFT), 'w:t', { tail: { on: 'wire', host: 'wf->s1', at: 104 }, head, bends: { xs: [288], ys: [] } });
    // into s1: one net with the hub's wire, one family
    expect(overlapJudge(d, 'w:t', circuitOf(d, EMPTY_DRAFT))(path, () => tap({ on: 'step', step: 's1', y: 112 }))).toBe(false);
    // open at its head: direction-less, in no net
    expect(overlapJudge(d, 'w:t', circuitOf(d, EMPTY_DRAFT))(path, () => tap({ on: 'open', x: 352, y: 144 }))).toBe(true);
  });

  it('a short circuit already there before the drag does not count again', async () => {
    const base = await doc();
    const host = pointsOf(base, 's1->s2');
    const c = pin(base, laid(base, host), 's1->s2');
    const shown = applyDesign(base, withCircuit(EMPTY_DRAFT, base, c), EMPTY_EDITS);
    expect(shown.wires.find((w) => w.id === 'w:f')!.shortWith).toEqual(['s1->s2']);
    // still on s1 -> s2: not new; on s3 -> s4 as well (shaped by hand, so it stays): new
    expect(overlapJudge(shown, 'w:f', c)(host, () => c)).toBe(false);
    expect(overlapJudge(shown, 'w:f', c)([...host, ...pointsOf(shown, 's3->s4')], () => pin(shown, c, 's3->s4'))).toBe(true);
  });

  it('on an automatic wire that can take a free track around the shape it is no short circuit; on a wire shaped by hand it is', async () => {
    const d = await doc();
    // the hub's automatic wire into s1 has an upright run; a both-open wire with an upright run of its own laid on its middle
    const hub = pointsOf(d, 'wf->s1');
    const up = hub.findIndex((p, i) => i > 0 && p[0] === hub[i - 1]![0] && Math.abs(p[1] - hub[i - 1]![1]) >= 64);
    expect(up).toBeGreaterThan(0);
    const x = hub[up]![0], lo = Math.min(hub[up - 1]![1], hub[up]![1]) + 24, hi = Math.max(hub[up - 1]![1], hub[up]![1]) - 24;
    const path: Pt[] = [[x - 40, lo], [x, lo], [x, hi], [x + 40, hi]];
    expect(overlapJudge(d, 'w:f', circuitOf(d, EMPTY_DRAFT))(path, () => laid(d, path))).toBe(false);
    expect(overlapJudge(d, 'w:f', circuitOf(d, EMPTY_DRAFT), 'strict')(path, () => laid(d, path))).toBe(true);
    expect(overlapJudge(d, 'w:f', circuitOf(d, EMPTY_DRAFT))(path, () => pin(d, laid(d, path), 'wf->s1'))).toBe(true);
  });
});

describe('overlapJudge: only a stretch the drag makes counts (re-review 2026-10-09)', () => {
  it('a stretch two wires already shared as drawn (automatic, the router left them there) never refuses a drag of one of them; a new one does', async () => {
    const d = await doc();
    // s3 -> s4 drawn (as the router might leave it) along s1 -> s2's line, both automatic
    const host = pointsOf(d, 's1->s2');
    const shown = { ...d, wires: d.wires.map((w) => (w.id === 's3->s4' ? { ...w, points: host } : w)) };
    // shaped by hand where it is drawn (a run drag's result), s1 -> s2 pinned so it cannot step aside
    const after = pin(d, setBends(circuitOf(d, EMPTY_DRAFT), 's3->s4', { xs: [host[0]![0]], ys: [] }), 's1->s2');
    const judge = overlapJudge(shown, 's3->s4', circuitOf(d, EMPTY_DRAFT));
    expect(judge(host, () => after)).toBe(false);
    // a part of that stretch: still not new
    expect(judge([host[0]!, [host[0]![0] + 16, host[0]![1]]], () => after)).toBe(false);
    // on past the line's end onto nothing: nothing new on any wire
    expect(judge([host[0]!, [host.at(-1)![0] + 64, host[0]![1]], [host.at(-1)![0] + 64, host[0]![1] + 40]], () => after)).toBe(false);
    // onto another wire's line (the hub's, pinned): a new stretch, refused
    const longer = d.wires.find((w) => w.id === 'wf->s1')!.points;
    expect(judge(longer, () => pin(d, after, 'wf->s1'))).toBe(true);
  });
});

describe('overlapJudge: an old stretch is excused only when it was a short circuit or two automatic wires (final check 2026-10-09)', () => {
  it('a bus wire whose head is dragged onto a step of another colour: the stretch it shares with its sibling is a short circuit now, refused', async () => {
    const base = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2', 's3', 's4'] }), stepDto('s2'), stepDto('s3'), stepDto('s4', { entryCondition: 2 })],
    }));
    const P = pointsOf(base, 's1->s2');
    const s1 = base.placement.steps.get('s1')!, s3 = base.placement.steps.get('s3')!;
    // b: out of s1 into s3 (Completed, as s1 -> s2), shaped by hand along s1 -> s2's first runs: a bus, allowed
    const core: Pt[] = [[P[0]![0], P[0]![1]], [P[1]![0], P[0]![1]], [P[1]![0], s3.y + 40], [s3.x, s3.y + 40]];
    let c: Circuit = setBends(circuitOf(base, EMPTY_DRAFT), 's1->s2', shapeFromPoints(P));
    c = addCircuitWire(c, 'b', { tail: { on: 'step', step: 's1', y: P[0]![1] - s1.y }, head: { on: 'step', step: 's3', y: 40 }, bends: shapeFromPoints(core) });
    const shown = applyDesign(base, withCircuit(EMPTY_DRAFT, base, c), EMPTY_EDITS);
    const b = shown.wires.find((w) => w.id === 'b')!;
    expect(overlapsOf(shown.wires).some((o) => [o.a, o.b].includes('b') && [o.a, o.b].includes('s1->s2'))).toBe(true);
    expect(b.short).toBe(false);
    // its head dragged (shape kept) onto s4 (Failed): two colours now
    const after = setEnd(c, 'b', 'head', { on: 'step', step: 's4', y: 40 });
    const drawn = routeCircuit(after, { placement: shown.placement, steps: shown.graph.steps }).find((r) => r.id === 'b')!;
    expect(overlapJudge(shown, 'b', c)(drawn.points, () => after)).toBe(true);
    // onto s3 again (still one colour): allowed
    expect(overlapJudge(shown, 'b', c)(b.points, () => c)).toBe(false);
  });

  it('a wire joined on its trunk and lying along it, its junction end detached: the stretch is a short circuit now, refused', async () => {
    const d = await doc();
    // w:t taps the hub's wire (pinned by hand) on its upright run and runs up it into s1: one net, allowed
    const tap = (tail: Circuit[string]['tail']): Circuit => pin(d, addCircuitWire(circuitOf(d, EMPTY_DRAFT), 'w:t', { tail, head: { on: 'step', step: 's1', y: 112 }, bends: { xs: [248], ys: [] } }), 'wf->s1');
    const joinedC = tap({ on: 'wire', host: 'wf->s1', at: 64 });
    const shown = applyDesign(d, withCircuit(EMPTY_DRAFT, d, joinedC), EMPTY_EDITS);
    const t = shown.wires.find((w) => w.id === 'w:t')!;
    expect(overlapsOf(shown.wires).some((o) => [o.a, o.b].includes('w:t') && [o.a, o.b].includes('wf->s1'))).toBe(true);
    expect(t.short).toBe(false);
    // its tail detached where it is drawn: no longer in the hub wire's net
    const detached = tap({ on: 'open', x: t.points[0]![0], y: t.points[0]![1] });
    expect(overlapJudge(shown, 'w:t', joinedC)(t.points, () => detached)).toBe(true);
    expect(overlapJudge(shown, 'w:t', joinedC)(t.points, () => joinedC)).toBe(false);
  });
});

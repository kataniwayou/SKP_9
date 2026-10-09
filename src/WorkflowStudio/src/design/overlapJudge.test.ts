import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, moveWire, setBends, type Circuit } from '../circuit/circuit';
import type { Pt } from '../layout/router';
import { shapeFromPoints } from '../layout/shape';
import { applyDesign } from './apply';
import { EMPTY_EDITS } from './design';
import { circuitOf, EMPTY_DRAFT, withCircuit } from './draft';
import { overlapJudge } from './overlapJudge';

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
    const judge = overlapJudge(d, 'w:f');
    const [[ax, ay], [bx]] = [pointsOf(d, 's1->s2')[0]!, pointsOf(d, 's1->s2').at(-1)!];
    const on: Pt[] = [[ax, ay], [bx, ay]], beside: Pt[] = [[ax, ay + 8], [bx, ay + 8]], across: Pt[] = [[ax + 16, ay - 40], [ax + 16, ay + 40]];
    // s1 -> s2 shaped by hand: it stays (automatic, it would move a track over: the coordinator's ruling)
    expect(judge(on, () => pin(d, laid(d, on), 's1->s2'))).toBe(true);
    expect(judge(on, () => laid(d, on))).toBe(false);
    expect(judge(beside, () => laid(d, beside))).toBe(false);
    expect(judge(across, () => laid(d, across))).toBe(false);
  });

  it('a directed wire laid on its own net (joined on that wire) may share its line; direction-less, it may not', async () => {
    const d = await doc();
    // the hub's wire into s1 runs up x = 248 from 232 to 128; w:t is joined on that run (64 along: at y 192) and runs up it
    expect(pointsOf(d, 'wf->s1')).toEqual([[224, 232], [248, 232], [248, 128], [288, 128]]);
    const path: Pt[] = [[248, 192], [248, 144], [288, 144]];
    const tap = (head: Circuit[string]['head']): Circuit =>
      addCircuitWire(circuitOf(d, EMPTY_DRAFT), 'w:t', { tail: { on: 'wire', host: 'wf->s1', at: 64 }, head, bends: { xs: [248], ys: [] } });
    // into s1: one net with the hub's wire, one family
    expect(overlapJudge(d, 'w:t')(path, () => tap({ on: 'step', step: 's1', y: 112 }))).toBe(false);
    // open at its head: direction-less, in no net
    expect(overlapJudge(d, 'w:t')(path, () => tap({ on: 'open', x: 288, y: 144 }))).toBe(true);
  });

  it('a short circuit already there before the drag does not count again', async () => {
    const base = await doc();
    const host = pointsOf(base, 's1->s2');
    const c = pin(base, laid(base, host), 's1->s2');
    const shown = applyDesign(base, withCircuit(EMPTY_DRAFT, base, c), EMPTY_EDITS);
    expect(shown.wires.find((w) => w.id === 'w:f')!.shortWith).toEqual(['s1->s2']);
    // still on s1 -> s2: not new; on s3 -> s4 as well (shaped by hand, so it stays): new
    expect(overlapJudge(shown, 'w:f')(host, () => c)).toBe(false);
    expect(overlapJudge(shown, 'w:f')([...host, ...pointsOf(shown, 's3->s4')], () => pin(shown, c, 's3->s4'))).toBe(true);
  });

  it('on an automatic wire that can take a free track around the shape it is no short circuit; on a wire shaped by hand it is', async () => {
    const d = await doc();
    // the hub's automatic wire into s1 has an upright run; a both-open wire with an upright run of its own laid on its middle
    const hub = pointsOf(d, 'wf->s1');
    const up = hub.findIndex((p, i) => i > 0 && p[0] === hub[i - 1]![0] && Math.abs(p[1] - hub[i - 1]![1]) >= 64);
    expect(up).toBeGreaterThan(0);
    const x = hub[up]![0], lo = Math.min(hub[up - 1]![1], hub[up]![1]) + 24, hi = Math.max(hub[up - 1]![1], hub[up]![1]) - 24;
    const path: Pt[] = [[x - 40, lo], [x, lo], [x, hi], [x + 40, hi]];
    expect(overlapJudge(d, 'w:f')(path, () => laid(d, path))).toBe(false);
    expect(overlapJudge(d, 'w:f')(path, () => pin(d, laid(d, path), 'wf->s1'))).toBe(true);
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
    const judge = overlapJudge(shown, 's3->s4');
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

import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, setBends, type Circuit, type End } from '../circuit/circuit';
import { contactOn } from '../layout/circuitRoute';
import { nearestOn } from '../layout/junctions';
import { applyDraft } from './apply';
import { circuitOf, EMPTY_DRAFT, withCircuit, type Draft } from './draft';
import { keepJunctions } from './keepJunctions';

const at = (step: string): End => ({ on: 'step', step, y: null });
const on = (host: string, d: number): End => ({ on: 'wire', host, at: d });

/** s1 (entry) -> s2 drawn as the host; s3's wire joined on it 200 px along. */
async function setup() {
  const d = await loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 2 }), stepDto('s3', { nextStepIds: ['s2'] })],
  }));
  const plain = plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
  const c: Circuit = { ...plain, 's3->s2': { tail: at('s3'), head: on('s1->s2', 200) } };
  const prev = withCircuit(EMPTY_DRAFT, d, c);
  const s2 = d.placement.steps.get('s2')!;
  return { d, prev, s2 };
}
const junctionPoint = (d: Awaited<ReturnType<typeof loadedDocument>>, draft: Draft) => {
  const shown = applyDraft(d, draft);
  const host = shown.wires.find((w) => w.id === 's1->s2')!;
  const end = circuitOf(d, draft)['s3->s2']!.head as { at: number };
  return contactOn(host.points, end.at).p;
};

describe('keepJunctions (the user\'s ruling, 2026-10-20: junctions keep their place on the drawing)', () => {
  it('a host the router draws again keeps each junction at the point nearest where it was, not at its old distance', async () => {
    const { d, prev, s2 } = await setup();
    const before = junctionPoint(d, prev);
    // s2 moved far down: the host s1 -> s2 is drawn again with a long drop
    const next: Draft = { ...prev, steps: { ...prev.steps, s2: { x: s2.x + 320, y: s2.y + 480 } } };
    const slid = junctionPoint(d, next);
    const kept = junctionPoint(d, keepJunctions(d, prev, next));
    expect(Math.hypot(kept[0] - before[0], kept[1] - before[1])).toBeLessThan(Math.hypot(slid[0] - before[0], slid[1] - before[1]));
    // the nearest point of the new line, on the 8 px grid
    const line = applyDraft(d, next).wires.find((w) => w.id === 's1->s2')!.points;
    const nearest = nearestOn([line], before).p;
    expect(Math.hypot(kept[0] - nearest[0], kept[1] - nearest[1])).toBeLessThanOrEqual(8);
  });

  it('a host the commit edits itself carries its junctions along (their distance kept); an unchanged drawing changes nothing', async () => {
    const { d, prev } = await setup();
    expect(keepJunctions(d, prev, prev)).toBe(prev);
    const host = applyDraft(d, prev).wires.find((w) => w.id === 's1->s2')!;
    const shaped = withCircuit(prev, d, setBends(circuitOf(d, prev), 's1->s2', { xs: [host.points[0]![0] + 48], ys: [] }));
    expect(circuitOf(d, keepJunctions(d, prev, shaped))['s3->s2']!.head).toEqual(on('s1->s2', 200));
  });
});

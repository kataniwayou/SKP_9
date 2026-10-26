import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { setEnd } from '../circuit/circuit';
import { contactOn } from '../layout/circuitRoute';
import type { Pt } from '../layout/router';
import { applyDraft } from './apply';
import { carriedAt, carryJoined } from './carry';
import { circuitOf, EMPTY_DRAFT, setShape, withCircuit } from './draft';

describe('rule 3: an end follows whatever it sits on (the user, 2026-10-26)', () => {
  // out, down, along: a junction 300 px along it lies on the level run, 52 px in from its left end
  const host: Pt[] = [[0, 0], [64, 0], [64, 184], [600, 184]];

  it('a junction stays on its run, as far along it: the level run moved down takes it straight down', () => {
    const down: Pt[] = [[0, 0], [64, 0], [64, 264], [600, 264]];
    const at = carriedAt(host, down, 300);
    expect(contactOn(down, at).p).toEqual([120, 264]);
    expect(contactOn(host, 300).p).toEqual([120, 184]);
  });

  it('the host moved whole takes it with it', () => {
    const moved: Pt[] = host.map(([x, y]) => [x + 40, y + 24]);
    expect(contactOn(moved, carriedAt(host, moved, 300)).p).toEqual([160, 208]);
  });

  it('a junction on an upright run moved sideways goes sideways with it', () => {
    const across: Pt[] = [[0, 0], [128, 0], [128, 184], [600, 184]];
    expect(contactOn(across, carriedAt(host, across, 120)).p).toEqual([128, 56]);
  });

  it('the upright before its run moved sideways stretches the run: the junction stays where it is (the user, 2026-10-26)', () => {
    const later: Pt[] = [[0, 0], [104, 0], [104, 184], [600, 184]];
    expect(contactOn(later, carriedAt(host, later, 300)).p).toEqual([120, 184]);
    // so far the run no longer reaches it: kept on the run, at its start
    const past: Pt[] = [[0, 0], [160, 0], [160, 184], [600, 184]];
    expect(contactOn(past, carriedAt(host, past, 300)).p).toEqual([160, 184]);
  });

  it('a host whose runs changed in number keeps it at the nearest point of its new line', () => {
    const jogged: Pt[] = [[0, 0], [64, 0], [64, 96], [200, 96], [200, 184], [600, 184]];
    expect(contactOn(jogged, carriedAt(host, jogged, 300)).p).toEqual([200, 184]);
  });

  const four = () => loadedDocument(graphDto({
    workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
    steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
  }));

  it('a host reshaped by a change carries the end joined on it; an end the change itself moves is left as it put it', async () => {
    const doc = await four();
    const s1 = doc.placement.steps.get('s1')!, s2 = doc.placement.steps.get('s2')!;
    const xs = [s1.x + 256, s2.x - 32];
    // s1 -> s2 dips below both steps; s3 -> s4's head joined halfway along its level run (the third)
    const u = setShape(EMPTY_DRAFT, doc, 's1->s2', { bends: { xs, ys: [s1.y + 320] }, landing: null });
    const line = applyDraft(doc, u).wires.find((w) => w.id === 's1->s2')!.points;
    const along = (pts: readonly Pt[], n: number) => pts.slice(1, n + 1).reduce((d, q, i) => d + Math.abs(q[0] - pts[i]![0]) + Math.abs(q[1] - pts[i]![1]), 0);
    const at = Math.round((along(line, 2) + along(line, 3)) / 2 / 8) * 8;
    const joined = withCircuit(u, doc, setEnd(circuitOf(doc, u), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at }));
    const was = applyDraft(doc, joined).wires.find((w) => w.id === 's3->s4')!.points.at(-1)!;
    // its level run dropped 64 px: the junction goes straight down with it
    const moved = setShape(joined, doc, 's1->s2', { bends: { xs, ys: [s1.y + 384] }, landing: null });
    expect(applyDraft(doc, moved).wires.find((w) => w.id === 's3->s4')!.points.at(-1)![0]).not.toBe(was[0]);
    const carried = carryJoined(doc, joined, moved);
    const now = applyDraft(doc, carried).wires.find((w) => w.id === 's3->s4')!.points.at(-1)!;
    expect(now).toEqual([was[0], was[1] + 64]);
    // the change itself put the end elsewhere: left as it put it
    const placed = withCircuit(moved, doc, setEnd(circuitOf(doc, moved), 's3->s4', 'head', { on: 'wire', host: 's1->s2', at: 24 }));
    expect(carryJoined(doc, joined, placed).wires!['s3->s4']!.head).toEqual({ on: 'wire', host: 's1->s2', at: 24 });
    // nothing joined moved: the change itself
    expect(carryJoined(doc, joined, joined)).toBe(joined);
  });
});

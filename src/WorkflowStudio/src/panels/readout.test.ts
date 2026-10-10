import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import type { StudioDocument } from '../app/document';
import { buildDesignRequest } from '../app/saveDesign';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire, moveWire, setBends, setEnd, type Circuit, type End } from '../circuit/circuit';
import { applyDesign } from '../design/apply';
import { EMPTY_EDITS, setField } from '../design/design';
import { circuitOf, EMPTY_DRAFT, withCircuit, type Draft } from '../design/draft';
import { cornersOf, graphReadout, readoutModel, stepReadout, wireReadout, type ReadoutModel } from './readout';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { shapeFromPoints } from '../layout/shape';

// The Inspector's read-outs (the user's request, 2026-10-09): the drawing as text, from the model the canvas and Save use.
const S1 = 'step-s1_1.0.0-s1', S2 = 'step-s2_1.0.0-s2', S3 = 'step-s3_1.0.0-s3', S4 = 'step-s4_1.0.0-s4';

/** wf -> s1, s1 -> s2; s3 (Completed) and s4 (Failed) on the canvas, unwired (parked). */
const chain = () => loadedDocument(graphDto({
  workflow: workflowDto({ entryStepIds: ['s1'] }),
  steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')],
  layout: { parked: ['s3', 's4'] },
} as never), [stepDto('s3'), stepDto('s4', { entryCondition: 2 })]);

const drafted = (base: StudioDocument, change: (c: Circuit) => Circuit): Draft => withCircuit(EMPTY_DRAFT, base, change(circuitOf(base, EMPTY_DRAFT)));
const model = (base: StudioDocument, draft: Draft = EMPTY_DRAFT, edits = EMPTY_EDITS): ReadoutModel => readoutModel(base, draft, edits);
const rows = (m: ReadoutModel, id: string) => Object.fromEntries(wireReadout(m, id)!.rows.map((r) => [r.label, r.value]));
const pointOf = (m: ReadoutModel) => (id: string, side: 'tail' | 'head') => {
  const pts = m.shown.wires.find((w) => w.id === id)!.points;
  const p = side === 'tail' ? pts[0]! : pts[pts.length - 1]!;
  return { x: p[0], y: p[1] };
};

describe('wireReadout', () => {
  it('a plain wire: both ends on steps (automatic), directed, its condition, the one link it carries, automatic shape', async () => {
    const m = model(await chain());
    expect(wireReadout(m, 's1->s2')!.name).toBe(`${S1} → ${S2}`);
    expect(rows(m, 's1->s2')).toEqual({
      'From (tail)': `step ${S1}, output side (automatic)`,
      'To (head)': `step ${S2}, input side (automatic)`,
      Direction: 'directed',
      Condition: 'Completed',
      Carries: [`${S1} → ${S2}`],
      Shape: 'automatic',
      'Joined on it': 'none',
    });
    expect(wireReadout(m, 'nope')).toBeNull();
  });

  it('a hub tail: automatic, at an angle; it carries the entry link "workflow → step"', async () => {
    const base = await chain();
    expect(rows(model(base), 'wf->s1')).toMatchObject({ 'From (tail)': 'the workflow hub (automatic)', Carries: [`workflow → ${S1}`] });
    const angled = drafted(base, (c) => setEnd(c, 'wf->s1', 'tail', { on: 'hub', angle: 270 }));
    expect(rows(model(base, angled), 'wf->s1')['From (tail)']).toBe('the workflow hub (at 270°)');
  });

  it('an end slid by hand reads "N px down"; an end held while the other is open says so', async () => {
    const base = await chain();
    const slid = drafted(base, (c) => setEnd(c, 's1->s2', 'tail', { on: 'step', step: 's1', y: 40 }));
    expect(rows(model(base, slid), 's1->s2')['From (tail)']).toBe(`step ${S1}, output side (40 px down)`);
    const held: Draft = { ...EMPTY_DRAFT, wires: { 's1->s2': { tail: { on: 'step', step: 's1', y: 32 }, head: { on: 'open', x: 900, y: 40 }, held: 'tail' } } };
    const m = model(base, held);
    expect(rows(m, 's1->s2')).toMatchObject({
      'From (tail)': `step ${S1}, output side (32 px down, held while the other end is open)`,
      'To (head)': 'open (at 900, 40)', Condition: 'undecided', Carries: 'nothing',
    });
  });

  it('fan-out: a tail on a junction reads its host and how far along it; the trunk carries both links and lists what is joined on it', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:x', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's3', y: null } }));
    const m = model(base, draft);
    const x = rows(m, 'w:x');
    // drawn where the canvas draws it: 40 is on the grid and clear of the host's ends
    expect(x['From (tail)']).toBe(`a junction on wire ${S1} → ${S2}, 40 px along it`);
    expect(x.Carries).toEqual([`${S1} → ${S3}`]);
    expect(rows(m, 's1->s2')).toMatchObject({ Carries: [`${S1} → ${S2}`, `${S1} → ${S3}`], 'Joined on it': [`a junction → ${S3}`] });
  });

  it('fan-in: a head on a junction carries its source into the host\'s step; the host carries both', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:y', { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 's1->s2', at: 37 } }));
    const m = model(base, draft);
    // a stored 37 is drawn on the grid: 40
    expect(rows(m, 'w:y')).toMatchObject({ 'To (head)': `a junction on wire ${S1} → ${S2}, 40 px along it`, Condition: 'Completed', Carries: [`${S3} → ${S2}`] });
    expect(rows(m, 's1->s2').Carries).toEqual([`${S1} → ${S2}`, `${S3} → ${S2}`]);
  });

  it('a direction-less wire: "One end" / "Other end", open at its points, no direction, carries nothing', async () => {
    const base = await chain();
    const open: End = { on: 'open', x: 0, y: 0 };
    const draft = drafted(base, (c) => moveWire(addCircuitWire(c, 'w:f', { tail: open, head: open }), 'w:f', [[400, 304], [400, 400], [480, 400]], () => null));
    const r = rows(model(base, draft), 'w:f');
    expect(r).toEqual({
      'One end': 'open (at 400, 304)', 'Other end': 'open (at 480, 400)', Direction: 'no direction (touches no step or hub)',
      Condition: 'undecided', Carries: 'nothing', Shape: 'by hand, 1 corner', 'Joined on it': 'none',
    });
  });

  it('hand-shaped: "by hand, N corners", N the drawn path\'s turns', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => setBends(c, 's1->s2', { xs: [600, 700], ys: [500] }));
    const m = model(base, draft);
    const pts = m.shown.wires.find((w) => w.id === 's1->s2')!.points;
    expect(cornersOf(pts)).toBeGreaterThan(1);
    expect(rows(m, 's1->s2').Shape).toBe(`by hand, ${cornersOf(pts)} corners`);
    expect(cornersOf([[0, 0], [10, 0], [20, 0], [20, 10], [30, 10]])).toBe(2);
  });

  it('a family short circuit: the reason, and each link it carries held back (or kept as BaseApi has it)', async () => {
    const base = await chain();
    // s1's current tapped off s1 -> s2 (Completed) into s4 (Failed): one net, two conditions
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:z', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's4', y: null } }));
    const m = model(base, draft);
    expect(rows(m, 'w:z')).toMatchObject({ Condition: ['short circuit: Completed meets Failed'], Carries: [`${S1} → ${S4} (held back: short circuit)`] });
    expect(rows(m, 's1->s2').Carries).toEqual([`${S1} → ${S2} (kept as BaseApi has it: short circuit)`, `${S1} → ${S4} (held back: short circuit)`]);
  });

  it('an overlap short circuit names the wire it lies on, on both wires', async () => {
    const base = await chain();
    const host = base.wires.find((w) => w.id === 's1->s2')!.points;
    const open: End = { on: 'open', x: 0, y: 0 };
    const draft = drafted(base, (c) => moveWire(addCircuitWire(setBends(c, 's1->s2', { xs: [host[0]![0]], ys: [] }), 'w:f', { tail: open, head: open }), 'w:f', host, () => null));
    const m = model(base, draft);
    expect(rows(m, 's1->s2').Condition).toEqual(['short circuit: overlaps an open end → an open end']);
    expect(rows(m, 'w:f').Condition).toEqual([`short circuit: overlaps ${S1} → ${S2}`]);
    expect(rows(m, 's1->s2').Carries).toEqual([`${S1} → ${S2} (kept as BaseApi has it: short circuit)`]);
  });

  it('a wire whose head was detached carries nothing, and the host of a removed junction lists nothing joined', async () => {
    const base = await chain();
    const m0 = model(base);
    const draft = drafted(base, (c) => setEnd(c, 's1->s2', 'head', { on: 'open', ...pointOf(m0)('s1->s2', 'head') }));
    expect(rows(model(base, draft), 's1->s2')).toMatchObject({ 'To (head)': expect.stringMatching(/^open \(at -?\d+, -?\d+\)$/), Carries: 'nothing', Condition: 'undecided' });
  });
});

describe('graphReadout', () => {
  it('entry steps with their conditions, one row per step by name with Save\'s next steps, problems', async () => {
    const g = graphReadout(model(await chain()));
    expect(g.entries).toEqual([{ id: 's1', name: S1, held: false, condition: 'Completed' }]);
    expect(g.entriesHeldBack).toBe(false);
    expect(g.steps.map((s) => [s.name, s.condition, s.next.map((l) => l.name), s.heldBack])).toEqual([
      [S1, 'Completed', [S2], false], [S2, 'Completed', [], false], [S3, 'Completed', [], false], [S4, 'Failed', [], false],
    ]);
    expect(g.problems).toEqual([{ label: 'Steps with no wires', names: [S3, S4] }]);
  });

  it('none when the drawing has no problem', async () => {
    const base = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    expect(graphReadout(model(base)).problems).toEqual([]);
  });

  it('the rows follow the drawing, and equal the lists Save sends', async () => {
    const base = await chain();
    // fan-out from s1 into s3 through a junction, and the hub feeds s3 too
    const draft = drafted(base, (c) => addCircuitWire(addCircuitWire(c, 'w:x', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's3', y: null } }),
      'w:h', { tail: { on: 'hub', angle: 90 }, head: { on: 'step', step: 's3', y: 64 } }));
    const m = model(base, draft);
    const g = graphReadout(m);
    expect(g.entries.map((l) => l.id)).toEqual(['s1', 's3']);
    expect(g.steps.find((s) => s.id === 's1')!.next.map((l) => l.id)).toEqual(['s2', 's3']);
    const body = buildDesignRequest(base, m.shown, { draft, edits: EMPTY_EDITS });
    expect(body.workflow.entryStepIds).toEqual(g.entries.filter((l) => !l.held).map((l) => l.id));
    for (const s of body.steps) expect(s.nextStepIds).toEqual(g.steps.find((r) => r.id === s.id)!.next.filter((l) => !l.held).map((l) => l.id));
    expect(g.problems).toEqual([{ label: 'Steps with no wires', names: [S4] }]);
  });

  it('a short circuit: the held source keeps BaseApi\'s list, its drawn link is marked held back, listed under problems', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:z', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's4', y: null } }));
    const g = graphReadout(model(base, draft));
    const s1 = g.steps.find((s) => s.id === 's1')!;
    expect(s1.heldBack).toBe(true);
    expect(s1.next).toEqual([{ id: 's2', name: S2, held: false }, { id: 's4', name: S4, held: true }]);
    expect(g.problems).toEqual([
      { label: 'Steps with no wires', names: [S3] },
      { label: 'Short circuits', names: ['short circuit: Completed meets Failed'] },
    ]);
  });

  it('a held hub: entry steps kept as BaseApi has them, the drawn new entry held back', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:z', { tail: { on: 'wire', host: 'wf->s1', at: 40 }, head: { on: 'step', step: 's4', y: null } }));
    const g = graphReadout(model(base, draft));
    expect(g.entriesHeldBack).toBe(true);
    expect(g.entries).toEqual([{ id: 's1', name: S1, held: false, condition: 'Completed' }, { id: 's4', name: S4, held: true, condition: 'Failed' }]);
  });

  it('open and direction-less wires are listed; an Inspector entry-condition edit shows in the rows', async () => {
    const base = await chain();
    const open: End = { on: 'open', x: 0, y: 0 };
    const draft = drafted(base, (c) => moveWire(addCircuitWire(c, 'w:f', { tail: open, head: open }), 'w:f', [[400, 304], [480, 304]], () => null));
    const edits = setField(EMPTY_EDITS, { kind: 'step', id: 's3' }, stepDto('s3'), 'entryCondition', 3, () => 'x');
    const g = graphReadout(model(base, draft, edits));
    expect(g.problems).toEqual([
      { label: 'Steps with no wires', names: [S3, S4] },
      { label: 'Open wires', names: ['an open end → an open end'] },
      { label: 'Direction-less wires', names: ['an open end → an open end'] },
    ]);
    expect(g.steps.find((s) => s.id === 's3')!.condition).toBe('Cancelled');
  });

  it('reads the canvas\'s drawing: the shown document is applyDesign\'s', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => setBends(c, 's1->s2', { xs: [600], ys: [] }));
    expect(model(base, draft).shown).toEqual(applyDesign(base, draft, EMPTY_EDITS));
  });
});

describe('stepReadout', () => {
  it('a step whose processor the design removed reads "none" (2026-10-10)', async () => {
    const base = await chain();
    const draft = { ...EMPTY_DRAFT, blocks: { ...EMPTY_DRAFT.blocks, unassigned: ['s2'] } };
    const m = model(base, draft);
    expect(stepReadout(m, 's2')!.processor).toBeNull();
    expect(stepReadout(m, 's1')!.processor).not.toBeNull();
  });

  const ins = (m: ReadoutModel, id: string) => stepReadout(m, id)!.in.map((l) => [l.id, l.held]);
  const outs = (m: ReadoutModel, id: string) => stepReadout(m, id)!.out.map((l) => [l.id, l.held]);

  it('an entry step: fed by the workflow, its next steps out, its wires counted, nothing flagged', async () => {
    const m = model(await chain());
    expect(stepReadout(m, 's1')).toEqual({
      condition: 'Completed', processor: expect.any(String), in: [{ id: 'wf', name: 'workflow', held: false }], out: [{ id: 's2', name: S2, held: false }],
      heldBack: false, wireCount: 2, flagged: [],
    });
    expect(ins(m, 's2')).toEqual([['s1', false]]);
    expect(stepReadout(m, 'nope')).toBeNull();
  });

  it('a step with no wires: nothing in, nothing out, no wires; its own condition', async () => {
    expect(stepReadout(model(await chain()), 's4')).toEqual({ condition: 'Failed', processor: expect.any(String), in: [], out: [], heldBack: false, wireCount: 0, flagged: [] });
  });

  it('fan-in through a junction: both sources feed the step of the host', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:y', { tail: { on: 'step', step: 's3', y: null }, head: { on: 'wire', host: 's1->s2', at: 40 } }));
    const m = model(base, draft);
    expect(ins(m, 's2')).toEqual([['s1', false], ['s3', false]]);
    expect(outs(m, 's3')).toEqual([['s2', false]]);
    // w:y's head is on a wire, not on s2's side
    expect(stepReadout(m, 's2')!.wireCount).toBe(1);
  });

  it('fan-out through a junction: the source feeds both steps', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:x', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's3', y: null } }));
    const m = model(base, draft);
    expect(outs(m, 's1')).toEqual([['s2', false], ['s3', false]]);
    expect(ins(m, 's3')).toEqual([['s1', false]]);
    expect(stepReadout(m, 's3')!.wireCount).toBe(1);
  });

  it('a short circuit: the source held back (the list BaseApi has kept, the new link held back), its shorted wires flagged', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => addCircuitWire(c, 'w:z', { tail: { on: 'wire', host: 's1->s2', at: 40 }, head: { on: 'step', step: 's4', y: null } }));
    const m = model(base, draft);
    const s1 = stepReadout(m, 's1')!;
    expect(s1.heldBack).toBe(true);
    expect(outs(m, 's1')).toEqual([['s2', false], ['s4', true]]);
    expect(s1.flagged).toEqual([{ id: 's1->s2', name: `${S1} → ${S2}`, notes: ['short circuit'] }]);
    expect(ins(m, 's4')).toEqual([['s1', true]]);
    expect(stepReadout(m, 's4')!.flagged).toEqual([{ id: 'w:z', name: `a junction → ${S4}`, notes: ['short circuit'] }]);
  });

  it('an open wire on its side is flagged; the step it left is no longer fed', async () => {
    const base = await chain();
    const draft = drafted(base, (c) => setEnd(c, 's1->s2', 'head', { on: 'open', x: 900, y: 48 }));
    const m = model(base, draft);
    expect(stepReadout(m, 's1')).toMatchObject({ out: [], wireCount: 2, flagged: [{ id: 's1->s2', name: `${S1} → an open end`, notes: ['open'] }] });
    expect(stepReadout(m, 's2')).toMatchObject({ in: [], wireCount: 0, flagged: [] });
  });

  it('for random designs, the In and Out of every step are exactly the rows of the workflow Graph', async () => {
    let seed = 4242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    for (let trial = 0; trial < 60; trial++) {
      const n = 3 + Math.floor(rnd() * 8);
      const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
      const base = await loadedDocument(graphDto({
        workflow: workflowDto({ entryStepIds: ids.filter((_, i) => i === 0 || rnd() < 0.2) }),
        steps: ids.map((id, i) => stepDto(id, {
          nextStepIds: ids.filter((_, j) => j !== i && rnd() < (j > i ? 0.35 : 0.05)), entryCondition: (1 + Math.floor(rnd() * 2)) as 1 | 2,
        })),
      }));
      let c = circuitOf(base, EMPTY_DRAFT);
      const wires = Object.keys(c);
      for (let k = 0; k < 3 && wires.length > 1; k++) {
        const w = pick(wires), host = pick(wires.filter((x) => x !== w));
        const r = rnd();
        if (r < 0.35) c = setEnd(c, w, 'tail', { on: 'wire', host, at: 40 });
        else if (r < 0.6) c = setEnd(c, w, 'head', { on: 'wire', host, at: 40 });
        else if (r < 0.8) c = setEnd(c, w, 'head', { on: 'open', x: 2000, y: 40 * k });
        else {
          const on = base.wires.find((x) => x.id === host)!;
          const sh = shapeFromPoints(on.core.points);
          if (sh.xs.length > 0) c = setBends(c, host, sh);
          c = moveWire(addCircuitWire(c, `w:f${k}`, { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 0, y: 0 } }), `w:f${k}`, on.points, () => null);
        }
      }
      const m = model(base, withCircuit(EMPTY_DRAFT, base, c));
      const g = graphReadout(m);
      for (const row of g.steps) {
        const s = stepReadout(m, row.id)!;
        expect(s.out, `trial ${trial} ${row.id} out`).toEqual(row.next);
        expect(s.heldBack).toBe(row.heldBack);
        const expected = [
          ...g.entries.filter((l) => l.id === row.id).map((l) => [WORKFLOW_SOURCE, l.held]),
          ...g.steps.flatMap((r) => r.next.filter((l) => l.id === row.id).map((l) => [r.id, l.held])),
        ];
        expect(s.in.map((l) => [l.id, l.held]), `trial ${trial} ${row.id} in`).toEqual(expected);
      }
    }
  }, 60_000);
});

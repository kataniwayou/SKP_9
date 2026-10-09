import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { addCircuitWire, moveWire, setBends, type Circuit } from '../circuit/circuit';
import { applyDesign } from '../design/apply';
import { EMPTY_EDITS } from '../design/design';
import { circuitOf, EMPTY_DRAFT, moveBlocks, withCircuit, type Draft } from '../design/draft';
import { shapeFromPoints } from '../layout/shape';
import { loadedDocument } from './fixtures';
import { buildDesignRequest } from './saveDesign';

// A seeded random workflow (as the review's trials): n steps, forward links often, backward ones rarely, a few entries.
function randomGraph(rnd: () => number) {
  const n = 3 + Math.floor(rnd() * 12);
  const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`);
  const steps = ids.map((id, i) => {
    const next: string[] = [];
    for (let j = 0; j < n; j++) if (j !== i && rnd() < (j > i ? 0.3 : 0.05)) next.push(ids[j]!);
    return stepDto(id, { nextStepIds: next, entryCondition: (1 + Math.floor(rnd() * 3)) as 1 | 2 | 3 });
  });
  return graphDto({ workflow: workflowDto({ entryStepIds: ids.filter((_, i) => i === 0 || rnd() < 0.15) }), steps });
}

describe('Save never removes a link the user did not remove (review 2026-10-09)', () => {
  it('blocks moved, wires shaped by hand where they are, and both-open wires laid on wires: every loaded link is still sent', async () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let trial = 0; trial < 120; trial++) {
      const base = await loadedDocument(randomGraph(rnd));
      const ids = [...base.placement.steps.keys()];
      const kind = trial % 3;
      let draft: Draft = EMPTY_DRAFT;
      // a block moved (only blocks: the draft has no circuit of its own)
      const moved = ids[Math.floor(rnd() * ids.length)]!;
      const p = base.placement.steps.get(moved)!;
      draft = moveBlocks(draft, base, new Map([[moved, { x: p.x + 32 * (1 + Math.floor(rnd() * 3)), y: p.y + 32 * Math.floor(rnd() * 3) }]]));
      if (kind > 0) {
        let c: Circuit = circuitOf(base, draft);
        // some wires shaped by hand where they are drawn
        for (const w of base.wires) if (rnd() < 0.3) { const s = shapeFromPoints(w.core.points); if (s.xs.length > 0) c = setBends(c, w.id, s); }
        // and, half the time, a both-open wire laid exactly on a wire
        if (kind === 2 && base.wires.length > 0) {
          const on = base.wires[Math.floor(rnd() * base.wires.length)]!;
          c = moveWire(addCircuitWire(c, 'w:f', { tail: { on: 'open', x: 0, y: 0 }, head: { on: 'open', x: 0, y: 0 } }), 'w:f', on.points, () => null);
        }
        draft = withCircuit(draft, base, c);
      }
      const shown = applyDesign(base, draft, EMPTY_EDITS);
      const req = buildDesignRequest(base, shown, { draft, edits: EMPTY_EDITS });
      for (const s of req.steps) {
        if (s.nextStepIds === null) continue;
        const lost = base.graph.steps.get(s.id)!.nextStepIds.filter((t) => !s.nextStepIds!.includes(t));
        expect(lost, `trial ${trial} (${['blocks', 'shaped', 'laid on'][kind]}): ${s.id} loses`).toEqual([]);
      }
      if (req.workflow.entryStepIds !== null) {
        expect(base.graph.workflow.entryStepIds.filter((t) => !req.workflow.entryStepIds!.includes(t)), `trial ${trial}: entries lost`).toEqual([]);
      }
    }
  }, 120_000);
});

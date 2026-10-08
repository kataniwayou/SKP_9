import { describe, expect, it } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { addCircuitWire } from '../circuit/circuit';
import { applyDraft } from './apply';
import { storedDesignOf } from './design';
import { circuitOf, EMPTY_DRAFT, setShape, withCircuit } from './draft';
import { layoutOf } from './layoutDesign';

const two = () => loadedDocument(graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));

describe('layoutOf (plan 9 §7)', () => {
  it('writes every block where it is shown, every canvas step as parked, and the whole circuit (version 2)', async () => {
    const base = await two();
    const open = withCircuit(EMPTY_DRAFT, base, addCircuitWire(circuitOf(base, EMPTY_DRAFT), 'w:l1', { tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 900, y: 64 } }));
    const draft = setShape(open, base, 's1->s2', { bends: null, landing: 72 });
    const layout = layoutOf(applyDraft(base, draft), draft);
    expect(layout.v).toBe(2);
    expect([...layout.parked].sort()).toEqual(['s1', 's2']);
    expect(Object.keys(layout.wires)).toEqual(['wf->s1', 's1->s2', 'w:l1']);
    expect(layout.wires['s1->s2']!.head).toEqual({ on: 'step', step: 's2', y: 72 });
    expect(layout.wires['w:l1']).toEqual({ tail: { on: 'step', step: 's1', y: null }, head: { on: 'open', x: 900, y: 64 } });
  });

  it('writes the workflow\'s own wires when the draft has no circuit; the stored design reads them back', async () => {
    const base = await two();
    const layout = layoutOf(base, EMPTY_DRAFT);
    expect(Object.keys(layout.wires)).toEqual(['wf->s1', 's1->s2']);
    expect(storedDesignOf(null, JSON.parse(JSON.stringify(layout))).draft.wires).toEqual(layout.wires);
  });
});

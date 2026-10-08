import { describe, expect, it } from 'vitest';
import { assignmentDto, processorDto, schemaDto, stepDto } from '../api/fixtures';
import {
  createAssignment, EMPTY_DESIGN, EMPTY_EDITS, fieldsOf, hasGraphChanges, parseEdits, removeAssignment, revertEntity,
  parseSlotKey, sameDesign, setField, slotKey, storedDesignOf,
} from './design';
import { EMPTY_DRAFT } from './draft';

/** Hands out the given ids, then `id1`, `id2`, … */
const ids = (...list: string[]) => { let i = 0; return () => list[i++] ?? `id${i}`; };

describe('entity edits (plan 8 §3.2)', () => {
  it('keeps only fields that differ from the base, with an owned entity\'s loaded stamp', () => {
    const base = stepDto('s1', { updatedAt: '2026-10-07T10:00:00Z' });
    let e = setField(EMPTY_EDITS, { kind: 'step', id: 's1' }, base, 'description', 'new', ids());
    expect(e.steps['s1']).toEqual({ updatedAt: '2026-10-07T10:00:00Z', fields: { description: 'new' } });
    e = setField(e, { kind: 'step', id: 's1' }, base, 'description', null, ids());
    expect(e.steps['s1']).toBeUndefined();
  });

  it('gives a shared entity no stamp', () => {
    const e = setField(EMPTY_EDITS, { kind: 'processor', id: 'p1' }, processorDto('p1'), 'name', 'renamed', ids());
    expect(e.processors['p1']).toEqual({ updatedAt: null, fields: { name: 'renamed' } });
  });

  it('keeps a stamp older than the base (from the stored design) even when the fields go back', () => {
    const stored = { ...EMPTY_EDITS, steps: { s1: { updatedAt: '2026-10-01T00:00:00Z', fields: { name: 'x' } } } };
    const e = setField(stored, { kind: 'step', id: 's1' }, stepDto('s1', { name: 'step-s1' }), 'name', 'step-s1', ids());
    expect(e.steps['s1']).toEqual({ updatedAt: '2026-10-01T00:00:00Z', fields: {} });
  });

  it('edits a schema through a background copy: a new id, the original\'s name and version (spec §1.5)', () => {
    const base = schemaDto('sc1', { name: 'cfg', version: '1.2.3', definition: '{"type":"object"}' });
    const target = { kind: 'schema', processorId: 'p1', slot: 'config' } as const;
    const e = setField(EMPTY_EDITS, target, base, 'definition', '{"type":"string"}', ids('copy1'));
    expect(e.schemas['p1:config']).toEqual({ id: 'copy1', name: 'cfg', version: '1.2.3', description: null, definition: '{"type":"string"}' });
    expect(fieldsOf(e, target)).toMatchObject({ name: 'cfg', version: '1.2.3', definition: '{"type":"string"}' });
    // a second edit changes the same copy
    expect(setField(e, target, base, 'description', 'd', ids('copy2')).schemas['p1:config']!.id).toBe('copy1');
    expect(revertEntity(e, target).schemas['p1:config']).toBeUndefined();
  });

  it('creates, updates and deletes a step\'s assignment: one operation per step', () => {
    let e = createAssignment(EMPTY_EDITS, 's1', 'fetch', 'n1');
    expect(e.assignments['s1']).toEqual({ op: 'create', id: 'n1', fields: { name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{}' } });
    e = setField(e, { kind: 'assignment', id: 'n1', stepId: 's1' }, assignmentDto('n1', { stepId: 's1' }), 'payload', '{"a":1}', ids());
    expect(e.assignments['s1']).toMatchObject({ op: 'create', fields: { payload: '{"a":1}' } });
    expect(removeAssignment(e, 's1', undefined).assignments['s1']).toBeUndefined();

    const base = { id: 'a2', updatedAt: '2026-10-07T10:00:00Z' };
    let f = setField(EMPTY_EDITS, { kind: 'assignment', id: 'a2', stepId: 's2' }, assignmentDto('a2', { stepId: 's2', updatedAt: base.updatedAt }), 'payload', '{"b":2}', ids());
    expect(f.assignments['s2']).toEqual({ op: 'update', id: 'a2', updatedAt: base.updatedAt, fields: { payload: '{"b":2}' } });
    f = removeAssignment(f, 's2', base);
    expect(f.assignments['s2']).toEqual({ op: 'delete', id: 'a2', updatedAt: base.updatedAt });
    // created again after a remove: the step's own row is updated to the new values instead
    expect(createAssignment(f, 's2', 'store', 'n2').assignments['s2']).toMatchObject({ op: 'update', id: 'a2', fields: { name: 'store-assignment' } });
  });

  it('tells a design with graph changes from one with only shapes and stamps', () => {
    expect(hasGraphChanges(EMPTY_DESIGN)).toBe(false);
    expect(hasGraphChanges({
      draft: { ...EMPTY_DRAFT, routes: { 'a->b': { bends: null, landing: 40 } }, loose: { l1: { source: 'a', end: { x: 0, y: 0 } } } },
      edits: { ...EMPTY_EDITS, steps: { s1: { updatedAt: 't', fields: {} } } },
    })).toBe(false);
    expect(hasGraphChanges({ draft: { ...EMPTY_DRAFT, next: { s1: [] } }, edits: EMPTY_EDITS })).toBe(true);
    expect(hasGraphChanges({ draft: EMPTY_DRAFT, edits: createAssignment(EMPTY_EDITS, 's1', 'x', 'n') })).toBe(true);
  });

  it('compares designs whatever the order of their keys', () => {
    const a = { draft: { ...EMPTY_DRAFT, next: { s1: ['s2'], s2: [] } }, edits: EMPTY_EDITS };
    const b = { draft: { ...EMPTY_DRAFT, next: { s2: [], s1: ['s2'] } }, edits: EMPTY_EDITS };
    expect(sameDesign(a, b)).toBe(true);
    expect(sameDesign(a, EMPTY_DESIGN)).toBe(false);
  });

  it('reads a session\'s edits back and drops what is malformed', () => {
    const e = parseEdits({
      workflow: { updatedAt: 't', fields: { name: 'x', bad: {} } },
      steps: { s1: 7 },
      assignments: { s1: { op: 'rename', id: 'a' }, s2: { op: 'delete', id: 'a2', updatedAt: 't' } },
      schemas: { 'p1:config': { id: 'c', name: 'n', version: 'v', description: null, definition: '{}' } },
    })!;
    expect(e.workflow).toEqual({ updatedAt: 't', fields: { name: 'x' } });
    expect(e.steps).toEqual({});
    expect(Object.keys(e.assignments)).toEqual(['s2']);
    expect(e.schemas['p1:config']!.id).toBe('c');
    expect(parseEdits('nope')).toBeNull();
  });
});

describe('the stored design (plan 8 §3.1)', () => {
  it('is the server\'s body read back, with wire shapes and loose wires from the layout', () => {
    const d = storedDesignOf({
      workflow: { updatedAt: 'w0', fields: { description: 'd' }, entryStepIds: ['s2'] },
      steps: [{ id: 's1', updatedAt: 's0', fields: {}, nextStepIds: ['s1'] }],
      processors: [{ id: 'p1', fields: { name: 'p' }, slots: { config: 'c1' } }],
      schemas: [{ id: 'c1', name: 'cfg', version: '1.0.0', definition: '{}' }],
      caches: [{ id: 'k1', fields: { root: 'r' } }],
      assignments: [{ op: 'delete', id: 'a1', stepId: 's1', updatedAt: 'a0' }],
    }, { routes: { 's1->s1': { bends: null, landing: 24 } }, loose: { l1: { source: 's1', end: { x: 600, y: 80 } } } });
    expect(d.draft.entries).toEqual(['s2']);
    expect(d.draft.next).toEqual({ s1: ['s1'] });
    expect(d.draft.routes['s1->s1']).toEqual({ bends: null, landing: 24, contact: null });
    expect(d.draft.loose['l1']).toEqual({ source: 's1', end: { x: 600, y: 80 } });
    expect(d.edits.workflow).toEqual({ updatedAt: 'w0', fields: { description: 'd' } });
    expect(d.edits.steps['s1']).toEqual({ updatedAt: 's0', fields: {} });
    expect(d.edits.processors['p1']!.fields).toEqual({ name: 'p' });
    expect(d.edits.schemas['p1:config']).toEqual({ id: 'c1', name: 'cfg', version: '1.0.0', description: null, definition: '{}' });
    expect(d.edits.caches['k1']!.fields).toEqual({ root: 'r' });
    expect(d.edits.assignments['s1']).toEqual({ op: 'delete', id: 'a1', updatedAt: 'a0' });
  });

  it('is only the layout\'s shapes when nothing is stored', () => {
    const d = storedDesignOf(null, { routes: {}, loose: {} });
    expect(hasGraphChanges(d)).toBe(false);
    expect(sameDesign(d, EMPTY_DESIGN)).toBe(true);
  });
});

describe('slot keys', () => {
  it('parseSlotKey is the inverse of slotKey', () => {
    for (const slot of ['input', 'output', 'config'] as const) {
      expect(parseSlotKey(slotKey('3f2b8c1e-0000-4000-8000-000000000001', slot))).toEqual({ processorId: '3f2b8c1e-0000-4000-8000-000000000001', slot });
    }
  });

  it('parseSlotKey is null for a key with no colon or a slot that is not input, output or config', () => {
    expect(parseSlotKey('no-colon')).toBeNull();
    expect(parseSlotKey('p1:bogus')).toBeNull();
    expect(parseSlotKey('p1:')).toBeNull();
  });
});

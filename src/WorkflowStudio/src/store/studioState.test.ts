import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import { assignmentDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { EMPTY_INSPECTOR } from './inspector';
import { addCircuitWire, setEnd } from '../circuit/circuit';
import { circuitOf, EMPTY_DRAFT, withCircuit } from '../design/draft';
import { EMPTY_EDITS } from '../design/design';
import { restoredState } from '../app/session';
import { activeDocument, canSave, designDirty, INITIAL_STATE, inspectorKey, reduce, shownTargetOf, type StudioAction, type StudioState } from './studioState';

const doc = { graph: { workflow: { name: 'wf', version: '1.0.0' } } } as StudioDocument;
const run = (...actions: StudioAction[]): StudioState => actions.reduce(reduce, INITIAL_STATE);
const open = (workflowId: string): StudioAction => ({ type: 'open', workflowId, name: `wf-${workflowId}`, version: '1.0.0' });

describe('reduce', () => {
  it('opens a document as loading, activates it, and keeps the open order', () => {
    const state = run(open('a'), open('b'));
    expect(state.docs.map((d) => [d.workflowId, d.status.kind, d.name])).toEqual([['a', 'loading', 'wf-a'], ['b', 'loading', 'wf-b']]);
    expect(state.activeId).toBe('b');
  });

  it('opening a document that is already open only activates it', () => {
    const state = run(open('a'), open('b'), { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } }, open('a'));
    expect(state.docs).toHaveLength(2);
    expect(state.activeId).toBe('a');
    expect(state.docs[0]!.selection).toEqual({ kind: 'workflow' });
  });

  it('records a load and a failure', () => {
    const state = run(open('a'), open('b'), { type: 'loaded', workflowId: 'a', doc }, { type: 'failed', workflowId: 'b', message: 'Not found.' });
    expect(state.docs[0]!.status).toEqual({ kind: 'ready', doc });
    expect(state.docs[1]!.status).toEqual({ kind: 'failed', message: 'Not found.' });
  });

  it('closing the active document activates the next one, else the previous, else none', () => {
    expect(run(open('a'), open('b'), open('c'), { type: 'activate', workflowId: 'b' }, { type: 'close', workflowId: 'b' }).activeId).toBe('c');
    expect(run(open('a'), open('b'), { type: 'close', workflowId: 'b' }).activeId).toBe('a');
    expect(run(open('a'), { type: 'close', workflowId: 'a' }).activeId).toBeNull();
  });

  it('closing another document keeps the active one', () => {
    const state = run(open('a'), open('b'), { type: 'close', workflowId: 'a' });
    expect(state.activeId).toBe('b');
    expect(state.docs.map((d) => d.workflowId)).toEqual(['b']);
  });

  it('keeps a selection per document', () => {
    const state = run(open('a'), open('b'),
      { type: 'select', workflowId: 'a', selection: { kind: 'step', stepId: 's1' } },
      { type: 'select', workflowId: 'b', selection: { kind: 'cache', cacheId: 'c1' } },
      { type: 'select', workflowId: 'b', selection: null });
    expect(state.docs.map((d) => d.selection)).toEqual([{ kind: 'step', stepId: 's1' }, null]);
  });

  it('returns the same state for an unknown id or an unchanged selection, so nothing re-renders', () => {
    const state = run(open('a'), { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } });
    expect(reduce(state, { type: 'select', workflowId: 'zz', selection: null })).toBe(state);
    expect(reduce(state, { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } })).toBe(state);
    expect(reduce(state, { type: 'close', workflowId: 'zz' })).toBe(state);
    expect(reduce(state, { type: 'activate', workflowId: 'a' })).toBe(state);
    expect(reduce(state, { type: 'loaded', workflowId: 'zz', doc })).toBe(state);
  });

  it('flips the shared show-all switch', () => {
    expect(run({ type: 'toggleDetails' }).showDetails).toBe(true);
    expect(run({ type: 'toggleDetails' }, { type: 'toggleDetails' }).showDetails).toBe(false);
  });
});

describe('activeDocument and inspectorKey', () => {
  it('follow the active document, its load and its selection', () => {
    const loading = run(open('a'));
    const loaded = reduce(loading, { type: 'loaded', workflowId: 'a', doc });
    const selected = reduce(loaded, { type: 'select', workflowId: 'a', selection: { kind: 'step', stepId: 's1' } });

    expect(activeDocument(INITIAL_STATE)).toBeNull();
    expect(activeDocument(selected)?.workflowId).toBe('a');
    expect(inspectorKey(INITIAL_STATE)).toBe('none');
    expect(new Set([inspectorKey(loading), inspectorKey(loaded), inspectorKey(selected)]).size).toBe(3);
    expect(inspectorKey(reduce(selected, { type: 'toggleDetails' }))).toBe(inspectorKey(selected));
  });
});

describe('the Inspector (slice 3b)', () => {
  const opened = () => {
    let s = reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    return s;
  };
  const insp = (s: ReturnType<typeof opened>) => s.docs[0]!.inspector;
  const step = stepDto('s1', { name: 'fetch' });

  it('opens a document with an empty Inspector, and a new selection starts it again', () => {
    let s = reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    expect(s.docs[0]!.inspector).toEqual(EMPTY_INSPECTOR);
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'workflow' } });
    expect(insp(s)).toEqual(EMPTY_INSPECTOR);
  });

  it('drills down and back, leaving what the previous entity held', () => {
    let s = opened();
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'schema', id: 'sc1', slot: 'config', processorId: 'p1' } });
    expect(shownTargetOf(s.docs[0]!)).toEqual({ kind: 'schema', id: 'sc1', slot: 'config', processorId: 'p1' });
    expect(insp(s).saved).toBeNull();
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0 });
    expect(insp(s).trail).toEqual([]);
    expect(shownTargetOf(s.docs[0]!)).toEqual({ kind: 'step', id: 's1' });
  });

  it('drops a read for an entity it no longer shows (review focus 2)', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    expect(insp(s).saved).toBeNull();
  });

  it('a failed re-read keeps the form it had, with why', () => {
    let s = opened();
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: false, message: 'Could not read it.' } });
    // a failed re-read keeps the form it had (spec §8): only the note is new
    expect([insp(s).saved?.key, insp(s).readError]).toEqual(['step:s1', 'Could not read it.']);
  });

  it('a failed read with nothing read before has no form, only why', () => {
    let s = opened();
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: false, message: 'This step no longer exists.' } });
    expect([insp(s).saved, insp(s).readError]).toEqual([null, 'This step no longer exists.']);
  });

  it('the Inspector key changes with the drill-down, so a hidden Inspector glows', () => {
    const s = opened();
    const before = inspectorKey(s);
    expect(inspectorKey(reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } }))).not.toBe(before);
  });
});

describe('designing (plan 4)', () => {
  const opened = async () => reduce(reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }), { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
  const draft = { ...EMPTY_DRAFT, steps: { s1: { x: 8, y: 8 } } };

  it('a selection carries its picks; picks alone keep the Inspector', async () => {
    let s = reduce(await opened(), { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' }, picks: [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }] });
    expect(s.docs[0]!.picks).toHaveLength(2);
    s = reduce(s, { type: 'pick', workflowId: 'wf1', picks: [] });
    expect(s.docs[0]!.selection).toEqual({ kind: 'step', stepId: 's1' });
  });

  it('a design step is undone, redone and discarded; the document is marked while it has a draft', async () => {
    let s = reduce(await opened(), { type: 'design', workflowId: 'wf1', draft, picks: [{ kind: 'node', id: 's1' }] });
    expect(designDirty(s.docs[0]!)).toBe(true);
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(designDirty(s.docs[0]!)).toBe(false);
    s = reduce(s, { type: 'redo', workflowId: 'wf1' });
    expect(s.docs[0]!.design.draft).toEqual(draft);
    s = reduce(s, { type: 'discardDesign', workflowId: 'wf1' });
    expect(designDirty(s.docs[0]!)).toBe(false);
    expect(s.docs[0]!.design.past).toEqual([]);
  });

  it('a pick between nudges ends the run: the next nudge is a step of its own (spec §5.3)', async () => {
    const nudgeA1 = { ...EMPTY_DRAFT, steps: { s1: { x: 8, y: 0 } } };
    const nudgeA2 = { ...EMPTY_DRAFT, steps: { s1: { x: 16, y: 0 } } };
    const nudgeB = { ...nudgeA2, steps: { ...nudgeA2.steps, s2: { x: 8, y: 0 } } };
    let s = reduce(await opened(), { type: 'design', workflowId: 'wf1', draft: nudgeA1, merge: 'nudge' });
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: nudgeA2, merge: 'nudge' });
    expect(s.docs[0]!.design.past).toHaveLength(1);
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's2' } });
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: nudgeB, merge: 'nudge' });
    expect(s.docs[0]!.design.past).toHaveLength(2);
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.design.draft).toEqual(nudgeA2);

    // a pick alone (no Inspector change) ends the run too; an unchanged pick does not
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: nudgeB, merge: 'nudge' });
    expect(reduce(s, { type: 'pick', workflowId: 'wf1', picks: s.docs[0]!.picks })).toBe(s);
    s = reduce(s, { type: 'pick', workflowId: 'wf1', picks: [{ kind: 'node', id: 's1' }] });
    expect(s.docs[0]!.design.merge).toBeNull();
  });
});

describe('undo, redo and Discard design drop picks the document no longer has', () => {
  const ready = async () => {
    const graph = graphDto({ steps: [stepDto('s1', { nextStepIds: ['s2', 's3'] }), stepDto('s2'), stepDto('s3')] });
    return reduce(reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' }),
      { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  };
  const savedOf = (s: StudioState) => (s.docs[0]!.status as { kind: 'ready'; doc: StudioDocument }).doc;

  const withNew = (s: StudioState) => {
    const saved = savedOf(s);
    return withCircuit(EMPTY_DRAFT, saved, addCircuitWire(circuitOf(saved, EMPTY_DRAFT), 'w:n1', { tail: { on: 'step', step: 's2', y: null }, head: { on: 'step', step: 's3', y: null } }));
  };

  it('a new wire picked, then undone: its pick is gone; redo does not bring the pick back, the wire stays pickable', async () => {
    let s = await ready();
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: withNew(s), picks: [{ kind: 'wire', id: 'w:n1' }, { kind: 'node', id: 's1' }] });
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
    s = reduce(s, { type: 'redo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
  });

  it('a wire whose end moved keeps its pick through undo: a wire never changes its id (plan 9)', async () => {
    let s = await ready();
    const saved = savedOf(s);
    const draft = withCircuit(EMPTY_DRAFT, saved, setEnd(circuitOf(saved, EMPTY_DRAFT), 's1->s3', 'tail', { on: 'step', step: 's2', y: null }));
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft, picks: [{ kind: 'wire', id: 's1->s3' }] });
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'wire', id: 's1->s3' }]);
  });

  it('Discard design keeps picks that still exist (saved wires, blocks, the hub)', async () => {
    let s = await ready();
    const picks = [{ kind: 'wire', id: 'wf->s1' }, { kind: 'wire', id: 's1->s2' }, { kind: 'node', id: 'wf' }, { kind: 'node', id: 's3' }] as const;
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: withNew(s), picks: [...picks, { kind: 'wire', id: 'w:n1' }] });
    s = reduce(s, { type: 'discardDesign', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual(picks);
  });

  it('a document that is not ready keeps its picks', () => {
    let s = reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' });
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, next: { s9: [] } }, picks: [{ kind: 'wire', id: 's9->s8' }] });
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'wire', id: 's9->s8' }]);
  });
});

describe('the design (plan 8)', () => {
  const graph = graphDto({
    steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2')],
    assignments: [assignmentDto('a2', { stepId: 's2', updatedAt: '2026-10-07T10:00:00Z' })],
    design: { steps: [{ id: 's1', updatedAt: 't0', fields: { description: 'stored' } }] },
  } as never);
  const loaded = async (s: StudioState = run(open('wf1'))) => reduce(s, { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  const d0 = (s: StudioState) => s.docs[0]!;

  it('loading takes the stored design; it is not dirty, and Save is offered because it is not applied', async () => {
    const s = await loaded();
    expect(d0(s).edits.steps['s1']!.fields).toEqual({ description: 'stored' });
    expect(designDirty(d0(s))).toBe(false);
    expect(canSave(d0(s))).toBe(true);
  });

  it('a restored document keeps its session design when it loads (Review Focus 3)', async () => {
    const session = { version: 1 as const, activeId: 'wf1', showDetails: false, dock: null,
      docs: [{ workflowId: 'wf1', name: 'orders', version: '1.0.0', selection: null, view: null,
        design: { ...EMPTY_DRAFT, next: { s1: [] } }, edits: { ...EMPTY_EDITS, caches: { c9: { updatedAt: null, fields: { root: 'r' } } } } }] };
    const s = await loaded(restoredState(session));
    expect(d0(s).design.draft.next).toEqual({ s1: [] });
    expect(d0(s).edits.caches['c9']).toBeDefined();
    expect(d0(s).stored!.edits.steps['s1']).toBeDefined();
    expect(designDirty(d0(s))).toBe(true);
  });

  it('a restored document that failed, then is retried and loads, still keeps its session design (a refresh keeps everything)', async () => {
    const session = { version: 1 as const, activeId: 'wf1', showDetails: false, dock: null,
      docs: [{ workflowId: 'wf1', name: 'orders', version: '1.0.0', selection: null, view: null, design: { ...EMPTY_DRAFT, next: { s1: [] } } }] };
    let s = reduce(restoredState(session), { type: 'failed', workflowId: 'wf1', message: 'down' });
    s = reduce(s, { type: 'retry', workflowId: 'wf1' });
    expect(d0(s).status.kind).toBe('loading');
    s = await loaded(s);
    expect(d0(s).design.draft.next).toEqual({ s1: [] });
    expect(designDirty(d0(s))).toBe(true);
  });

  it('Discard design returns to the stored design, not to nothing (Review Focus 4)', async () => {
    let s = await loaded();
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, next: { s1: [] } } });
    s = reduce(s, { type: 'discardDesign', workflowId: 'wf1' });
    expect(d0(s).design.draft.next).toEqual({});
    expect(d0(s).edits.steps['s1']!.fields).toEqual({ description: 'stored' });
    expect(designDirty(d0(s))).toBe(false);
  });

  it('a typed field changes the shown entity in the design once its base is read; never while saving', async () => {
    let s = reduce(await loaded(), { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's2' } });
    const edit: StudioAction = { type: 'editField', workflowId: 'wf1', key: 'name', value: 'renamed', copyId: 'c' };
    expect(reduce(s, edit)).toBe(s); // nothing read yet
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s2', result: { ok: true, dto: stepDto('s2') } });
    s = reduce(s, edit);
    expect(d0(s).edits.steps['s2']!.fields).toEqual({ name: 'renamed' });
    expect(designDirty(d0(s))).toBe(true);
    s = reduce(s, { type: 'revertEntity', workflowId: 'wf1' });
    expect(d0(s).edits.steps['s2']).toBeUndefined();
    const saving = reduce(s, { type: 'saving', workflowId: 'wf1' });
    expect(reduce(saving, edit)).toBe(saving);
  });

  it('Create shows the new assignment at once; Remove of the shown one goes back to its step', async () => {
    let s = reduce(await loaded(), { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    s = reduce(s, { type: 'createAssignment', workflowId: 'wf1', stepId: 's1', stepName: 'fetch', id: 'n1' });
    expect(d0(s).edits.assignments['s1']).toMatchObject({ op: 'create', id: 'n1' });
    expect(shownTargetOf(d0(s))).toEqual({ kind: 'assignment', id: 'n1', stepId: 's1' });
    s = reduce(s, { type: 'removeAssignment', workflowId: 'wf1', stepId: 's1' });
    expect(d0(s).edits.assignments['s1']).toBeUndefined();
    expect(shownTargetOf(d0(s))).toEqual({ kind: 'step', id: 's1' });
    // the base's assignment is deleted on Save, with its loaded stamp
    s = reduce(s, { type: 'removeAssignment', workflowId: 'wf1', stepId: 's2' });
    expect(d0(s).edits.assignments['s2']).toEqual({ op: 'delete', id: 'a2', updatedAt: '2026-10-07T10:00:00Z' });
  });

  it('a Save answer: the design read back is the stored one, the session edits go, errors and Output follow the answer', async () => {
    let s = reduce(await loaded(), { type: 'design', workflowId: 'wf1', draft: { ...EMPTY_DRAFT, next: { s1: [] } } });
    s = reduce(s, { type: 'saving', workflowId: 'wf1' });
    expect(canSave(d0(s))).toBe(false);
    const errors = [{ kind: 'step', id: 's1', stage: 'steps', field: 'version', message: 'bad' }];
    const reread = await loadedDocument(graphDto({ ...graph, design: { steps: [{ id: 's1', nextStepIds: [] }] } } as never));
    s = reduce(s, { type: 'saveAnswered', workflowId: 'wf1', at: '2026-10-07T12:00:00Z', applied: false, errors, doc: reread });
    expect(d0(s).saving).toBe(false);
    expect(d0(s).errors).toEqual(errors);
    expect(d0(s).design.draft.next).toEqual({ s1: [] });
    expect(designDirty(d0(s))).toBe(false);
    expect(s.output.at(-1)).toMatchObject({ workflowId: 'wf1', text: 'Saved; not applied: 1 error' });

    s = reduce(s, { type: 'saveAnswered', workflowId: 'wf1', at: '2026-10-07T12:01:00Z', applied: true, errors: [], doc: await loadedDocument(graphDto()) });
    expect(d0(s).errors).toBeNull();
    expect(s.output.at(-1)!.text).toBe('Saved and applied');
    s = reduce(s, { type: 'saveFailed', workflowId: 'wf1', at: '2026-10-07T12:02:00Z', message: 'Network error: down' });
    expect(s.output.at(-1)!.text).toBe('Not saved: Network error: down');
  });
});

describe('opening a design (plan 9 §8)', () => {
  it('a stored plan 7 junction whose meaning differs from the loaded graph is drawn plain on load, and the design is not dirty', async () => {
    const doc4 = await loadedDocument(graphDto({
      workflow: workflowDto({ entryStepIds: ['s1', 's3'] }),
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2'), stepDto('s3', { nextStepIds: ['s4'] }), stepDto('s4')],
      layout: { routes: { 's3->s4': { bends: null, landing: null, contact: { host: 's1->s2', at: 40 } } } },
    } as never));
    const s = run(open('wf1'), { type: 'loaded', workflowId: 'wf1', doc: doc4 });
    const d = s.docs[0]!;
    expect(d.design.draft.wires!['s3->s4']!.head).toEqual({ on: 'step', step: 's4', y: null });
    expect(designDirty(d)).toBe(false);
    expect(canSave(d)).toBe(false);
  });
});

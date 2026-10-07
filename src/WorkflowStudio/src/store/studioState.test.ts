import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { EMPTY_INSPECTOR } from './inspector';
import { addWire, EMPTY_DRAFT, reattach } from '../design/draft';
import { activeDocument, designDirty, INITIAL_STATE, inspectorKey, reduce, shownTargetOf, type StudioAction, type StudioState } from './studioState';

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
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'name', text: 'x', saved: 'fetch' });
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'workflow' } });
    expect(insp(s)).toEqual(EMPTY_INSPECTOR);
  });

  it('drills down and back, leaving what the previous entity held', () => {
    let s = opened();
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'schema', id: 'sc1', slot: 'config' } });
    expect(shownTargetOf(s.docs[0]!)).toEqual({ kind: 'schema', id: 'sc1', slot: 'config' });
    expect(insp(s).saved).toBeNull();
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0 });
    expect(insp(s).trail).toEqual([]);
    expect(shownTargetOf(s.docs[0]!)).toEqual({ kind: 'step', id: 's1' });
  });

  it('keeps an edit until it is typed back to the saved value', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'new', saved: '' });
    expect(insp(s).edits).toEqual({ description: 'new' });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: '', saved: '' });
    expect(insp(s).edits).toEqual({});
  });

  it('drops a read for an entity it no longer shows (review focus 2)', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    expect(insp(s).saved).toBeNull();
  });

  it('a read drops edits that already match what was read; a failed read says why', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'name', text: 'fetch', saved: 'old' });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed', saved: '' });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    expect(insp(s).edits).toEqual({ description: 'typed' });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: false, message: 'Could not read it.' } });
    // a failed re-read keeps the form it had (spec §8): only the note is new
    expect([insp(s).saved?.key, insp(s).readError, insp(s).edits]).toEqual(['step:s1', 'Could not read it.', { description: 'typed' }]);
  });

  it('a failed read with nothing read before has no form, only why', () => {
    let s = opened();
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: false, message: 'This step no longer exists.' } });
    expect([insp(s).saved, insp(s).readError]).toEqual([null, 'This step no longer exists.']);
  });

  it('saved clears only what it sent: text typed during the save stays (review focus 1)', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'sent', saved: '' });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'name', text: 'typed meanwhile', saved: 'fetch' });
    s = reduce(s, { type: 'saved', workflowId: 'wf1', write: 1, key: 'step:s1', sent: { description: 'sent' }, dto: { ...step, description: 'sent' } });
    expect(insp(s)).toMatchObject({ edits: { name: 'typed meanwhile' }, busy: false, failure: null });
    expect(insp(s).saved?.dto).toMatchObject({ description: 'sent' });
  });

  it('a failed save keeps the edits and says why; discard drops both', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'version', text: 'abc', saved: '1.0.0' });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'saveFailed', workflowId: 'wf1', write: 1, failure: { fields: { version: ['Version must be x.y.z.'] }, banner: null } });
    expect(insp(s)).toMatchObject({ edits: { version: 'abc' }, busy: false, failure: { fields: { version: ['Version must be x.y.z.'] } } });
    s = reduce(s, { type: 'discard', workflowId: 'wf1' });
    expect(insp(s)).toMatchObject({ edits: {}, failure: null });
  });

  it('a created assignment replaces the new-assignment form in the trail', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'fetch' } });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'created', workflowId: 'wf1', write: 1, target: { kind: 'assignment', id: 'a9', stepId: 's1' }, sent: {}, dto: { id: 'a9', stepId: 's1' } as never });
    expect(insp(s).trail).toEqual([{ kind: 'assignment', id: 'a9', stepId: 's1' }]);
    expect(insp(s).saved?.key).toBe('assignment:a9');
  });

  it('a created assignment keeps the text typed while it was created (final review 1)', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'fetch' } });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'payload', text: '{"k":1}', saved: '{}' });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed meanwhile', saved: '' });
    s = reduce(s, { type: 'created', workflowId: 'wf1', write: 1, target: { kind: 'assignment', id: 'a9', stepId: 's1' },
      sent: { payload: '{"k":1}' }, dto: { id: 'a9', stepId: 's1', payload: '{"k":1}' } as never });
    expect(insp(s)).toMatchObject({ trail: [{ kind: 'assignment', id: 'a9', stepId: 's1' }], edits: { description: 'typed meanwhile' }, busy: true });
  });

  it('a back carrying a write token applies only while that write is current; a back from the user always applies', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0 });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed', saved: '' });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 2 });
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0, write: 1 });
    expect(insp(s)).toMatchObject({ trail: [{ kind: 'processor', id: 'p1' }], edits: { description: 'typed' }, busy: true, write: 2 });

    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0, write: 2 });
    expect(insp(s)).toEqual(EMPTY_INSPECTOR);
  });

  it('a late saveFailed or created, after the user moved on, changes nothing', () => {
    let s = opened();
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    const moved = s;
    s = reduce(s, { type: 'saveFailed', workflowId: 'wf1', write: 1, failure: { fields: {}, banner: 'late' } });
    expect(s).toBe(moved);
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0 });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'fetch' } });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 2 });
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0 });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'created', workflowId: 'wf1', write: 2, target: { kind: 'assignment', id: 'a9', stepId: 's1' }, sent: {}, dto: { id: 'a9' } as never });
    expect(insp(s)).toMatchObject({ busy: false, write: null, trail: [{ kind: 'processor', id: 'p1' }] });
  });

  it('after created the Inspector stays busy until the link settles; only its own busy false clears it', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'fetch' } });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'created', workflowId: 'wf1', write: 1, target: { kind: 'assignment', id: 'a9', stepId: 's1' }, sent: {}, dto: { id: 'a9' } as never });
    expect(insp(s)).toMatchObject({ busy: true, write: 1 });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: false, write: 2 });
    expect(insp(s).busy).toBe(true);
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: false, write: 1 });
    expect(insp(s).busy).toBe(false);
  });

  it('a link that fails after created still shows its failure on the new assignment', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'fetch' } });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'created', workflowId: 'wf1', write: 1, target: { kind: 'assignment', id: 'a9', stepId: 's1' }, sent: {}, dto: { id: 'a9' } as never });
    s = reduce(s, { type: 'saveFailed', workflowId: 'wf1', write: 1, failure: { fields: {}, banner: 'not linked' } });
    expect(insp(s)).toMatchObject({ busy: false, trail: [{ kind: 'assignment', id: 'a9', stepId: 's1' }], failure: { banner: 'not linked' } });
  });

  it('a late back from a remove, after the user left and re-opened the same assignment and typed, leaves the edits', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0 });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed', saved: '' });
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0, write: 1 });
    expect(insp(s)).toMatchObject({ trail: [{ kind: 'assignment', id: 'a1', stepId: 's1' }], edits: { description: 'typed' }, busy: false });
  });

  it('a late saved or saveFailed from an earlier write does not clear the busy flag of a newer write', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'first', saved: '' });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 1 });
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'workflow' } });
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'second', saved: '' });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true, write: 2 });
    s = reduce(s, { type: 'saveFailed', workflowId: 'wf1', write: 1, failure: { fields: {}, banner: 'late' } });
    expect(insp(s)).toMatchObject({ busy: true, write: 2, failure: null, edits: { description: 'second' } });
    s = reduce(s, { type: 'saved', workflowId: 'wf1', write: 1, key: 'step:s1', sent: { description: 'second' }, dto: { ...step, description: 'first' } });
    expect(insp(s)).toMatchObject({ busy: true, write: 2, saved: null, edits: { description: 'second' } });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: false, write: 1 });
    expect(insp(s).busy).toBe(true);
    s = reduce(s, { type: 'saved', workflowId: 'wf1', write: 2, key: 'step:s1', sent: { description: 'second' }, dto: { ...step, description: 'second' } });
    expect(insp(s)).toMatchObject({ busy: false, edits: {}, failure: null });
  });

  it('a refreshed document takes the new graph and name, keeping its Inspector; retry reloads a failed one', async () => {
    let s = opened();
    s = reduce(s, { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'kept', saved: '' });
    const renamed = await loadedDocument(graphDto({ workflow: workflowDto({ name: 'renamed', version: '2.0.0' }) }));
    s = reduce(s, { type: 'refreshed', workflowId: 'wf1', doc: renamed });
    expect([s.docs[0]!.name, s.docs[0]!.version, insp(s).edits]).toEqual(['renamed', '2.0.0', { description: 'kept' }]);

    s = reduce(s, { type: 'failed', workflowId: 'wf1', message: 'down' });
    s = reduce(s, { type: 'refreshed', workflowId: 'wf1', doc: renamed });
    expect(s.docs[0]!.status.kind).toBe('failed');            // only a ready document is refreshed
    s = reduce(s, { type: 'retry', workflowId: 'wf1' });
    expect(s.docs[0]!.status.kind).toBe('loading');
    expect(insp(s).edits).toEqual({ description: 'kept' });   // a failed document keeps its draft (spec §6.1)
  });

  it('the Inspector key changes with the drill-down, so a hidden Inspector glows', () => {
    const s = opened();
    const before = inspectorKey(s);
    expect(inspectorKey(reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } }))).not.toBe(before);
  });
});

describe('designing (plan 4)', () => {
  const opened = () => reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'a', version: '1' });
  const draft = { ...EMPTY_DRAFT, steps: { s1: { x: 8, y: 8 } } };

  it('a selection carries its picks; picks alone keep the Inspector', () => {
    let s = reduce(opened(), { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' }, picks: [{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }] });
    expect(s.docs[0]!.picks).toHaveLength(2);
    s = reduce(s, { type: 'pick', workflowId: 'wf1', picks: [] });
    expect(s.docs[0]!.selection).toEqual({ kind: 'step', stepId: 's1' });
  });

  it('a design step is undone, redone and discarded; the document is marked while it has a draft', () => {
    let s = reduce(opened(), { type: 'design', workflowId: 'wf1', draft, picks: [{ kind: 'node', id: 's1' }] });
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

  it('a pick between nudges ends the run: the next nudge is a step of its own (spec §5.3)', () => {
    const nudgeA1 = { ...EMPTY_DRAFT, steps: { s1: { x: 8, y: 0 } } };
    const nudgeA2 = { ...EMPTY_DRAFT, steps: { s1: { x: 16, y: 0 } } };
    const nudgeB = { ...nudgeA2, steps: { ...nudgeA2.steps, s2: { x: 8, y: 0 } } };
    let s = reduce(opened(), { type: 'design', workflowId: 'wf1', draft: nudgeA1, merge: 'nudge' });
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

  it('a new wire picked, then undone: its pick is gone; redo does not bring the pick back, the wire stays pickable', async () => {
    let s = await ready();
    const draft = addWire(EMPTY_DRAFT, savedOf(s), 's2', 's3');
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft, picks: [{ kind: 'wire', id: 's2->s3' }, { kind: 'node', id: 's1' }] });
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
    s = reduce(s, { type: 'redo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([{ kind: 'node', id: 's1' }]);
  });

  it('a re-attached wire picked, then undone: its pick is gone and the saved wire is not picked', async () => {
    let s = await ready();
    const draft = reattach(EMPTY_DRAFT, savedOf(s), 's1->s3', 'source', 's2');
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft, picks: [{ kind: 'wire', id: 's2->s3' }] });
    s = reduce(s, { type: 'undo', workflowId: 'wf1' });
    expect(s.docs[0]!.picks).toEqual([]);
  });

  it('Discard design keeps picks that still exist (saved wires, blocks, the hub)', async () => {
    let s = await ready();
    const picks = [{ kind: 'wire', id: 'wf->s1' }, { kind: 'wire', id: 's1->s2' }, { kind: 'node', id: 'wf' }, { kind: 'node', id: 's3' }] as const;
    const draft = addWire(EMPTY_DRAFT, savedOf(s), 's2', 's3');
    s = reduce(s, { type: 'design', workflowId: 'wf1', draft, picks: [...picks, { kind: 'wire', id: 's2->s3' }] });
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

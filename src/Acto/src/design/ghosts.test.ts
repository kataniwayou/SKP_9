import { describe, expect, it } from 'vitest';
import { createOutputStore } from '../output/outputStore';
import type { BoardState, Edit } from './board';
import { board } from './boardFixtures';
import { createBoardStore } from './boardStore';
import { changedKeys } from './changes';
import { addStep, deleteSteps, withoutWorkflow } from './edits';
import { createGhostStore, keepGhosts, placeIn, restoreGhosts, type GhostItem } from './ghosts';
import { memoryStorage } from '../test/memoryStorage';

/** board() with two entries in every link array, the first of each being the one the tests delete. */
function twoEach(): BoardState {
  const b = board();
  const T = b.steps.fetch!.updatedAt;
  return {
    ...b,
    steps: { ...b.steps, fetch: { ...b.steps.fetch!, nextStepIds: ['expand', 'lonely'] } },
    caches: { ...b.caches, c2: { ...b.caches.c1!, id: 'c2', name: 'c2' } },
    assignments: { ...b.assignments, 'a-daily-lonely': { ...b.assignments['a-daily-fetch']!, id: 'a-daily-lonely', stepId: 'lonely', updatedAt: T } },
    workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: ['expand', 'lonely'], assignmentIds: ['a-daily-expand', 'a-daily-lonely'], cacheIds: ['c1', 'c2'] } },
  };
}
const withExpandAssignment = (b: BoardState): BoardState => ({
  ...b, assignments: { 'a-daily-expand': { ...b.assignments['a-daily-fetch']!, id: 'a-daily-expand', stepId: 'expand' }, ...b.assignments },
});

const make = (start: BoardState = board()) => {
  const out = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(out, null);
  store.load(start);
  const ghosts = createGhostStore(store);
  return { store, ghosts, out };
};
const keys = (g: { ghosts(): GhostItem[] }) => g.ghosts().map((x) => x.key).sort();
const stateOf = (e: Edit): BoardState => { if ('refused' in e) throw new Error(e.refused); return e.state; };

describe('ghost store', () => {
  it('deleting a step leaves ghosts for it, its wires and its entry arrows', () => {
    const { store, ghosts } = make();
    expect(ghosts.ghosts()).toEqual([]);
    store.edit((b) => deleteSteps(b, ['fetch']));
    expect(keys(ghosts)).toEqual(['entry:daily:fetch', 'entry:hourly:fetch', 'step:fetch', 'wire:fetch:expand'].sort());
    expect(ghosts.get('wire:fetch:expand')).toEqual({ key: 'wire:fetch:expand', kind: 'wire', from: 'fetch', to: 'expand', condition: 1 });
    expect(ghosts.get('step:fetch')).toMatchObject({ kind: 'step', row: board().steps.fetch });
  });

  it('undo of the delete removes the ghosts', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['fetch']));
    store.undo();
    expect(ghosts.ghosts()).toEqual([]);
  });

  it('returns the same array until something changes, and notifies only on a change', () => {
    const { store, ghosts } = make();
    let calls = 0;
    ghosts.subscribe(() => { calls++; });
    store.edit((b) => deleteSteps(b, ['lonely']));
    const first = ghosts.ghosts();
    expect(calls).toBe(1);
    store.edit((b) => ({ ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, name: 'x' } } }));
    expect(ghosts.ghosts()).toBe(first);
    expect(calls).toBe(1);
  });

  it('remove hides a ghost; a removed ghost comes back on a new delete', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['lonely']));
    expect(keys(ghosts)).toEqual(['step:lonely']);
    ghosts.remove(['step:lonely']);
    expect(ghosts.ghosts()).toEqual([]);
    store.undo();
    expect(ghosts.ghosts()).toEqual([]);
    store.redo();
    expect(keys(ghosts)).toEqual(['step:lonely']);
  });

  it('remap keeps a saved create from becoming a ghost', () => {
    const { store, ghosts } = make();
    const p = board().processors.p1!;
    store.edit((b) => addStep(b, p, { x: 1, y: 1 }, 'tmp1'));
    ghosts.remap({ tmp1: 'real1' });
    const saved = board();
    store.saved({ ...saved, steps: { ...saved.steps, real1: { ...store.state().steps.tmp1!, id: 'real1', updatedAt: 'T9' } } });
    expect(ghosts.ghosts()).toEqual([]);
  });

  it('remap renames the ids inside a recorded snapshot', () => {
    const { store, ghosts } = make();
    const p = board().processors.p1!;
    store.edit((b) => addStep(b, p, { x: 1, y: 1 }, 'tmp1'));
    store.edit((b) => ({ ...b, steps: { ...b.steps, tmp1: { ...b.steps.tmp1!, nextStepIds: ['tmp2'] }, tmp2: { ...b.steps.lonely!, id: 'tmp2', updatedAt: null } } }));
    store.edit((b) => deleteSteps(b, ['tmp1', 'tmp2']));
    ghosts.remap({ tmp1: 'real1', tmp2: 'real2' });
    expect(keys(ghosts)).toEqual(['step:real1', 'step:real2', 'wire:real1:real2']);
    expect(ghosts.get('step:real1')).toMatchObject({ row: { id: 'real1', nextStepIds: ['real2'] } });
    expect(ghosts.get('wire:real1:real2')).toMatchObject({ from: 'real1', to: 'real2' });
  });

  it('a workflow dropped by dropWorkflow is a ghost with its assignments', () => {
    const { store, ghosts } = make();
    store.dropWorkflow('daily');
    const g = ghosts.get('workflow:daily');
    expect(g).toMatchObject({ kind: 'workflow', row: board().workflows.daily });
    expect(g?.kind === 'workflow' && g.assignments).toEqual([board().assignments['a-daily-fetch']]);
    expect(keys(ghosts)).toEqual(['cacheLink:daily:c1', 'entry:daily:fetch', 'workflow:daily']);
  });

  it('ghosts are not in the store state', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['lonely']));
    expect(ghosts.ghosts().length).toBe(1);
    expect(store.state().steps.lonely).toBeUndefined();
  });
});

describe('ghosts in storage [user, 2026-11-23: they belong to the draft]', () => {
  const fresh = (storage: Storage, start: BoardState = board()) => {
    const out = createOutputStore(null, () => '00:00:00');
    const store = createBoardStore(out, null);
    const ghosts = createGhostStore(store, storage);
    keepGhosts(ghosts, storage);
    store.load(start);
    return { store, ghosts };
  };
  it('ghosts are written to storage and come back in a new store over the same storage', () => {
    const storage = memoryStorage();
    const a = fresh(storage);
    a.store.edit((b) => deleteSteps(b, ['lonely']));
    expect(keys(a.ghosts)).toEqual(['step:lonely']);
    const without = { ...board(), steps: { fetch: board().steps.fetch, expand: board().steps.expand } };
    const b = fresh(storage, without);
    expect(keys(b.ghosts)).toEqual(['step:lonely']);
    expect(b.ghosts.get('step:lonely')).toMatchObject({ kind: 'step', row: board().steps.lonely });
  });
  it('a stored ghost whose item is on the board again is not a ghost', () => {
    const storage = memoryStorage();
    fresh(storage).store.edit((b) => deleteSteps(b, ['lonely']));
    expect(keys(fresh(storage).ghosts)).toEqual([]);
  });
  it('Remove drops a ghost from storage', () => {
    const storage = memoryStorage();
    const a = fresh(storage);
    a.store.edit((b) => deleteSteps(b, ['lonely']));
    a.ghosts.remove(['step:lonely']);
    const without = { ...board(), steps: { fetch: board().steps.fetch, expand: board().steps.expand } };
    expect(keys(fresh(storage, without).ghosts)).toEqual([]);
  });
  it('only the kept store writes: a second store over the same board (React StrictMode makes one) never overwrites a Remove', () => {
    const storage = memoryStorage();
    const out = createOutputStore(null, () => '00:00:00');
    const store = createBoardStore(out, null);
    createGhostStore(store, storage); // the discarded twin: never kept
    const kept = createGhostStore(store, storage);
    keepGhosts(kept, storage);
    store.load(board());
    store.edit((b) => deleteSteps(b, ['lonely']));
    kept.remove(['step:lonely']);
    store.edit((b) => ({ ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, name: 'daily-2' } } }));
    const without = { ...board(), steps: { fetch: board().steps.fetch, expand: board().steps.expand } };
    expect(keys(fresh(storage, without).ghosts)).toEqual([]);
  });
  it('a ghost write that fails says so once in Output (the draft does the same) [review minor]', () => {
    const out = createOutputStore(null, () => '00:00:00');
    const store = createBoardStore(out, null);
    const full = { ...memoryStorage(), setItem: () => { throw new Error('QuotaExceededError'); } } as unknown as Storage;
    const ghosts = createGhostStore(store, null);
    keepGhosts(ghosts, full, out);
    store.load(board());
    store.edit((b) => deleteSteps(b, ['lonely']));
    store.edit((b) => deleteSteps(b, ['expand']));
    const warned = out.lines().filter((l) => l.text.startsWith('Ghosts are no longer kept across refresh'));
    expect(warned).toHaveLength(1);
  });
  it('unreadable stored ghosts are no ghosts', () => {
    const storage = memoryStorage({ 'acto.ghosts': '{not json' });
    expect(keys(fresh(storage).ghosts)).toEqual([]);
  });
});

describe('restoreGhosts', () => {
  it('restore of an unsaved delete makes the row unchanged', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['expand']));
    const after = stateOf(restoreGhosts(store.state(), store.base(), ghosts.ghosts()));
    expect(changedKeys(store.base(), after)).toEqual(new Set());
  });

  it('a restored step brings its assignments back into the workflows that linked them', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['fetch']));
    const after = stateOf(restoreGhosts(store.state(), store.base(), ghosts.ghosts()));
    expect(changedKeys(store.base(), after)).toEqual(new Set());
  });

  it('a restored workflow comes back with its assignments and links', () => {
    const { store, ghosts } = make();
    store.edit((b) => withoutWorkflow(b, 'daily'));
    const after = stateOf(restoreGhosts(store.state(), store.base(), [ghosts.get('workflow:daily')!]));
    expect(changedKeys(store.base(), after)).toEqual(new Set());
  });

  it('restore of a row gone from base is a create', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['lonely']));
    store.saved(store.state());
    const after = stateOf(restoreGhosts(store.state(), store.base(), [ghosts.get('step:lonely')!]));
    expect(after.steps.lonely).toEqual({ ...board().steps.lonely, updatedAt: null, createdAt: null, createdBy: null, updatedBy: null });
  });

  it('a row gone from base is restored with no audit; one base still has keeps its base audit', () => {
    const b0 = board();
    const { store, ghosts } = make({ ...b0, steps: { ...b0.steps,
      lonely: { ...b0.steps.lonely!, createdAt: 'c', createdBy: 'u1', updatedBy: 'u2' },
      expand: { ...b0.steps.expand!, createdAt: 'bc', createdBy: 'bu', updatedBy: 'bv' } } });
    store.edit((b) => deleteSteps(b, ['lonely', 'expand']));
    const base = { ...store.base(), steps: { ...store.base().steps } };
    delete base.steps.lonely;
    const after = stateOf(restoreGhosts(store.state(), base, ghosts.ghosts()));
    expect(after.steps.lonely).toMatchObject({ updatedAt: null, createdAt: null, createdBy: null, updatedBy: null });
    expect(after.steps.expand).toMatchObject({ createdAt: 'bc', createdBy: 'bu', updatedBy: 'bv' });
  });

  it('a restored step drops wires to steps that are not on the board', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['fetch', 'expand']));
    const after = stateOf(restoreGhosts(store.state(), store.base(), [ghosts.get('step:fetch')!]));
    expect(after.steps.fetch!.nextStepIds).toEqual([]);
  });

  it('restoring a wire whose source is a ghost alone is refused with "restore fetch first"', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['fetch']));
    // the missing end is named by its name in the ghost's snapshot (fixture step `fetch` is named fetch-orders)
    expect(restoreGhosts(store.state(), store.base(), [ghosts.get('wire:fetch:expand')!], ghosts.get))
      .toEqual({ refused: 'restore fetch-orders first' });
  });

  it('restoring both together brings both', () => {
    const { store, ghosts } = make();
    store.edit((b) => deleteSteps(b, ['fetch']));
    // wire first in the list: rows are restored before links regardless of order
    const after = stateOf(restoreGhosts(store.state(), store.base(), [ghosts.get('wire:fetch:expand')!, ghosts.get('step:fetch')!]));
    expect(after.steps.fetch!.nextStepIds).toEqual(['expand']);
  });

  it('links come back where they were: deleting the first of two and restoring leaves nothing changed', () => {
    const start = withExpandAssignment(twoEach());
    const { store, ghosts } = make(start);
    store.edit((b) => deleteSteps(b, ['expand']));
    store.edit((b) => ({ ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, cacheIds: ['c2'] } } }));
    const after = stateOf(restoreGhosts(store.state(), store.base(), ghosts.ghosts(), ghosts.get));
    expect(after.steps.fetch!.nextStepIds).toEqual(['expand', 'lonely']);
    expect(after.workflows.daily).toMatchObject({ entryStepIds: ['expand', 'lonely'], assignmentIds: ['a-daily-expand', 'a-daily-lonely'], cacheIds: ['c1', 'c2'] });
    expect(changedKeys(store.base(), after)).toEqual(new Set());
  });

  it('a link restored one at a time also returns to its place', () => {
    const { store, ghosts } = make(withExpandAssignment(twoEach()));
    store.edit((b) => ({ ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, nextStepIds: ['lonely'] } } }));
    const after = stateOf(restoreGhosts(store.state(), store.base(), [ghosts.get('wire:fetch:expand')!]));
    expect(changedKeys(store.base(), after)).toEqual(new Set());
  });

  it('placeIn puts an id before the first one its order places after it', () => {
    expect(placeIn(['b', 'd'], 'a', ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'd']);
    expect(placeIn(['b', 'd'], 'c', ['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd']);
    expect(placeIn(['b', 'x'], 'd', ['a', 'b', 'c', 'd'])).toEqual(['b', 'x', 'd']);
    expect(placeIn(['b'], 'z', ['a', 'b'])).toEqual(['b', 'z']);
    expect(placeIn(['b'], 'a', undefined)).toEqual(['b', 'a']);
  });

  it('an entry arrow comes back when both ends exist', () => {
    const { store, ghosts } = make();
    store.edit((b) => ({ ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: [], cacheIds: [] } } }));
    const after = stateOf(restoreGhosts(store.state(), store.base(), [ghosts.get('entry:daily:fetch')!, ghosts.get('cacheLink:daily:c1')!]));
    expect(changedKeys(store.base(), after)).toEqual(new Set());
  });
});

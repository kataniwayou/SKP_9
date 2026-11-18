import { describe, expect, it } from 'vitest';
import { createOutputStore } from '../output/outputStore';
import { memoryStorage } from '../test/memoryStorage';
import { board } from './boardFixtures';
import { addEntry, deleteSteps, setStepField, setWorkflowField } from './edits';
import { createBoardStore } from './boardStore';
import { boardChanges } from './changes';

const blocked = (): Storage => ({
  get length() { return 0; }, clear() { throw new Error('blocked'); }, key() { throw new Error('blocked'); },
  getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); },
});
const make = (session: Storage | null = memoryStorage()) => {
  const out = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(out, session);
  store.load(board());
  return { store, out, session };
};
const nameA = (n: string) => (b: ReturnType<typeof board>) => setWorkflowField(b, 'daily', 'name', n);
const nameB = (n: string) => (b: ReturnType<typeof board>) => setWorkflowField(b, 'hourly', 'name', n);

describe('board store', () => {
  it('keeps one history across workflows', () => {
    const { store } = make();
    store.edit(nameA('A')); store.edit(nameB('B'));
    expect(store.canUndo()).toBe(true);
    store.undo(); store.undo();
    expect(store.state()).toEqual(board());
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(store.state().workflows.daily!.name).toBe('A');
    expect(store.canRedo()).toBe(true);
  });
  it('merges edits with the same key into one step', () => {
    const { store } = make();
    store.edit(nameA('A'), 'name'); store.edit(nameA('AB'), 'name'); store.edit(nameA('ABC'), 'name');
    store.undo();
    expect(store.state()).toEqual(board());
  });
  it('counts the changed rows as unsaved', () => {
    const { store } = make();
    expect(store.unsaved().size).toBe(0);
    store.edit(nameA('A')); store.edit((b) => setStepField(b, 'lonely', 'name', 'x'));
    expect(store.unsaved().size).toBe(2);
  });
  it('refuses an edit while saving, with a warning', () => {
    const { store, out } = make();
    store.setSaving(true);
    expect(store.saving()).toBe(true);
    store.edit(nameA('A'));
    expect(store.state()).toEqual(board());
    expect(out.lines().at(-1)).toMatchObject({ level: 'warn', text: 'Saving — wait for it to finish' });
    store.setSaving(false);
    store.edit(nameA('A'));
    expect(store.state().workflows.daily!.name).toBe('A');
  });
  it('sends an editOrRefuse refusal to Output', () => {
    const { store, out } = make();
    store.editOrRefuse((b) => addEntry(b, 'daily', 'fetch'));
    expect(store.canUndo()).toBe(false);
    expect(out.lines().at(-1)?.level).toBe('warn');
    store.editOrRefuse((b) => ({ state: setWorkflowField(b, 'daily', 'name', 'Z') }));
    expect(store.state().workflows.daily!.name).toBe('Z');
  });
  it('keeps the draft in the session across a new store', () => {
    const session = memoryStorage();
    const a = make(session).store;
    a.edit(nameA('A')); a.edit(nameB('B')); a.undo();
    const { store } = make(session);
    expect(store.state().workflows.daily!.name).toBe('A');
    expect(store.state().workflows.hourly!.name).toBe('hourly');
    expect(store.canUndo()).toBe(true); expect(store.canRedo()).toBe(true);
    expect(store.base()).toEqual(board());
  });
  it('keeps the draft rows with the stamps they were read with', () => {
    const session = memoryStorage();
    make(session).store.edit(nameA('A'));
    const fresh = board();
    fresh.workflows.hourly = { ...fresh.workflows.hourly!, updatedAt: 'fresher' };
    const store = createBoardStore(createOutputStore(null), session);
    store.load(fresh);
    expect(store.base().workflows.hourly!.updatedAt).toBe('fresher');
    expect(store.state().workflows.daily!.updatedAt).toBe('2026-11-01T00:00:00Z');
    const old = board();
    old.workflows.daily = { ...old.workflows.daily!, updatedAt: 'old' };
    const s2 = memoryStorage();
    const a = createBoardStore(createOutputStore(null), s2); a.load(old); a.edit(nameA('A'));
    const b = createBoardStore(createOutputStore(null), s2); b.load(board());
    expect(b.state().workflows.daily!.updatedAt).toBe('old');
  });
  it('saved clears history and draft', () => {
    const session = memoryStorage();
    const { store } = make(session);
    store.edit(nameA('A')); store.setFailures(new Map([['workflow:daily', 'bad']]));
    const fresh = board(); fresh.workflows.daily = { ...fresh.workflows.daily!, name: 'A' };
    store.saved(fresh);
    expect(store.state()).toBe(fresh); expect(store.base()).toBe(fresh);
    expect(store.canUndo()).toBe(false); expect(store.failures().size).toBe(0);
    expect(session.getItem('acto.board')).toBeNull();
  });
  it('drops a workflow from base and every history state, keeping earlier edits', () => {
    const { store } = make();
    store.edit((b) => deleteSteps(b, ['lonely']));
    store.edit(nameA('A'));
    store.edit((b) => setStepField(b, 'expand', 'name', 'e2'));
    store.undo();
    store.dropWorkflow('daily');
    expect(store.base().workflows.daily).toBeUndefined();
    expect(store.state().workflows.daily).toBeUndefined();
    expect(store.state().steps.lonely).toBeUndefined();
    store.redo();
    expect(store.state().workflows.daily).toBeUndefined();
    expect(store.state().steps.expand!.name).toBe('e2');
    // the rename of the dropped workflow became a no-op step and was merged away
    store.undo();
    expect(store.state().steps.lonely).toBeUndefined();
    store.undo();
    expect(store.state().steps.lonely).toBeDefined();
    expect(store.canUndo()).toBe(false);
  });
  it('never breaks editing on blocked storage', () => {
    const { store, out } = make(blocked());
    store.edit(nameA('A')); store.edit(nameA('B'));
    expect(store.state().workflows.daily!.name).toBe('B');
    store.undo();
    expect(store.state().workflows.daily!.name).toBe('A');
    expect(out.lines().filter((l) => l.level === 'warn').length).toBe(1);
    const again = createBoardStore(createOutputStore(null), blocked());
    expect(() => again.load(board())).not.toThrow();
  });
  it('tracks problems and notifies subscribers', () => {
    const { store } = make();
    let n = 0; const off = store.subscribe(() => n++);
    store.setProblems('daily', 2);
    expect(store.problems('daily')).toBe(2); expect(store.problems('hourly')).toBe(0);
    store.edit(nameA('A'));
    expect(n).toBeGreaterThan(1);
    off();
  });
});

describe('load with a placed present', () => {
  const raw = () => {
    const b = board();
    return { ...b, steps: { ...b.steps, lonely: { ...b.steps.lonely!, at: null } }, caches: { c1: { ...b.caches.c1!, at: null } } };
  };
  const placed = (r: ReturnType<typeof raw>) => ({
    ...r, steps: { ...r.steps, lonely: { ...r.steps.lonely!, at: { x: 900, y: 40 } } }, caches: { c1: { ...r.caches.c1!, at: { x: 10, y: 300 } } },
  });
  it('base stays as read; the placed rows are unsaved, no undo step, and Save sends their locations', () => {
    const store = createBoardStore(createOutputStore(null), memoryStorage());
    const r = raw();
    store.load(r, placed(r));
    expect(store.base()).toBe(r);
    expect([...store.unsaved()].sort()).toEqual(['cache:c1', 'step:lonely']);
    expect(store.canUndo()).toBe(false);
    store.undo();
    expect(store.state().steps.lonely!.at).toEqual({ x: 900, y: 40 });
    const changes = boardChanges(store.base(), store.state());
    expect(changes.find((c) => c.id === 'lonely')!.row).toMatchObject({ boardX: 900, boardY: 40 });
    expect(changes.find((c) => c.id === 'c1')!.row).toMatchObject({ boardX: 10, boardY: 300 });
  });
  it('a restored draft still wins over the placed present', () => {
    const session = memoryStorage();
    const first = createBoardStore(createOutputStore(null), session);
    first.load(board());
    first.edit(nameA('kept'));
    const again = createBoardStore(createOutputStore(null), session);
    const r = raw();
    again.load(r, placed(r));
    expect(again.state().workflows.daily!.name).toBe('kept');
  });
});

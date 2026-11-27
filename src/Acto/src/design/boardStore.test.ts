import { describe, expect, it } from 'vitest';
import { createOutputStore } from '../output/outputStore';
import { memoryStorage } from '../test/memoryStorage';
import { board } from './boardFixtures';
import { addEntry, deleteSteps, removeCacheItem, setCacheItem, setStepField, setWorkflowField } from './edits';
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
const setItem = (b: ReturnType<typeof board>, id: string, k: string, v: string) => { const e = setCacheItem(b, id, k, v); if (!('state' in e)) throw new Error('refused'); return e.state; };
const nameA = (n: string) => (b: ReturnType<typeof board>) => setWorkflowField(b, 'daily', 'name', n);
const nameB = (n: string) => (b: ReturnType<typeof board>) => setWorkflowField(b, 'hourly', 'name', n);

describe('board store', () => {
  it('place changes present and past alike: Undo after place does not bring the old schema position back; canUndo is unchanged', () => {
    const { store, session } = make();
    const sch = (b: ReturnType<typeof board>) => ({
      ...b, schemas: { s1: { id: 's1', name: 's', version: '1', description: null, definition: '{}', audit: b.processors.p1!.audit, at: null, updatedAt: null } },
    });
    store.edit(sch);
    store.edit(nameA('A'));
    const baseBefore = store.base();
    let n = 0;
    store.subscribe(() => { n++; });
    store.place((b) => ({ ...b, schemas: Object.fromEntries(Object.entries(b.schemas).map(([id, s]) => [id, { ...s, at: { x: 1, y: 2 } }])) }));
    expect(n).toBe(1);
    expect(store.base()).toBe(baseBefore);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);
    expect(store.state().schemas.s1!.at).toEqual({ x: 1, y: 2 });
    store.undo();
    expect(store.state().workflows.daily!.name).toBe('daily');
    expect(store.state().schemas.s1!.at).toEqual({ x: 1, y: 2 });
    store.redo();
    expect(store.state().schemas.s1!.at).toEqual({ x: 1, y: 2 });
    expect(session!.getItem('acto.board')).toContain('"x":1');
  });
  it('aDraftWithALegacyCronExpressionLoadsAndSavesWithoutIt', () => {
    const session = memoryStorage();
    const legacy = (b: ReturnType<typeof board>) => ({
      ...b, workflows: Object.fromEntries(Object.entries(b.workflows).map(([id, w]) => [id, { ...w, cronExpression: '0 0 * * * *' }])),
    });
    const edited = setWorkflowField(board(), 'daily', 'name', 'A');
    session.setItem('acto.board', JSON.stringify({ base: legacy(board()), present: legacy(edited) }));
    const { store } = make(session);
    for (const w of [...Object.values(store.state().workflows), ...Object.values(store.base().workflows)]) expect(w).not.toHaveProperty('cronExpression');
    expect(store.state().workflows.daily!.name).toBe('A');
    store.edit(nameB('B'));
    expect(session.getItem('acto.board')).not.toContain('cronExpression');
    expect(JSON.stringify(boardChanges(store.base(), store.state()))).not.toContain('cronExpression');
  });
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
    // undo history is not kept across a reload: only the unsaved board is
    expect(store.canUndo()).toBe(false); expect(store.canRedo()).toBe(false);
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
  it('reads a draft saved before workflows had entryCrons as having none', () => {
    const strip = (b: ReturnType<typeof board>) => ({
      ...b,
      workflows: Object.fromEntries(Object.entries(b.workflows).map(([id, w]) => { const { entryCrons: _drop, ...rest } = w; return [id, rest]; })),
    });
    const base = board();
    const present = nameA('A')(board());
    const session = memoryStorage({ 'acto.board': JSON.stringify({ base: strip(base), present: strip(present) }) });
    const store = createBoardStore(createOutputStore(null), session);
    store.load(board());
    expect(store.state().workflows.daily!.name).toBe('A');
    expect(store.state().workflows.daily!.entryCrons).toEqual({});
    expect(store.base().workflows.daily!.entryCrons).toEqual({});
    expect(() => deleteSteps(store.state(), Object.keys(store.state().steps))).not.toThrow();
  });
  it('draft round-trips item edits', () => {
    const session = memoryStorage();
    const a = make(session).store;
    a.edit((b) => setItem(b, 'c1', 'k1', 'v'));
    a.edit((b) => removeCacheItem(b, 'c1', 'k3', true));
    const { store } = make(session);
    expect(store.state().caches.c1!.itemEdits).toEqual({ set: { k1: 'v' }, removed: ['k3'] });
    expect(store.base().caches.c1!.itemEdits).toEqual({ set: {}, removed: [] });
  });
  it('reads a draft saved before cache items were an overlay as having clean overlays', () => {
    const old = (b: ReturnType<typeof board>) => ({
      ...b,
      caches: Object.fromEntries(Object.entries(b.caches).map(([id, c]) => { const { itemCount: _c, itemEdits: _e, ...rest } = c; return [id, { ...rest, items: '{"a":"1"}' }]; })),
    });
    const present = nameA('A')(board());
    const session = memoryStorage({ 'acto.board': JSON.stringify({ base: old(board()), present: old(present) }) });
    const store = createBoardStore(createOutputStore(null), session);
    store.load(board());
    expect(store.state().workflows.daily!.name).toBe('A');
    expect(store.state().caches.c1).not.toHaveProperty('items');
    expect(store.state().caches.c1!.itemEdits).toEqual({ set: {}, removed: [] });
    expect(store.state().caches.c1!.itemCount).toBe(0);
    expect(store.base().caches.c1!.itemEdits).toEqual({ set: {}, removed: [] });
    expect([...store.unsaved()]).toEqual(['workflow:daily']);
  });
  it('warns once, naming the cache, when an old draft carried unsaved items text', () => {
    const old = (b: ReturnType<typeof board>, items: string) => ({
      ...b,
      caches: Object.fromEntries(Object.entries(b.caches).map(([id, c]) => { const { itemCount: _c, itemEdits: _e, ...rest } = c; return [id, { ...rest, items }]; })),
    });
    const session = memoryStorage({ 'acto.board': JSON.stringify({ base: old(board(), '{"a":"1"}'), present: old(board(), '{"a":"2"}') }) });
    const out = createOutputStore(null, () => '00:00:00');
    const store = createBoardStore(out, session);
    store.load(board());
    const warns = out.lines().filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.text).toBe('c1: unsaved item edits from before the update could not be kept');
    expect(store.state().caches.c1!.itemEdits).toEqual({ set: {}, removed: [] });
  });
  it('does not warn when an old draft\'s items text is unchanged', () => {
    const old = (b: ReturnType<typeof board>) => ({
      ...b,
      caches: Object.fromEntries(Object.entries(b.caches).map(([id, c]) => { const { itemCount: _c, itemEdits: _e, ...rest } = c; return [id, { ...rest, items: '{"a":"1"}' }]; })),
    });
    const session = memoryStorage({ 'acto.board': JSON.stringify({ base: old(board()), present: old(nameA('A')(board())) }) });
    const out = createOutputStore(null, () => '00:00:00');
    createBoardStore(out, session).load(board());
    expect(out.lines().filter((l) => l.level === 'warn')).toHaveLength(0);
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

describe('a restored draft replays only the designer changes onto the fresh read', () => {
  const ops = (s: ReturnType<typeof createBoardStore>) => boardChanges(s.base(), s.state()).map((c) => `${c.op} ${c.table}/${c.id}`);
  const reload = (session: Storage, fresh: ReturnType<typeof board>) => {
    const s = createBoardStore(createOutputStore(null), session);
    s.load(fresh);
    return s;
  };

  it('a row created elsewhere after the draft is never deleted', () => {
    const session = memoryStorage();
    make(session).store.edit(nameA('A'));
    const fresh = board();
    fresh.steps.other = { ...fresh.steps.lonely!, id: 'other', name: 'other', updatedAt: '2026-11-05T00:00:00Z' };
    const store = reload(session, fresh);
    expect(ops(store)).toEqual(['update workflows/daily']);
    expect(store.state().steps.other!.name).toBe('other');
  });

  it('a row changed elsewhere that the designer never touched takes the fresh values and sends nothing', () => {
    const session = memoryStorage();
    make(session).store.edit(nameA('A'));
    const fresh = board();
    fresh.workflows.hourly = { ...fresh.workflows.hourly!, name: 'renamed-elsewhere', updatedAt: 'fresher' };
    fresh.steps.expand = { ...fresh.steps.expand!, name: 'e-elsewhere', updatedAt: 'fresher' };
    const store = reload(session, fresh);
    expect(ops(store)).toEqual(['update workflows/daily']);
    expect(store.state().workflows.hourly!.name).toBe('renamed-elsewhere');
    expect(store.state().steps.expand!.name).toBe('e-elsewhere');
  });

  it('a row the designer changed keeps their version with the stamp the draft read (also changed elsewhere: a 409 from BaseAPI)', () => {
    const session = memoryStorage();
    make(session).store.edit(nameA('A'));
    const fresh = board();
    fresh.workflows.daily = { ...fresh.workflows.daily!, description: 'elsewhere', updatedAt: 'fresher' };
    const store = reload(session, fresh);
    const c = boardChanges(store.base(), store.state());
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ op: 'update', table: 'workflows', id: 'daily', updatedAt: '2026-11-01T00:00:00Z' });
    expect(store.state().workflows.daily!.name).toBe('A');
  });

  it('a row the designer deleted stays deleted with the stamp the draft read; a created row is added', () => {
    const session = memoryStorage();
    const a = make(session).store;
    a.edit((b) => deleteSteps(b, ['lonely']));
    a.edit((b) => ({ ...b, caches: { ...b.caches, n1: { ...b.caches.c1!, id: 'n1', name: 'new-cache-1', root: 'n', updatedAt: null } } }));
    const fresh = board();
    fresh.steps.lonely = { ...fresh.steps.lonely!, updatedAt: 'fresher' };
    const store = reload(session, fresh);
    const c = boardChanges(store.base(), store.state());
    expect(c.map((x) => `${x.op} ${x.table}/${x.id}`)).toEqual(['create caches/n1', 'delete steps/lonely']);
    expect(c.find((x) => x.id === 'lonely')!.updatedAt).toBe('2026-11-01T00:00:00Z');
    expect(store.state().steps.lonely).toBeUndefined();
  });

  it('a row the designer deleted that is gone from the fresh read too is left alone', () => {
    const session = memoryStorage();
    make(session).store.edit((b) => deleteSteps(b, ['lonely']));
    const fresh = board();
    delete fresh.steps.lonely;
    expect(ops(reload(session, fresh))).toEqual([]);
  });

  it('the draft holds the base and the present, not the history', () => {
    const session = memoryStorage();
    const { store } = make(session);
    for (let i = 0; i < 5; i++) store.edit(nameA(`A${i}`));
    const d = JSON.parse(session.getItem('acto.board')!);
    expect(Object.keys(d).sort()).toEqual(['base', 'present']);
    expect(d.present.workflows.daily.name).toBe('A4');
    expect(d.base.workflows.daily.name).toBe('daily');
  });

  it('a draft of the old shape (no base) is not restored and is removed', () => {
    const session = memoryStorage({ 'acto.board': JSON.stringify({ past: [], present: { ...board(), workflows: {} }, future: [] }) });
    const { store } = make(session);
    expect(Object.keys(store.state().workflows).sort()).toEqual(['daily', 'hourly']);
    expect(session.getItem('acto.board')).toBeNull();
  });

  it('a clean board writes no draft: after load, after undo back to clean, and after a delete leaves it clean', () => {
    const session = memoryStorage();
    const { store } = make(session);
    expect(session.getItem('acto.board')).toBeNull();
    store.edit(nameA('A'));
    expect(session.getItem('acto.board')).not.toBeNull();
    store.undo();
    expect(session.getItem('acto.board')).toBeNull();
    store.edit(nameA('A'));
    store.dropWorkflow('daily');
    expect(store.unsaved().size).toBe(0);
    expect(session.getItem('acto.board')).toBeNull();
  });

  it('a draft write that fails removes the stale draft and warns once', () => {
    const inner = memoryStorage();
    let full = false;
    const flaky: Storage = { ...inner, get length() { return inner.length; },
      getItem: (k) => inner.getItem(k), removeItem: (k) => inner.removeItem(k), key: (i) => inner.key(i), clear: () => inner.clear(),
      setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); inner.setItem(k, v); } };
    const { store, out } = make(flaky);
    store.edit(nameA('A'));
    expect(inner.getItem('acto.board')).not.toBeNull();
    full = true;
    store.edit(nameA('B')); store.edit(nameA('C'));
    expect(inner.getItem('acto.board')).toBeNull();
    expect(out.lines().filter((l) => l.level === 'warn').length).toBe(1);
  });
});

describe('problem counts [user, 2026-11-23]', () => {
  it('an edit that touches a workflow clears its count; another workflow keeps its own', () => {
    const store = createBoardStore(createOutputStore(null, () => '00:00:00'), null);
    store.load(board());
    store.setProblems('daily', 2);
    store.setProblems('hourly', 1);
    store.edit((b) => ({ ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, name: 'daily-2' } } }));
    expect(store.problems('daily')).toBe(0);
    expect(store.problems('hourly')).toBe(1);
  });
  describe('discard [user, 2026-11-25]', () => {
    it('drops every unsaved change at once: the count resets, the draft goes, and Ctrl+Z brings them back', () => {
      const { store, session } = make();
      store.edit(nameA('A')); store.edit(nameB('B'));
      expect(store.unsaved().size).toBe(2);
      expect(session!.getItem('acto.board')).not.toBeNull();
      expect(store.discard()).toBe(2);
      expect(store.unsaved().size).toBe(0);
      expect(store.state()).toEqual(store.base());
      expect(session!.getItem('acto.board')).toBeNull();
      store.undo();
      expect(store.unsaved().size).toBe(2);
      expect(store.state().workflows.daily!.name).toBe('A');
      store.redo();
      expect(store.unsaved().size).toBe(0);
    });
    it('takes the board it is given (a fresh load\'s placement), not only the base', () => {
      const { store } = make();
      store.edit(nameA('A'));
      const placed = setStepField(store.base(), 'lonely', 'name', 'placed');
      store.discard(placed);
      expect(store.state()).toEqual(placed);
    });
    it('clears Save\'s failures and the stale list with the changes they were about', () => {
      const { store } = make();
      store.edit(nameA('A'));
      store.setFailures(new Map([['workflow:daily', 'bad']]));
      store.setStale([{ table: 'workflows', id: 'daily' }]);
      store.discard();
      expect(store.failures().size).toBe(0);
      expect(store.stale()).toEqual([]);
    });
    it('does nothing on a clean board, and is refused while saving', () => {
      const { store, out } = make();
      expect(store.discard()).toBe(0);
      expect(store.canUndo()).toBe(false);
      store.edit(nameA('A'));
      store.setSaving(true);
      expect(store.discard()).toBe(0);
      expect(store.unsaved().size).toBe(1);
      expect(out.lines().some((l) => l.text === 'Saving — wait for it to finish')).toBe(true);
    });
  });
});

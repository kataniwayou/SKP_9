import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { createOutputStore } from '../output/outputStore';
import { board } from './boardFixtures';
import { createBoardStore } from './boardStore';
import { saveBoard, takeStored } from './saveBoard';
import { createGhostStore } from './ghosts';
import { addCache, addEntry, addStep, removeCacheItem, setCacheItem, setEntryCron } from './edits';
import { memoryStorage } from '../test/memoryStorage';

vi.mock('../board/loadBoard', () => ({ loadBoard: vi.fn() }));
import { loadBoard } from '../board/loadBoard';

const T2 = '2026-11-02T00:00:00Z';

function setup(start = board()) {
  const output = createOutputStore(null, () => '00:00:00');
  const store = createBoardStore(output, null);
  store.load(start);
  const api = {
    applyModel: vi.fn(async () => ({ ok: true as const, value: { ok: true, applied: true, results: [], made: {} } })),
    validateWorkflow: vi.fn(async () => ({ ok: true as const, value: { problems: [] } })),
    publishDiagram: vi.fn(async () => ({ ok: true as const, value: null })),
  };
  return { output, store, api, studio: api as unknown as StudioApi };
}
const setItem = (b: ReturnType<typeof board>, id: string, k: string, v: string) => { const e = setCacheItem(b, id, k, v); if (!('state' in e)) throw new Error('refused'); return e.state; };
const texts = (o: ReturnType<typeof createOutputStore>) => o.lines().map((l) => l.text);
const rename = (s: ReturnType<typeof setup>['store'], wf: string, name: string) =>
  s.edit((b) => ({ ...b, workflows: { ...b.workflows, [wf]: { ...b.workflows[wf]!, name } } }));

beforeEach(() => vi.mocked(loadBoard).mockReset());

describe('saveBoard', () => {
  it('gives the ghost store the made ids before the board adopts the re-read', async () => {
    const t = setup();
    const ghosts = createGhostStore(t.store);
    let seen: string[] = [];
    ghosts.subscribe(() => { seen = ghosts.ghosts().map((g) => g.key); });
    t.store.edit((b) => addStep(b, b.processors.p1!, { x: 1, y: 1 }, 'tmp1'));
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: true, applied: true, results: [], made: { tmp1: 'real1' } } } as never);
    const b = board();
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: { ...b, steps: { ...b.steps, real1: { ...t.store.state().steps.tmp1!, id: 'real1', updatedAt: T2 } } } });
    expect(await saveBoard(t.studio, t.store, t.output, ghosts)).toBe('saved');
    expect(ghosts.ghosts()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('with nothing changed says "Nothing to save" and sends nothing', async () => {
    const t = setup();
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('nothing');
    expect(texts(t.output)).toEqual(['Nothing to save']);
    expect(t.api.applyModel).not.toHaveBeenCalled();
  });

  it('sends the diff and adopts the re-read', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    const b = board();
    const fresh = { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily!, name: 'daily-2', updatedAt: T2 } } };
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: fresh });
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('saved');
    const sent = (t.api.applyModel.mock.calls as unknown as unknown[][])[0]![0] as { op: string; table: string; id: string }[];
    expect(sent.map((c) => `${c.op} ${c.table} ${c.id}`)).toEqual(['update workflows daily']);
    expect(t.store.base()).toBe(fresh);
    expect(t.store.state()).toBe(fresh);
    expect(t.store.saving()).toBe(false);
  });

  it('a refusal keeps the board, marks failures and names each by kind and name', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, name: 'fetch-2' } } }));
    const before = t.store.state();
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {},
      results: [{ index: 0, op: 'update', table: 'steps', id: 'fetch', ok: false, status: 422, problem: { title: 'Invalid', errors: { Name: ['too long', 'odd'] } } }] } } as never);
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('refused');
    expect(t.store.state()).toBe(before);
    expect(t.store.failures().get('step:fetch')).toBe('step fetch-2: too long; odd');
    expect(texts(t.output)).toContain('step fetch-2: too long; odd');
    expect(t.api.validateWorkflow).not.toHaveBeenCalled();
    expect(t.store.saving()).toBe(false);
  });

  it("a 409 that is not stale (a duplicate unique value) says BaseAPI's reason and offers no Take stored", async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, caches: { ...b.caches, c1: { ...b.caches.c1!, root: 'taken' } } }));
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results: [
      { index: 0, op: 'update', table: 'caches', id: 'c1', ok: false, status: 409, problem: { title: 'Conflict', detail: 'Unique constraint violation: root already exists.' } },
    ] } } as never);
    await saveBoard(t.studio, t.store, t.output);
    expect(texts(t.output)).toContain('cache c1: Unique constraint violation: root already exists.');
    expect(texts(t.output).some((x) => x.includes('changed elsewhere'))).toBe(false);
    expect(t.store.failures().has('cache:c1')).toBe(true);
    expect(t.store.stale()).toEqual([]);
  });

  it('says "changed elsewhere" for a 409', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results: [
      { index: 0, op: 'update', table: 'workflows', id: 'daily', ok: false, status: 409, problem: { detail: 'stale', code: 'stale' } },
    ] } } as never);
    await saveBoard(t.studio, t.store, t.output);
    expect(texts(t.output)).toContain('daily-2 changed elsewhere — Take stored drops your change to it');
    expect(t.store.failures().has('workflow:daily')).toBe(true);
  });

  it('pushes the design as drawn — a cycle too — with no gate check, and publishes the affected workflows [user, 2026-11-23 rev 2]', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, expand: { ...b.steps.expand!, nextStepIds: ['fetch'] } } }));
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: board() });
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('saved');
    expect(t.api.applyModel).toHaveBeenCalledTimes(1);
    expect(t.api.validateWorkflow).not.toHaveBeenCalled();
    const pub = t.api.publishDiagram.mock.calls as unknown as [string, string][];
    expect(pub.map((c) => c[0]).sort()).toEqual(['daily', 'hourly']);
    expect(texts(t.output)).toContain('Pushed 2 changes');
  });

  it('a step-only change on a shared step republishes both workflows', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, name: 'fetch-2' } } }));
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: board() });
    await saveBoard(t.studio, t.store, t.output);
    expect(t.api.publishDiagram.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(['daily', 'hourly']);
  });

  it('a failed re-read keeps the present with BaseAPI ids and warns to reload', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, new1: { ...b.steps.lonely!, id: 'new1', name: 'new-step', updatedAt: null } },
      workflows: { ...b.workflows, daily: { ...b.workflows.daily!, entryStepIds: ['fetch', 'new1'] } } }));
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: true, applied: true, results: [], made: { new1: 'g-1' } } });
    vi.mocked(loadBoard).mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('saved');
    const s = t.store.state();
    expect(s.steps['g-1']?.name).toBe('new-step');
    expect(s.steps.new1).toBeUndefined();
    expect(s.workflows.daily!.entryStepIds).toEqual(['fetch', 'g-1']);
    expect(texts(t.output).some((x) => x.includes('Reload'))).toBe(true);
    expect(t.api.publishDiagram).toHaveBeenCalledWith('daily', expect.stringContaining('<svg'));
  });

  it('saveRekeysEntryCronsToNewStepIds', async () => {
    const t = setup();
    t.store.edit((b) => addStep(b, b.processors.p1!, { x: 1, y: 1 }, 'tmp-1'));
    t.store.edit((b) => (addEntry(b, 'daily', 'tmp-1') as { state: ReturnType<typeof board> }).state);
    t.store.edit((b) => setEntryCron(b, 'daily', 'tmp-1', '*/10 * * * * *'));
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: true, applied: true, results: [], made: { 'tmp-1': 'real-1' } } });
    vi.mocked(loadBoard).mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } });
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('saved');
    expect(t.store.state().workflows.daily!.entryCrons).toEqual({ 'real-1': '*/10 * * * * *' });
    const sent = (t.api.applyModel.mock.calls as unknown as unknown[][])[0]![0] as { table: string; id: string; row: { entryCrons?: unknown } }[];
    expect(sent.find((c) => c.table === 'workflows' && c.id === 'daily')!.row.entryCrons).toEqual({ 'tmp-1': '*/10 * * * * *' });
  });

  it('always clears saving, also when the request throws', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    t.api.applyModel.mockRejectedValue(new Error('boom'));
    await expect(saveBoard(t.studio, t.store, t.output)).rejects.toThrow('boom');
    expect(t.store.saving()).toBe(false);
  });

  describe('a lost /model/apply answer', () => {
    const lost = async (error: object) => {
      const output = createOutputStore(null, () => '00:00:00');
      const session = memoryStorage();
      const store = createBoardStore(output, session);
      store.load(board());
      store.edit((b) => ({ ...b, caches: { ...b.caches, n1: { ...b.caches.c1!, id: 'n1', name: 'new-cache-1', root: 'n', updatedAt: null } } }));
      const applyModel = vi.fn(async () => ({ ok: false as const, error }));
      const api = { applyModel } as unknown as StudioApi;
      const first = await saveBoard(api, store, output);
      return { output, session, store, api, applyModel, first };
    };

    it('a transport error: outcome unknown, Save blocked (no second apply) until a reload', async () => {
      const t = await lost({ kind: 'network', message: 'Failed to fetch' });
      expect(t.first).toBe('refused');
      expect(texts(t.output)).toContain('Save outcome unknown — reload before saving again');
      expect(t.store.saveBlocked()).toBe(true);
      expect(t.store.saving()).toBe(false);
      // a reload must not restore the creates that may already be saved
      expect(t.session.getItem('acto.board')).toBeNull();
      expect(await saveBoard(t.api, t.store, t.output)).toBe('refused');
      expect(t.applyModel).toHaveBeenCalledTimes(1);
      expect(texts(t.output).at(-1)).toBe('Save outcome unknown — reload before saving again');
      t.store.load(board());
      expect(t.store.saveBlocked()).toBe(false);
    });

    it('an unreadable or 5xx answer is unknown too; a 4xx refusal is not', async () => {
      expect((await lost({ kind: 'http', status: 0, detail: 'Unreadable response' })).store.saveBlocked()).toBe(true);
      expect((await lost({ kind: 'http', status: 504, detail: 'Gateway Timeout' })).store.saveBlocked()).toBe(true);
      const known = await lost({ kind: 'badRequest', status: 400, detail: 'too many changes', errors: {} });
      expect(known.store.saveBlocked()).toBe(false);
      expect(texts(known.output)).toContain('Save failed: 400: too many changes');
    });
  });

  it('is refused while a delete (or another save) holds the board, with the saving warning', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    t.store.setSaving(true);
    expect(await saveBoard(t.studio, t.store, t.output)).toBe('refused');
    expect(t.api.applyModel).not.toHaveBeenCalled();
    expect(t.output.lines().at(-1)).toMatchObject({ level: 'warn', text: 'Saving — wait for it to finish' });
  });
});

describe('takeStored after a refusal on stale rows', () => {
  it('a stale cache with no item edits gets the generic wording', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, caches: { ...b.caches, c1: { ...b.caches.c1!, root: 'mine' } } }));
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results: [{ index: 0, op: 'update', table: 'caches', id: 'c1', ok: false, status: 409, problem: { code: 'stale' } }] } } as never);
    await saveBoard(t.studio, t.store, t.output);
    const b = board();
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: { ...b, caches: { ...b.caches, c1: { ...b.caches.c1!, root: 'theirs', updatedAt: T2 } } } });
    await takeStored(t.studio, t.store, t.output);
    expect(texts(t.output).at(-1)).toBe('Took the stored c1 — your changes to it are dropped (Undo brings them back)');
  });

  it('keeps the item edits of a stale cache and drops its field edits', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, caches: { ...b.caches, c1: { ...b.caches.c1!, root: 'mine' } } }));
    t.store.edit((b) => setItem(b, 'c1', 'k1', 'v'));
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results: [{ index: 0, op: 'update', table: 'caches', id: 'c1', ok: false, status: 409, problem: { code: 'stale' } }] } } as never);
    await saveBoard(t.studio, t.store, t.output);
    const b = board();
    const stored = { ...b.caches.c1!, root: 'theirs', updatedAt: T2 };
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: { ...b, caches: { ...b.caches, c1: stored } } });
    await takeStored(t.studio, t.store, t.output);
    expect(t.store.base().caches.c1).toEqual(stored);
    expect(t.store.state().caches.c1).toEqual({ ...stored, itemEdits: { set: { k1: 'v' }, removed: [] } });
    expect(texts(t.output).at(-1)).toBe('Took the stored c1 — your field changes are dropped, your item edits are kept (Undo brings them back)');
  });

  const refuse = (t: ReturnType<typeof setup>, results: unknown[]) =>
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results } } as never);

  it('takes the stored version of only the stale rows; other changes stay; undo brings the dropped change back', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    rename(t.store, 'hourly', 'hourly-2');
    refuse(t, [{ index: 0, op: 'update', table: 'workflows', id: 'daily', ok: false, status: 409, problem: { detail: 'stale', code: 'stale' } }]);
    await saveBoard(t.studio, t.store, t.output);
    expect(t.store.stale()).toEqual([{ table: 'workflows', id: 'daily' }]);

    const b = board();
    const stored = { ...b.workflows.daily!, name: 'daily-elsewhere', updatedAt: T2 };
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: { ...b, workflows: { ...b.workflows, daily: stored } } });
    await takeStored(t.studio, t.store, t.output);

    expect(t.store.base().workflows.daily).toEqual(stored);
    expect(t.store.state().workflows.daily).toEqual(stored);
    expect(t.store.state().workflows.hourly!.name).toBe('hourly-2');
    expect([...t.store.unsaved()]).toEqual(['workflow:hourly']);
    expect(t.store.stale()).toEqual([]);
    expect(t.store.failures().has('workflow:daily')).toBe(false);
    expect(texts(t.output).at(-1)).toMatch(/^Took the stored daily-elsewhere/);

    t.store.undo();
    expect(t.store.state().workflows.daily!.name).toBe('daily-2');
    expect(t.store.base().workflows.daily!.updatedAt).toBe(T2); // a Save now overwrites knowingly, not a 409
  });

  it('a row gone from BaseAPI (404) leaves the board', async () => {
    const t = setup();
    t.store.edit((b) => ({ ...b, steps: { ...b.steps, fetch: { ...b.steps.fetch!, name: 'fetch-2' } } }));
    refuse(t, [{ index: 0, op: 'update', table: 'steps', id: 'fetch', ok: false, status: 404, problem: { title: 'Not Found' } }]);
    await saveBoard(t.studio, t.store, t.output);
    expect(texts(t.output)).toContain('step fetch-2 is gone — Take stored drops your change to it');
    const b = board();
    const steps = { ...b.steps };
    delete steps.fetch;
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: { ...b, steps } });
    await takeStored(t.studio, t.store, t.output);
    expect(t.store.base().steps.fetch).toBeUndefined();
    expect(t.store.state().steps.fetch).toBeUndefined();
  });

  it('other refusals are not stale; a failed read changes nothing', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    refuse(t, [{ index: 0, op: 'update', table: 'workflows', id: 'daily', ok: false, status: 422, problem: { detail: 'bad' } }]);
    await saveBoard(t.studio, t.store, t.output);
    expect(t.store.stale()).toEqual([]);

    refuse(t, [{ index: 0, op: 'update', table: 'workflows', id: 'daily', ok: false, status: 409, problem: { detail: 'stale', code: 'stale' } }]);
    await saveBoard(t.studio, t.store, t.output);
    const before = t.store.state();
    vi.mocked(loadBoard).mockResolvedValue({ ok: false, error: { kind: 'network', status: 0 } } as never);
    await takeStored(t.studio, t.store, t.output);
    expect(t.store.state()).toBe(before);
    expect(t.store.stale()).toHaveLength(1);
    expect(t.store.saving()).toBe(false);
  });
});

describe('item reports and warnings', () => {
  const items = (t: ReturnType<typeof setup>) => {
    t.store.edit((b) => setItem(b, 'c1', 'k1', 'v'));
    t.store.edit((b) => setItem(b, 'c1', 'k2', 'v'));
    t.store.edit((b) => removeCacheItem(b, 'c1', 'k3', true));
  };
  const applied = (t: ReturnType<typeof setup>, extra: object, results: unknown[] = []) => {
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: true, applied: true, made: {}, results, ...extra } } as never);
    vi.mocked(loadBoard).mockResolvedValue({ ok: true, value: board() });
  };
  const rep = { added: 0, overwritten: 0, repeatedInBatch: 0, overwrittenKeys: [], repeatedKeys: [], keysTruncated: false };
  const rem = { removed: 0, notFound: 0, repeatedInBatch: 0, notFoundKeys: [], repeatedKeys: [], keysTruncated: false };

  it('save logs the item report per cache', async () => {
    const t = setup();
    items(t);
    applied(t, {}, [
      { index: 0, op: 'append', table: 'cache_items', id: 'c1', ok: true, status: 200, report: { ...rep, added: 1, overwritten: 1, repeatedInBatch: 1 } },
      { index: 1, op: 'remove', table: 'cache_items', id: 'c1', ok: true, status: 200, report: { ...rem, removed: 1, repeatedInBatch: 1 } },
    ]);
    await saveBoard(t.studio, t.store, t.output);
    expect(t.output.lines().filter((l) => l.level === 'ok').map((l) => l.text)).toContain('c1: 1 added, 1 overwritten, 1 removed, 2 repeated');
  });

  it('omits the repeated part when there are none', async () => {
    const t = setup();
    t.store.edit((b) => setItem(b, 'c1', 'k1', 'v'));
    applied(t, {}, [{ index: 0, op: 'append', table: 'cache_items', id: 'c1', ok: true, status: 200, report: { ...rep, added: 1 } }]);
    await saveBoard(t.studio, t.store, t.output);
    expect(texts(t.output)).toContain('c1: 1 added, 0 overwritten, 0 removed');
  });

  it('save logs refresh warnings', async () => {
    const t = setup();
    rename(t.store, 'daily', 'daily-2');
    applied(t, { warnings: ['could not refresh workflow daily'] });
    await saveBoard(t.studio, t.store, t.output);
    expect(t.output.lines()).toContainEqual(expect.objectContaining({ level: 'warn', text: 'could not refresh workflow daily' }));
  });

  it.each([
    [404, { title: 'Not Found' }, 'c1 is gone — reload the board; its item edits were not saved'],
    [400, { detail: 'value too large' }, 'c1: items not saved — value too large'],
  ])('a refused item op (%i) marks the cache, names it and offers no Take stored', async (status, problem, text) => {
    const t = setup();
    items(t);
    t.api.applyModel.mockResolvedValue({ ok: true, value: { ok: false, applied: false, made: {}, results: [
      { index: 0, op: 'append', table: 'cache_items', id: 'c1', ok: false, status, problem },
    ] } } as never);
    await saveBoard(t.studio, t.store, t.output);
    expect([...t.store.failures().keys()]).toEqual(['cache:c1']);
    expect(texts(t.output)).toContain(text);
    expect(t.store.stale()).toEqual([]);
  });

  it('names a cache created in the same Save by its client id in the report', async () => {
    const t = setup();
    t.store.edit((b) => addCache(b, { x: 0, y: 0 }, 'tmp1'));
    t.store.edit((b) => setItem(b, 'tmp1', 'k', 'v'));
    const name = t.store.state().caches.tmp1!.name;
    applied(t, { made: { tmp1: 'real1' } }, [{ index: 1, op: 'append', table: 'cache_items', id: 'tmp1', ok: true, status: 200, report: { ...rep, added: 1 } }]);
    await saveBoard(t.studio, t.store, t.output);
    expect(texts(t.output)).toContain(`${name}: 1 added, 0 overwritten, 0 removed`);
  });
});

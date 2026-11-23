import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { createOutputStore } from '../output/outputStore';
import { board } from './boardFixtures';
import { createBoardStore } from './boardStore';
import { saveBoard, takeStored } from './saveBoard';
import { createGhostStore } from './ghosts';
import { addStep } from './edits';
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

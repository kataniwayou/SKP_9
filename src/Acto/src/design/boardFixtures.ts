import type { BoardState } from './board';

const T = '2026-11-01T00:00:00Z';
const audit = { createdAt: T, createdBy: null, updatedAt: T, updatedBy: null };
/** A saved row's read-only audit fields. */
const seen = { createdAt: T, createdBy: null, updatedBy: null };

/** Two workflows entering `fetch`; fetch -> expand; cache c1 linked by daily; orphan step `lonely`. */
export function board(): BoardState {
  const step = (id: string, name: string, nextStepIds: string[], x: number) => ({
    id, name, version: '1.0.0', description: null, processorId: 'p1', nextStepIds, entryCondition: 1,
    at: { x, y: 200 }, updatedAt: T, ...seen,
  });
  return {
    workflows: {
      daily: { id: 'daily', name: 'daily', version: '1.0.0', description: null,
        entryStepIds: ['fetch'], entryCrons: {}, assignmentIds: ['a-daily-fetch'], cacheIds: ['c1'], at: { x: 0, y: 0 }, updatedAt: T, ...seen },
      hourly: { id: 'hourly', name: 'hourly', version: '1.0.0', description: null,
        entryStepIds: ['fetch'], entryCrons: {}, assignmentIds: ['a-hourly-fetch'], cacheIds: [], at: { x: 0, y: 100 }, updatedAt: T, ...seen },
    },
    steps: {
      fetch: step('fetch', 'fetch-orders', ['expand'], 200),
      expand: step('expand', 'expand', [], 400),
      lonely: step('lonely', 'lonely', [], 600),
    },
    caches: {
      c1: { id: 'c1', name: 'c1', version: '1.0.0', description: null, root: 'r', itemCount: 0, itemEdits: { set: {}, removed: [] }, at: { x: 0, y: -100 }, updatedAt: T, ...seen },
    },
    assignments: {
      'a-daily-fetch': { id: 'a-daily-fetch', stepId: 'fetch', name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{}', updatedAt: T, ...seen },
      'a-hourly-fetch': { id: 'a-hourly-fetch', stepId: 'fetch', name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{}', updatedAt: T, ...seen },
    },
    processors: {
      p1: { id: 'p1', name: 'proc', version: '1.0.0', description: null, sourceHash: 'a'.repeat(64), instanceId: null,
        inputSchemaId: null, outputSchemaId: null, configSchemaId: null, audit, at: null, updatedAt: T },
    },
    schemas: {},
  };
}

/** `board()` with every entry arrow scheduled: only an arrow with a cron fires, so anything that shows motion needs one [user, 2026-11-25]. */
export function scheduledBoard(cron = '0 * * * * *'): BoardState {
  const b = board();
  for (const w of Object.values(b.workflows)) w.entryCrons = Object.fromEntries(w.entryStepIds.map((s) => [s, cron]));
  return b;
}

/** Like board(), but one assignment row `a-shared` (on fetch) is linked by both workflows. */
export function shared(): BoardState {
  const b = board();
  const row = { id: 'a-shared', stepId: 'fetch', name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{"shared":true}', updatedAt: T, ...seen };
  return {
    ...b,
    assignments: { 'a-shared': row },
    workflows: {
      ...b.workflows,
      daily: { ...b.workflows.daily, assignmentIds: ['a-shared'] },
      hourly: { ...b.workflows.hourly, assignmentIds: ['a-shared'] },
    },
  };
}

/** A board with one saved workflow `id` named `name` and nothing else. */
export function oneWorkflow(id = 'wf1', name = 'orders'): BoardState {
  return {
    workflows: { [id]: { id, name, version: '1.0.0', description: null, entryStepIds: [], entryCrons: {}, assignmentIds: [], cacheIds: [], at: { x: 0, y: 0 }, updatedAt: T, ...seen } },
    steps: {}, caches: {}, assignments: {}, processors: {}, schemas: {},
  };
}

/**
 * `board()` with schemas: p1 (which fetch, expand and lonely use) takes `sx` as its input and `sc` as its config; p2, which no
 * step uses, holds `sh` as its output; `so` is an orphan. Every schema and p2 have a place below the steps.
 */
export function schemaBoard(): BoardState {
  const b = board();
  const schema = (id: string, name: string, x: number, y: number) => ({ id, name, version: '1.0.0', description: null, definition: '{}', audit, at: { x, y }, updatedAt: T });
  b.processors.p1 = { ...b.processors.p1!, inputSchemaId: 'sx', configSchemaId: 'sc' };
  b.processors.p2 = { id: 'p2', name: 'idle-proc', version: '2.0.0', description: null, sourceHash: 'b'.repeat(64), instanceId: 'inst-7',
    inputSchemaId: null, outputSchemaId: 'sh', configSchemaId: null, audit, at: { x: 900, y: 500 }, updatedAt: T };
  b.schemas = {
    sx: schema('sx', 'orders-in', 200, 400), sc: schema('sc', 'orders-cfg', 450, 400),
    sh: schema('sh', 'held-out', 900, 650), so: schema('so', 'old-copy', 1200, 400),
  };
  return b;
}

import type { BoardState } from './board';

const T = '2026-11-01T00:00:00Z';
const audit = { createdAt: T, createdBy: null, updatedAt: T, updatedBy: null };

/** Two workflows entering `fetch`; fetch -> expand; cache c1 linked by daily; orphan step `lonely`. */
export function board(): BoardState {
  const step = (id: string, name: string, nextStepIds: string[], x: number) => ({
    id, name, version: '1.0.0', description: null, processorId: 'p1', nextStepIds, entryCondition: 1,
    at: { x, y: 200 }, updatedAt: T,
  });
  return {
    workflows: {
      daily: { id: 'daily', name: 'daily', version: '1.0.0', description: null, cronExpression: null,
        entryStepIds: ['fetch'], assignmentIds: ['a-daily-fetch'], cacheIds: ['c1'], at: { x: 0, y: 0 }, updatedAt: T },
      hourly: { id: 'hourly', name: 'hourly', version: '1.0.0', description: null, cronExpression: null,
        entryStepIds: ['fetch'], assignmentIds: ['a-hourly-fetch'], cacheIds: [], at: { x: 0, y: 100 }, updatedAt: T },
    },
    steps: {
      fetch: step('fetch', 'fetch-orders', ['expand'], 200),
      expand: step('expand', 'expand', [], 400),
      lonely: step('lonely', 'lonely', [], 600),
    },
    caches: {
      c1: { id: 'c1', name: 'c1', version: '1.0.0', description: null, root: 'r', items: '{}', at: { x: 0, y: -100 }, updatedAt: T },
    },
    assignments: {
      'a-daily-fetch': { id: 'a-daily-fetch', stepId: 'fetch', name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{}', updatedAt: T },
      'a-hourly-fetch': { id: 'a-hourly-fetch', stepId: 'fetch', name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{}', updatedAt: T },
    },
    processors: {
      p1: { id: 'p1', name: 'proc', version: '1.0.0', description: null, sourceHash: 'a'.repeat(64), instanceId: null,
        inputSchemaId: null, outputSchemaId: null, configSchemaId: null, audit, updatedAt: T },
    },
    schemas: {},
  };
}

/** Like board(), but one assignment row `a-shared` (on fetch) is linked by both workflows. */
export function shared(): BoardState {
  const b = board();
  const row = { id: 'a-shared', stepId: 'fetch', name: 'fetch-assignment', version: '1.0.0', description: null, payload: '{"shared":true}', updatedAt: T };
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
    workflows: { [id]: { id, name, version: '1.0.0', description: null, cronExpression: null, entryStepIds: [], assignmentIds: [], cacheIds: [], at: { x: 0, y: 0 }, updatedAt: T } },
    steps: {}, caches: {}, assignments: {}, processors: {}, schemas: {},
  };
}

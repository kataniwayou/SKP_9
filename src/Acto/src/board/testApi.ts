import { vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { assignmentDto, cacheDto, processorDto, stepDto, workflowDto } from '../api/fixtures';
import type { AssignmentReadDto, CacheReadDto, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowReadDto } from '../api/types';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const notFound: ApiResult<never> = { ok: false, error: { kind: 'notFound', status: 404 } };

export interface FakeLists {
  workflows?: WorkflowReadDto[]; steps?: StepReadDto[]; caches?: CacheReadDto[];
  assignments?: AssignmentReadDto[]; processors?: ProcessorReadDto[]; schemas?: SchemaReadDto[];
}

/**
 * A BaseAPI whose six lists answer what is given (empty otherwise); the dry runs and applies answer ok with nothing
 * applied; publishDiagram answers ok; every other call notFound.
 */
export function fakeApi(o: FakeLists = {}): StudioApi {
  const notFoundFn = vi.fn().mockResolvedValue(notFound);
  return {
    listWorkflows: vi.fn().mockResolvedValue(ok(o.workflows ?? [])),
    listSteps: vi.fn().mockResolvedValue(ok(o.steps ?? [])),
    listCaches: vi.fn().mockResolvedValue(ok(o.caches ?? [])),
    listAssignments: vi.fn().mockResolvedValue(ok(o.assignments ?? [])),
    listProcessors: vi.fn().mockResolvedValue(ok(o.processors ?? [])),
    listSchemas: vi.fn().mockResolvedValue(ok(o.schemas ?? [])),
    applyModel: vi.fn().mockResolvedValue(ok({ applied: true, results: [], made: {} })),
    validateModel: vi.fn().mockResolvedValue(ok({ ok: true, results: [] })),
    validateWorkflow: vi.fn().mockResolvedValue(ok({ problems: [] })),
    getStep: notFoundFn,
    getProcessor: notFoundFn,
    getSchema: notFoundFn,
    getEntity: notFoundFn,
    putEntity: notFoundFn,
    createAssignment: notFoundFn,
    deleteAssignment: notFoundFn,
    listLive: notFoundFn,
    listLiveness: notFoundFn,
    startWorkflow: notFoundFn,
    stopWorkflow: notFoundFn,
    publishDiagram: vi.fn().mockResolvedValue(ok(null)),
    cacheItemsPage: vi.fn().mockResolvedValue(ok({ items: [], next: null })),
  } as unknown as StudioApi;
}

const at = (x: number, y: number) => ({ boardX: x, boardY: y }) as object;

/**
 * The board of design/boardFixtures as BaseAPI lists it: workflows daily (entry fetch, cache c1) and hourly (entry
 * fetch); steps fetch-orders → expand and the orphan lonely; processor p1 ("proc").
 */
export function boardApi(over: FakeLists = {}): StudioApi {
  return fakeApi({
    workflows: [
      workflowDto({ id: 'daily', name: 'daily', entryStepIds: ['fetch'], cacheIds: ['c1'], assignmentIds: ['a-daily-fetch'], ...at(0, 0) }),
      workflowDto({ id: 'hourly', name: 'hourly', entryStepIds: ['fetch'], assignmentIds: ['a-hourly-fetch'], ...at(0, 200) }),
    ],
    steps: [
      stepDto('fetch', { name: 'fetch-orders', nextStepIds: ['expand'], ...at(300, 0) }),
      stepDto('expand', { name: 'expand', ...at(600, 0) }),
      stepDto('lonely', { name: 'lonely', ...at(900, 0) }),
    ],
    caches: [cacheDto('c1', { name: 'c1', ...at(0, 400) })],
    assignments: [assignmentDto('a-daily-fetch', { stepId: 'fetch' }), assignmentDto('a-hourly-fetch', { stepId: 'fetch' })],
    processors: [processorDto('p1', { name: 'proc' })],
    ...over,
  });
}

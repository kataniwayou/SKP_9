import { vi } from 'vitest';
import type { ApiError, ApiResult, StudioApi } from '../api/client';
import { graphDto, stepDto as baseStepDto, workflowDto } from '../api/fixtures';
import type { StepReadDto, WorkflowGraphDto, WorkflowReadDto } from '../api/types';
import type { Id } from '../model/graph';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const notFound: ApiResult<never> = { ok: false, error: { kind: 'notFound', status: 404 } };

export function wf(id: Id, createdAt = '2026-01-01'): WorkflowReadDto {
  return workflowDto({ id, name: `${id}-name`, createdAt, updatedAt: createdAt });
}

export function stepDto(id: Id): StepReadDto {
  return baseStepDto(id, { name: `${id}-name` });
}

export function graphWith(g: { entry: Id[]; steps: Record<Id, Id[]>; layout?: unknown }): WorkflowGraphDto {
  return graphDto({
    workflow: workflowDto({ id: 'w1', name: 'w1-name', entryStepIds: g.entry }),
    steps: Object.entries(g.steps).map(([id, next]) => baseStepDto(id, { name: `${id}-name`, nextStepIds: next, entryCondition: 1 })),
    processors: [],
    layout: g.layout ?? null,
  } as Partial<WorkflowGraphDto>);
}

/** Every call not given here answers notFound. A graph with no entry is a single step `s1`. */
export function fakeApi(o: {
  workflows?: WorkflowReadDto[];
  graph?: WorkflowGraphDto;
  graphs?: Record<Id, WorkflowGraphDto>;
  graphError?: Record<Id, ApiError>;
  extraSteps?: Record<Id, StepReadDto>;
} = {}): StudioApi {
  const notFoundFn = vi.fn().mockResolvedValue(notFound);
  return {
    listWorkflows: vi.fn().mockResolvedValue(ok(o.workflows ?? [])),
    getGraph: vi.fn(async (id: string) => {
      const err = o.graphError?.[id];
      if (err) return { ok: false, error: err } as ApiResult<never>;
      const base = o.graphs?.[id] ?? o.graph ?? graphWith({ entry: ['s1'], steps: { s1: [] } });
      const known = o.workflows?.find((w) => w.id === id);
      return ok({ ...base, workflow: { ...base.workflow!, id, name: known?.name ?? `${id}-name`, createdAt: known?.createdAt ?? base.workflow?.createdAt } } as WorkflowGraphDto);
    }),
    getStep: vi.fn(async (id: string) => (o.extraSteps?.[id] ? ok(o.extraSteps[id]) : notFound)),
    getProcessor: notFoundFn,
    getSchema: notFoundFn,
    getEntity: notFoundFn,
    putEntity: notFoundFn,
    createAssignment: notFoundFn,
    deleteAssignment: notFoundFn,
    listLive: notFoundFn,
    listLiveness: notFoundFn,
    saveDesign: notFoundFn,
    startWorkflow: notFoundFn,
    stopWorkflow: notFoundFn,
    deleteWorkflow: notFoundFn,
    publishDiagram: vi.fn().mockResolvedValue({ ok: true, value: null }),
  } as unknown as StudioApi;
}

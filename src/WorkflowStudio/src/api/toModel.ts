import type { Assignment, Cache, Graph, Processor, Schema, Step, Workflow } from '../model/graph';
import type { ProcessorReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';

// The generated DTO types mark almost every field optional (see api/types.ts). These helpers state
// once what the server actually guarantees, so the model never carries undefined.

function required(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || value === '') throw new Error(`The server sent no ${field}.`);
  return value;
}
const text = (value: string | null | undefined): string => value ?? '';
const optional = (value: string | null | undefined): string | null => value ?? null;
const list = (value: (string | null | undefined)[] | null | undefined): string[] =>
  (value ?? []).filter((v): v is string => typeof v === 'string' && v !== '');

export function workflowFromDto(dto: WorkflowReadDto): Workflow {
  return {
    id: required(dto.id, 'workflow id'),
    name: text(dto.name),
    version: text(dto.version),
    cronExpression: optional(dto.cronExpression),
    entryStepIds: list(dto.entryStepIds),
    assignmentIds: list(dto.assignmentIds),
    cacheIds: list(dto.cacheIds),
    updatedAt: text(dto.updatedAt),
  };
}

export function stepFromDto(dto: StepReadDto): Step {
  return {
    id: required(dto.id, 'step id'),
    name: text(dto.name),
    version: text(dto.version),
    processorId: text(dto.processorId),
    nextStepIds: list(dto.nextStepIds),
    entryCondition: typeof dto.entryCondition === 'number' ? dto.entryCondition : 0,
    updatedAt: text(dto.updatedAt),
  };
}

export function processorFromDto(dto: ProcessorReadDto): Processor {
  return {
    id: required(dto.id, 'processor id'),
    name: text(dto.name),
    version: text(dto.version),
    inputSchemaId: optional(dto.inputSchemaId),
    outputSchemaId: optional(dto.outputSchemaId),
    configSchemaId: optional(dto.configSchemaId),
  };
}

export function graphFromDto(dto: WorkflowGraphDto): Graph {
  const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]));

  const schemas: Schema[] = (dto.schemas ?? []).map((s) => ({
    id: required(s.id, 'schema id'), name: text(s.name), version: text(s.version),
  }));
  const assignments: Assignment[] = (dto.assignments ?? []).map((a) => ({
    id: required(a.id, 'assignment id'), stepId: text(a.stepId), payload: text(a.payload),
  }));
  const caches: Cache[] = (dto.caches ?? []).map((c) => ({
    id: required(c.id, 'cache id'), name: text(c.name), root: text(c.root), items: text(c.items),
  }));

  if (!dto.workflow) throw new Error('The server sent no workflow.');

  return {
    workflow: workflowFromDto(dto.workflow),
    steps: byId((dto.steps ?? []).map(stepFromDto)),
    processors: byId((dto.processors ?? []).map(processorFromDto)),
    schemas: byId(schemas),
    assignments,
    caches: byId(caches),
    layout: dto.layout ?? null,
  };
}

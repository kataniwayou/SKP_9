import type { CacheReadDto, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';

// Builders for complete DTOs, so tests state only what they care about. Every field the server
// sends is present, which satisfies the generated types whether they mark fields optional or not.
const audit = { createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', createdBy: null, updatedBy: null };

export function stepDto(id: string, over: Partial<StepReadDto> = {}): StepReadDto {
  return {
    id, name: `step-${id}`, version: '1.0.0', description: null, processorId: 'p1',
    nextStepIds: [], entryCondition: 1, ...audit, ...over,
  } as StepReadDto;
}

export function processorDto(id: string, over: Partial<ProcessorReadDto> = {}): ProcessorReadDto {
  return {
    id, name: `proc-${id}`, version: '1.0.0', description: null, sourceHash: 'a'.repeat(64),
    instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null, ...audit, ...over,
  } as ProcessorReadDto;
}

export function schemaDto(id: string, over: Partial<SchemaReadDto> = {}): SchemaReadDto {
  return { id, name: `schema-${id}`, version: '1.0.0', description: null, definition: '{}', ...audit, ...over } as SchemaReadDto;
}

export function cacheDto(id: string, over: Partial<CacheReadDto> = {}): CacheReadDto {
  return { id, name: `cache-${id}`, version: '1.0.0', description: null, root: id, items: '{}', ...audit, ...over } as CacheReadDto;
}

export function workflowDto(over: Partial<WorkflowReadDto> = {}): WorkflowReadDto {
  return {
    id: 'wf1', name: 'orders', version: '1.0.0', description: null, entryStepIds: ['s1'],
    assignmentIds: [], cacheIds: [], cronExpression: null, ...audit, ...over,
  } as WorkflowReadDto;
}

export function graphDto(over: Partial<WorkflowGraphDto> = {}): WorkflowGraphDto {
  return {
    workflow: workflowDto(),
    steps: [stepDto('s1')],
    processors: [processorDto('p1')],
    schemas: [],
    assignments: [],
    caches: [],
    layout: null,
    ...over,
  } as WorkflowGraphDto;
}

import type {
  AssignmentReadDto, AssignmentUpdateDto, CacheReadDto, CacheUpdateDto, ProcessorReadDto, ProcessorUpdateDto,
  SchemaReadDto, SchemaUpdateDto, StepReadDto, StepUpdateDto, WorkflowReadDto, WorkflowUpdateDto,
} from './types';

/** The six entities the Inspector reads and saves (spec §7.1), each at `/{ENTITY_PATH[kind]}/{id}`. */
export type EntityKind = 'workflow' | 'step' | 'processor' | 'schema' | 'assignment' | 'cache';

export interface ReadDtoOf {
  workflow: WorkflowReadDto;
  step: StepReadDto;
  processor: ProcessorReadDto;
  schema: SchemaReadDto;
  assignment: AssignmentReadDto;
  cache: CacheReadDto;
}

export interface UpdateDtoOf {
  workflow: WorkflowUpdateDto;
  step: StepUpdateDto;
  processor: ProcessorUpdateDto;
  schema: SchemaUpdateDto;
  assignment: AssignmentUpdateDto;
  cache: CacheUpdateDto;
}

export type EntityReadDto = ReadDtoOf[EntityKind];

export const ENTITY_PATH: Record<EntityKind, string> = {
  workflow: 'workflows', step: 'steps', processor: 'processors', schema: 'schemas', assignment: 'assignments', cache: 'caches',
};

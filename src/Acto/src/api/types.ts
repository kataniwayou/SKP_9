import type { components } from './schema';

// The wire shapes, exactly as BaseApi's OpenAPI document describes them. Swashbuckle 6.9 marks
// most reference-typed fields optional and nullable whatever the C# says, so the rest of the app
// never reads these directly: api/toModel.ts converts them to model/graph.ts once, at the edge.
type Schemas = components['schemas'];

export type WorkflowReadDto = Schemas['WorkflowReadDto'];
export type StepReadDto = Schemas['StepReadDto'];
export type ProcessorReadDto = Schemas['ProcessorReadDto'];
export type SchemaReadDto = Schemas['SchemaReadDto'];
export type CacheReadDto = Schemas['CacheReadDto'];
export type CacheItemDto = Schemas['CacheItemDto'];
export type CacheItemsPage = Schemas['CacheItemsPage'];
export type CacheAppendReport = Schemas['CacheAppendReport'];
export type CacheRemoveReport = Schemas['CacheRemoveReport'];
export type AssignmentReadDto = Schemas['AssignmentReadDto'];
export type AssignmentCreateDto = Schemas['AssignmentCreateDto'];
export type WorkflowCreateDto = Schemas['WorkflowCreateDto'];
export type StepCreateDto = Schemas['StepCreateDto'];
export type CacheCreateDto = Schemas['CacheCreateDto'];
export type SchemaCreateDto = Schemas['SchemaCreateDto'];
export type WorkflowUpdateDto = Schemas['WorkflowUpdateDto'];
export type StepUpdateDto = Schemas['StepUpdateDto'];
export type ProcessorUpdateDto = Schemas['ProcessorUpdateDto'];
export type SchemaUpdateDto = Schemas['SchemaUpdateDto'];
export type AssignmentUpdateDto = Schemas['AssignmentUpdateDto'];
export type CacheUpdateDto = Schemas['CacheUpdateDto'];
export type WorkflowValidationDto = Schemas['WorkflowValidationDto'];

// The board-wide model save (BaseApi /model/validate and /model/apply).
export type ModelChangesDto = Schemas['ModelChangesDto'];
export type ModelChangeDto = Schemas['ModelChangeDto'];
export type ModelChangeResultDto = Schemas['ModelChangeResultDto'];
export type ModelApplyResultDto = Schemas['ModelApplyResultDto'];
export type ModelValidateResultDto = Schemas['ModelValidateResultDto'];


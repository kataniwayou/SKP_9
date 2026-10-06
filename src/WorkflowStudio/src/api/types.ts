import type { components } from './schema';

// The wire shapes, exactly as BaseApi's OpenAPI document describes them. Swashbuckle 6.9 marks
// most reference-typed fields optional and nullable whatever the C# says, so the rest of the app
// never reads these directly: api/toModel.ts converts them to model/graph.ts once, at the edge.
type Schemas = components['schemas'];

export type WorkflowGraphDto = Schemas['WorkflowGraphDto'];
export type WorkflowReadDto = Schemas['WorkflowReadDto'];
export type StepReadDto = Schemas['StepReadDto'];
export type ProcessorReadDto = Schemas['ProcessorReadDto'];
export type SchemaReadDto = Schemas['SchemaReadDto'];
export type CacheReadDto = Schemas['CacheReadDto'];
export type WorkflowValidationDto = Schemas['WorkflowValidationDto'];
export type WorkflowProblemDto = Schemas['WorkflowProblemDto'];
export type AssignmentReadDto = Schemas['AssignmentReadDto'];
export type AssignmentCreateDto = Schemas['AssignmentCreateDto'];
export type WorkflowUpdateDto = Schemas['WorkflowUpdateDto'];
export type StepUpdateDto = Schemas['StepUpdateDto'];
export type ProcessorUpdateDto = Schemas['ProcessorUpdateDto'];
export type SchemaUpdateDto = Schemas['SchemaUpdateDto'];
export type AssignmentUpdateDto = Schemas['AssignmentUpdateDto'];
export type CacheUpdateDto = Schemas['CacheUpdateDto'];

import type { components } from './schema';

// The wire shapes, exactly as BaseApi's OpenAPI document describes them. Swashbuckle 6.9 marks
// most reference-typed fields optional and nullable whatever the C# says, so the rest of the app
// never reads these directly: api/toModel.ts converts them to model/graph.ts once, at the edge.
type Schemas = components['schemas'];

export type WorkflowGraphDto = Schemas['WorkflowGraphDto'];
export type WorkflowReadDto = Schemas['WorkflowReadDto'];
export type StepReadDto = Schemas['StepReadDto'];
export type ProcessorReadDto = Schemas['ProcessorReadDto'];
export type WorkflowValidationDto = Schemas['WorkflowValidationDto'];
export type WorkflowProblemDto = Schemas['WorkflowProblemDto'];

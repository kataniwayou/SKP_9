import type { ToolDef } from './toolTypes';

export { workflowArg } from './toolTypes';

/**
 * Every tool the model may call, in the order it is told of them. Empty until Plan 4 Tasks 4–6 append theirs; the
 * loop works without any (the model only answers in text).
 */
export const TOOL_DEFS: ToolDef[] = [];

/** The tools as the model's API takes them (OpenAI style), as TOOL_DEFS holds them when the request is sent. */
export const toolsForModel = () =>
  TOOL_DEFS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** The tools that ask the user before they act. */
export const DESTRUCTIVE: ReadonlySet<string> = new Set<string>(['stop', 'delete_workflow', 'delete_picked', 'remove_assignment']);

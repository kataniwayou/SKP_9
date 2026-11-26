import { READ_TOOLS } from './tools/read';
import { DESIGN_TOOLS } from './tools/design';
import { FIELD_TOOLS } from './tools/fields';
import { CACHE_ITEM_TOOLS } from './tools/cacheItems';
import { WORKFLOW_TOOLS } from './tools/workflows';
import type { ToolDef } from './toolTypes';

export { workflowArg } from './toolTypes';

/** Every tool the model may call, in the order it is told of them: reading, workflow, design (graph, picks, clipboard), fields. */
export const TOOL_DEFS: ToolDef[] = [...READ_TOOLS, ...WORKFLOW_TOOLS, ...DESIGN_TOOLS, ...FIELD_TOOLS, ...CACHE_ITEM_TOOLS];

/** The tools as the model's API takes them (OpenAI style), as TOOL_DEFS holds them when the request is sent. */
export const toolsForModel = () =>
  TOOL_DEFS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** The tools that ask the user before they act. */
export const DESTRUCTIVE: ReadonlySet<string> = new Set<string>(['start', 'stop', 'delete_workflow', 'delete_picked', 'remove_assignment', 'save', 'take_stored']);

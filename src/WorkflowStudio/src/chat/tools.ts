import { READ_TOOLS } from './tools/read';
import { WORKFLOW_TOOLS } from './tools/workflows';
import type { ToolDef } from './toolTypes';

/** Every tool the model may call, in the order it is told of them; each task appends its own. */
export const TOOL_DEFS: ToolDef[] = [...READ_TOOLS, ...WORKFLOW_TOOLS];

/** The tools as the model's API takes them (OpenAI style). */
export const TOOLS = TOOL_DEFS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** The tools that ask the user before they act. */
export const DESTRUCTIVE: ReadonlySet<string> = new Set<string>(['stop', 'delete_workflow', 'close_workflow']);

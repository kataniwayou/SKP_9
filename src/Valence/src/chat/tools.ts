import { ACT_TOOLS } from './tools/act';
import { READ_TOOLS } from './tools/read';
import type { ToolDef } from './toolTypes';

/** Every tool the model may call (2026-10-26): reading the project, then acting on it as the user does. */
export const TOOL_DEFS: ToolDef[] = [...READ_TOOLS, ...ACT_TOOLS];

/** The tools as the model's API takes them (OpenAI style). */
export const TOOLS = TOOL_DEFS.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** The tools that ask the user before they act: only the apply writes to BaseApi; everything else is virtual and undone. */
export const DESTRUCTIVE: ReadonlySet<string> = new Set<string>(['apply_changes']);

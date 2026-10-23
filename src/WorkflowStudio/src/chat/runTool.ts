import type { ToolCall } from './kimi';
import { TOOL_DEFS } from './tools';
import type { ToolContext, ToolOutcome } from './toolTypes';

const failed = (result: string, action: string): ToolOutcome => ({ kind: 'done', ok: false, result, action, entries: [] });

/**
 * Runs one tool call of the model (2026-10-23). A name that is no tool, or arguments that are not a JSON object (the
 * stream may have ended truncated), come back as a failed result naming the problem, for the model to correct.
 * `answer` is the user's choice when this call asked a question before.
 */
export async function runTool(ctx: ToolContext, call: ToolCall, answer?: string): Promise<ToolOutcome> {
  const def = TOOL_DEFS.find((t) => t.name === call.name);
  if (!def) return failed(`there is no tool named ${call.name}`, `unknown tool ${call.name}`);
  let args: unknown;
  try {
    args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
  } catch {
    return failed(`the arguments of ${call.name} are not valid JSON (cut off?): ${call.arguments.slice(0, 200)}`, `${call.name}: bad arguments`);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return failed(`the arguments of ${call.name} must be a JSON object`, `${call.name}: bad arguments`);
  try {
    return await def.run(ctx, args as Record<string, unknown>, answer);
  } catch (e) {
    return failed(`${call.name} failed: ${e instanceof Error ? e.message : String(e)}`, `${call.name} failed`);
  }
}

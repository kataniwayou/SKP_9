import type { Id } from '../../model/graph';
import type { OutputLine } from '../../output/outputStore';
import type { ChatEntry } from '../chatStore';
import { workflowArg, type ToolContext, type ToolDef, type ToolOutcome } from '../toolTypes';

export const done = (ok: boolean, result: string, action: string, entries: ChatEntry[] = []): ToolOutcome =>
  ({ kind: 'done', ok, result, action, entries });
export const fail = (result: string, action: string, entries: ChatEntry[] = []): ToolOutcome => done(false, result, action, entries);

export const WORKFLOW_ID = { type: 'string', description: 'The id of the workflow (list_workflows gives it).' };
export const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

/** A workflow's tool argument (the pinned id wins, when the call is answering a question), or the failed outcome to return. */
export function target(ctx: ToolContext, args: Record<string, unknown>, action: string, pin?: string): { id: Id; name: string } | { out: ToolOutcome } {
  const w = workflowArg(ctx, pin !== undefined ? { workflow_id: pin } : args);
  return 'error' in w ? { out: fail(w.error, action) } : w;
}

const entryOf = (l: OutputLine, name: string): ChatEntry => ({ kind: 'output', text: l.text, level: l.level, name });

/** The lines Output gained since `before` was taken: robust to clear() (all there is then) and to the order toggle. */
export function linesSince(ctx: ToolContext, before: OutputLine | undefined): OutputLine[] {
  const all = ctx.output.lines();
  if (before === undefined) return [...all];
  const at = all.lastIndexOf(before);
  return at < 0 ? [...all] : all.slice(at + 1);
}

/** True for the lines a workflow's own action logs: they start with its name (`<name> ...` or `<name>: ...`). */
const ownLine = (name: string, l: OutputLine): boolean => l.text === name || l.text.startsWith(`${name} `) || l.text.startsWith(`${name}:`);

/**
 * Runs `fn` and returns the Output lines the action itself logged meanwhile: those appended during the call that
 * begin with the workflow's name. Lines of other workflows or of the live set, logged while the call waited, are not
 * its result.
 */
export async function withOutput<T>(ctx: ToolContext, name: string, fn: () => T | Promise<T>): Promise<{ value: T; lines: OutputLine[]; entries: ChatEntry[] }> {
  const before = ctx.output.lines().at(-1);
  const value = await fn();
  const lines = linesSince(ctx, before).filter((l) => ownLine(name, l));
  return { value, lines, entries: lines.map((l) => entryOf(l, name)) };
}

/** The lines as one text for the model; `fallback` when there were none. */
export const textOf = (lines: OutputLine[], fallback = ''): string => (lines.length === 0 ? fallback : lines.map((l) => l.text).join('; '));

/**
 * A tool that is not there yet: the edit tools are rewritten for the triangle board in Plan 5 Task 13. It keeps its
 * name (the prompt still names it) and answers, doing nothing, that it is not available.
 */
export function notYet(name: string, what: string): ToolDef {
  return {
    name,
    description: `${what} Not available yet: the chat's edit tools are being rewritten for the triangle board. It answers so and does nothing.`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    run: async () => fail(`${name} is not available yet: the chat's edit tools are being rewritten for the triangle board. Ask the user to make this change on the board.`, `${name} not available yet`),
  };
}

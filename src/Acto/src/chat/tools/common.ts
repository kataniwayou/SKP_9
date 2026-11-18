import type { BoardState, Edit } from '../../design/board';
import type { Id } from '../../model/graph';
import type { OutputLine } from '../../output/outputStore';
import type { ChatEntry } from '../chatStore';
import { workflowArg, type ToolContext, type ToolOutcome } from '../toolTypes';

/** A tool run that came to an answer. */
export type Done = Extract<ToolOutcome, { kind: 'done' }>;
export const done = (ok: boolean, result: string, action: string, entries: ChatEntry[] = []): Done =>
  ({ kind: 'done', ok, result, action, entries });
export const fail = (result: string, action: string, entries: ChatEntry[] = []): Done => done(false, result, action, entries);

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

export const STEP_ID = { type: 'string', description: 'The id of the step (read_board gives it).' };
export const CACHE_ID = { type: 'string', description: 'The id of the cache (read_board or list_caches gives it).' };

/** A text argument; '' when it is missing or not text. */
export const text = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');

/** The id a tool argument names as a thing of the board, or the failed outcome (`no <what> <id> on the board`). */
export function onBoard(ctx: ToolContext, what: 'step' | 'cache' | 'workflow', id: string, action: string): { id: Id } | { out: ToolOutcome } {
  const table = what === 'step' ? ctx.store.state().steps : what === 'cache' ? ctx.store.state().caches : ctx.store.state().workflows;
  return id !== '' && table[id] ? { id } : { out: fail(`no ${what} ${id === '' ? '(none given)' : id} on the board`, action) };
}

/**
 * Applies an edit that may refuse as one board edit (one history step, no merge key). A refusal is the edit's own text
 * (also in Output, as the user's own gesture would show it); so is the board's, while it saves. Nothing done = failed.
 */
export function applyEdit(ctx: ToolContext, fn: (b: BoardState) => Edit, action: string, okText: string): Done {
  const before = ctx.store.state();
  const res = fn(before);
  if ('refused' in res) {
    ctx.store.editOrRefuse(() => res);
    return fail(res.refused, `${action} refused`);
  }
  return applyState(ctx, () => res.state, action, okText);
}

/** Applies an edit that cannot refuse; failed only when the board did not change (it is saving, or nothing differed). */
export function applyState(ctx: ToolContext, fn: (b: BoardState) => BoardState, action: string, okText: string): Done {
  const before = ctx.store.state();
  const mark = ctx.output.lines().at(-1);
  ctx.store.edit(fn);
  if (ctx.store.state() !== before) return done(true, okText, action);
  const lines = linesSince(ctx, mark).map((l) => l.text);
  return fail(lines.join('; ') || 'nothing changed: the board already is so', `${action}: no change`);
}

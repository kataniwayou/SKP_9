import type { Id } from '../../model/graph';
import type { OutputLine } from '../../output/outputStore';
import type { WorkflowState } from '../../design/state';
import type { ChatEntry } from '../chatStore';
import { workflowArg, type ToolContext, type ToolOutcome } from '../toolTypes';

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
 * One edit of a workflow, through the store the user edits (Plan 4 Review Focus 1). `fn` returns the next state, or
 * `{ refused }` for a rule of its own. The store may still refuse (the workflow is saving, an entity is being changed
 * in another workflow): the state is then unchanged, and the Output line the store logged comes back as the failed
 * result. `merge` is the history's merge key (the chat's own: `chat:...`). Used by the design and field tools too.
 */
export async function edit(
  ctx: ToolContext, workflowId: Id, fn: (s: WorkflowState) => WorkflowState | { refused: string }, merge?: string,
): Promise<{ ok: boolean; result: string; lines: OutputLine[]; entries: ChatEntry[] }> {
  const before = ctx.store.entry(workflowId);
  if (!before) return { ok: false, result: `no workflow ${workflowId} on the board`, lines: [], entries: [] };
  const name = before.history.present.fields.name;
  // the edit is synchronous: every line logged during it is the store's own (a refusal names its own entity)
  const mark = ctx.output.lines().at(-1);
  const res = fn(before.history.present);
  if ('refused' in res) ctx.store.editOrRefuse(workflowId, () => res);
  else ctx.store.edit(workflowId, () => res, merge);
  const lines = linesSince(ctx, mark);
  const entries = lines.map((l) => entryOf(l, name));
  const now = ctx.store.entry(workflowId);
  if (now !== null && now.history.present !== before.history.present) return { ok: true, result: textOf(lines, 'done'), lines, entries };
  if (res && !('refused' in res) && res === before.history.present) return { ok: true, result: 'nothing to change', lines, entries };
  return { ok: false, result: textOf(lines, `${name}: the edit was refused`), lines, entries };
}

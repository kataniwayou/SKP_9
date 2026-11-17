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

/** Runs `fn` and returns what it logged to Output meanwhile (the lines the user's own gesture would have shown). */
export async function withOutput<T>(ctx: ToolContext, name: string, fn: () => T | Promise<T>): Promise<{ value: T; lines: OutputLine[]; entries: ChatEntry[] }> {
  const lines: OutputLine[] = [];
  const unsub = ctx.output.subscribe(() => {
    const all = ctx.output.lines();
    const last = all[all.length - 1];
    if (last) lines.push(last);
  });
  try {
    const value = await fn();
    return { value, lines, entries: lines.map((l) => entryOf(l, name)) };
  } finally { unsub(); }
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
  const { lines, entries } = await withOutput(ctx, before.history.present.fields.name, () => {
    const res = fn(before.history.present);
    if ('refused' in res) ctx.store.editOrRefuse(workflowId, () => res);
    else ctx.store.edit(workflowId, () => res, merge);
  });
  const now = ctx.store.entry(workflowId);
  if (now !== null && now.history.present !== before.history.present) return { ok: true, result: textOf(lines, 'done'), lines, entries };
  const refusals = lines.filter((l) => l.level === 'warn' || l.level === 'error');
  if (refusals.length > 0) return { ok: false, result: textOf(refusals), lines, entries };
  return { ok: true, result: 'nothing to change', lines, entries };
}

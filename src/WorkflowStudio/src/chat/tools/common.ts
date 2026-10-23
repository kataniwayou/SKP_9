import { describeError } from '../../api/describeError';
import type { Id } from '../../model/graph';
import { activeDocument, type OpenDocument } from '../../store/studioState';
import type { ChatEntry } from '../chatStore';
import { echoText } from '../echo';
import { findWorkflow, type Found } from '../resolve';
import type { ToolContext, ToolOutcome } from '../toolTypes';

// What every tool file shares (2026-10-23): reading the arguments, naming things, the outcome shapes, and the rules for
// which workflow a call means, the question's pin rule among them, in one place.

/** A non-blank string argument, else undefined. */
export const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
/** "name version", either part possibly missing (the DTOs' fields are optional on the wire). */
export const labelOf = (d: { name?: string | null; version?: string | null }): string => `${d.name ?? ''} ${d.version ?? ''}`.trim();
export const docOf = (ctx: ToolContext, id: Id): OpenDocument | undefined => ctx.store.getState().docs.find((d) => d.workflowId === id);

/** What the model hears is `head`, then the echoed Output lines and problems; the chat shows `action` and the same lines. */
export function done(ok: boolean, head: string, action: string, entries: ChatEntry[] = []): ToolOutcome {
  const echo = echoText(entries);
  return { kind: 'done', ok, result: echo === '' ? head : `${head}\n${echo}`, action, entries };
}
export const fail = (error: string, action: string): ToolOutcome => done(false, error, action);

export const WORKFLOW_ARG = {
  type: 'string',
  description: 'The workflow: its id, name, or "name version". Leave out for the workflow the user has open (the active one).',
};
export const WORKFLOW_REQUIRED = { ...WORKFLOW_ARG, description: 'The workflow: its id, name, or "name version".' };
export const YES_NO = ['Yes', 'No'] as const;

/** A tool's document, or the outcome saying why there is none. */
export type DocChoice = { doc: OpenDocument } | { out: ToolOutcome };

/** The workflow a tool means: the one named, else the active one; `doc` is its open document, null when it is not open. */
export async function workflowOf(ctx: ToolContext, ref: string | undefined): Promise<Found<{ id: string; doc: OpenDocument | null }>> {
  const state = ctx.store.getState();
  if (ref === undefined) {
    const active = activeDocument(state);
    return active ? { ok: true, value: { id: active.workflowId, doc: active } } : { ok: false, error: 'no workflow is open' };
  }
  const list = await ctx.api.listWorkflows();
  // an open document is found without the list; otherwise "no workflow named X" would blame the name for a failed list
  const found = findWorkflow(list.ok ? list.value : [], state.docs, ref);
  if (!found.ok && !list.ok && !found.ambiguous) return { ok: false, error: `could not read the list of workflows. ${describeError(list.error)}` };
  if (!found.ok) return found;
  return { ok: true, value: { id: found.value, doc: state.docs.find((d) => d.workflowId === found.value) ?? null } };
}

/** An open workflow the tool means: the one named, else the active one; or why there is none. */
export async function openDocOf(ctx: ToolContext, ref: string | undefined, action: string): Promise<DocChoice> {
  const w = await workflowOf(ctx, ref);
  if (!w.ok) return { out: fail(w.error, action) };
  if (w.value.doc === null) return { out: fail(`workflow ${ref} is not open; open it first`, action) };
  return { doc: w.value.doc };
}

/**
 * The pin rule of a call that asks the user first. Asking: `asking` finds the workflow (the one named, else the active
 * one). Answering: only the one the question named (`pin`, carried by the question itself and so kept over a tab switch
 * or a refresh), never the active one; no pin, nothing is done. `check` judges the pinned document as `asking` would.
 */
export async function questionDocOf(
  ctx: ToolContext, tool: string, answer: string | undefined, pin: string | undefined,
  asking: () => Promise<DocChoice>, check: (doc: OpenDocument) => DocChoice = (doc) => ({ doc }),
): Promise<DocChoice> {
  if (answer === undefined) return asking();
  if (pin === undefined) return { out: fail('the question lost its workflow; nothing was done: ask again', `${tool}: question lost`) };
  const doc = docOf(ctx, pin);
  return doc ? check(doc) : { out: fail('the workflow is no longer open; nothing was done', `${tool}: workflow gone`) };
}

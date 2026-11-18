import type { Id } from '../model/graph';

/** One picked thing on the board (spec §4); `selectPick` below is the behaviour. */
export type Pick =
  | { kind: 'workflow'; id: Id }
  | { kind: 'step'; id: Id }
  | { kind: 'cache'; id: Id }
  | { kind: 'wire'; from: Id; to: Id }
  | { kind: 'entry'; workflowId: Id; stepId: Id }
  | { kind: 'cacheLink'; workflowId: Id; cacheId: Id }
  | { kind: 'ghost'; key: string };

export interface SelectionState { workflows: Id[]; picks: Pick[] }

const same = (a: Pick, b: Pick): boolean => JSON.stringify(a) === JSON.stringify(b);

/** `workflows` is always the picked triangles, in pick order (it carries their hues). */
const withWorkflows = (picks: Pick[]): SelectionState => ({ workflows: picks.flatMap((p) => (p.kind === 'workflow' ? [p.id] : [])), picks });

/**
 * A selection brought into the one shape (a saved one from before, say): every id in `workflows` is a picked triangle
 * and `workflows` is the picked triangles.
 */
export function synced(s: SelectionState): SelectionState {
  const picks = [...s.picks];
  for (const id of s.workflows) if (!picks.some((p) => p.kind === 'workflow' && p.id === id)) picks.push({ kind: 'workflow', id });
  return withWorkflows(picks);
}

/**
 * What a click on `p` (null = the empty board) does to the selection (spec §4, rule 1 [user, 2026-11-18]):
 * - Ctrl+click toggles `p` in or out; a plain click on something already selected takes only it out;
 * - a plain click on an unselected triangle replaces the selected triangles, keeps the selected steps, drops the rest;
 * - on an unselected step it replaces the selected steps, keeps the selected triangles, drops the rest;
 * - on an unselected cache, wire, entry arrow, cache line or ghost it selects that alone;
 * - the empty board clears everything.
 */
export function selectPick(prev: SelectionState, p: Pick | null, additive: boolean): SelectionState {
  if (p === null) return { workflows: [], picks: [] };
  const cur = synced(prev).picks;
  if (cur.some((x) => same(x, p))) return withWorkflows(cur.filter((x) => !same(x, p)));
  if (additive) return withWorkflows([...cur, p]);
  if (p.kind === 'workflow') return withWorkflows([...cur.filter((x) => x.kind === 'step'), p]);
  if (p.kind === 'step') return withWorkflows([...cur.filter((x) => x.kind === 'workflow'), p]);
  return withWorkflows([p]);
}

/** What the chat's `pick` does to the selection: the picks it gives, as they are (its triangles are the selected workflows). */
export function withPicks(_prev: SelectionState, picks: Pick[]): SelectionState {
  return withWorkflows(picks);
}

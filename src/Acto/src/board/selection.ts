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

/**
 * What a click on `p` (null = the empty board) does to the selection (spec §4, [user, 2026-11-18]):
 * - Ctrl toggles `p` in or out (a triangle in `workflows` too);
 * - a plain click on something already selected unselects only it: a triangle (selected = in `workflows`) leaves
 *   `workflows` and the picks; anything else leaves the picks and the workflows stay selected;
 * - a plain click on an unpicked triangle selects it alone; on anything else it replaces the other picks and keeps the
 *   selected workflows (an entry arrow or a cache line selects its workflow alone);
 * - the empty board clears everything.
 */
export function selectPick(prev: SelectionState, p: Pick | null, additive: boolean): SelectionState {
  if (p === null) return { workflows: [], picks: [] };
  const picked = prev.picks.some((x) => same(x, p));
  if (p.kind === 'workflow') {
    // selected = drawn selected, i.e. in `workflows`; one decision for both lists, so they cannot diverge
    if (picked || prev.workflows.includes(p.id)) {
      return { workflows: prev.workflows.filter((x) => x !== p.id), picks: prev.picks.filter((x) => !same(x, p)) };
    }
    if (!additive) return { workflows: [p.id], picks: [p] };
    return { workflows: prev.workflows.includes(p.id) ? prev.workflows : [...prev.workflows, p.id], picks: [...prev.picks, p] };
  }
  if (picked) return { workflows: prev.workflows, picks: prev.picks.filter((x) => !same(x, p)) };
  if (additive) return { workflows: prev.workflows, picks: [...prev.picks, p] };
  const workflows = p.kind === 'entry' || p.kind === 'cacheLink' ? [p.workflowId] : prev.workflows;
  return { workflows, picks: [p] };
}

/**
 * What the chat's `pick` does to the selection: the picks are replaced; picked triangles become the selected workflows
 * (in the order given), otherwise the selected workflows stay as they are, as with a click on a step.
 */
export function withPicks(prev: SelectionState, picks: Pick[]): SelectionState {
  const ids = picks.flatMap((p) => (p.kind === 'workflow' ? [p.id] : []));
  return { workflows: ids.length > 0 ? ids : prev.workflows, picks };
}

import type { Id } from '../model/graph';

/** One picked thing on the board (spec §6). Task 11 adds the behaviour (selectPick); this is the shape. */
export type Pick =
  | { kind: 'workflow'; id: Id }
  | { kind: 'step'; id: Id }
  | { kind: 'cache'; id: Id }
  | { kind: 'wire'; from: Id; to: Id }
  | { kind: 'entry'; workflowId: Id; stepId: Id }
  | { kind: 'cacheLink'; workflowId: Id; cacheId: Id };

export interface SelectionState { workflow: Id | null; picks: Pick[] }

const same = (a: Pick, b: Pick): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a click on `p` (null = the empty board) does to the selection (spec §6). A triangle click selects that workflow
 * alone (Ctrl ignored: no multi-select of triangles). A step, cache or wire click keeps the workflow and replaces the
 * picks, or with Ctrl toggles it among them (never alongside a triangle). An entry arrow or cache line selects its workflow.
 */
export function selectPick(prev: SelectionState, p: Pick | null, additive: boolean): SelectionState {
  if (p === null) return { workflow: null, picks: [] };
  if (p.kind === 'workflow') return { workflow: p.id, picks: [p] };
  const workflow = p.kind === 'entry' || p.kind === 'cacheLink' ? p.workflowId : prev.workflow;
  if (!additive) return { workflow, picks: [p] };
  const rest = prev.picks.filter((x) => x.kind !== 'workflow');
  const present = rest.some((x) => same(x, p));
  return { workflow, picks: present ? rest.filter((x) => !same(x, p)) : [...rest, p] };
}

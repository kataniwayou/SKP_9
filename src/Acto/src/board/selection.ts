import type { Id } from '../model/graph';

/** One picked thing on the board (spec §6). Task 11 adds the behaviour (selectPick); this is the shape. */
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
 * What a click on `p` (null = the empty board) does to the selection (spec §4). A triangle click selects that workflow
 * alone; with Ctrl it toggles the workflow in `workflows` and its pick in `picks`. Any other click keeps `workflows`
 * and replaces the picks, or with Ctrl toggles `p` among them. An entry arrow or cache line click selects its
 * workflow alone.
 */
export function selectPick(prev: SelectionState, p: Pick | null, additive: boolean): SelectionState {
  if (p === null) return { workflows: [], picks: [] };
  const toggled = (): Pick[] => (prev.picks.some((x) => same(x, p)) ? prev.picks.filter((x) => !same(x, p)) : [...prev.picks, p]);
  if (p.kind === 'workflow') {
    if (!additive) return { workflows: [p.id], picks: [p] };
    const workflows = prev.workflows.includes(p.id) ? prev.workflows.filter((x) => x !== p.id) : [...prev.workflows, p.id];
    return { workflows, picks: toggled() };
  }
  if (!additive) {
    const workflows = p.kind === 'entry' || p.kind === 'cacheLink' ? [p.workflowId] : prev.workflows;
    return { workflows, picks: [p] };
  }
  return { workflows: prev.workflows, picks: toggled() };
}

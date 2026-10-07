import type { StudioDocument } from '../app/document';
import { snap, type Point } from '../layout/geometry';
import type { Placement } from '../layout/placement';
import { routeWires } from '../layout/wires';
import type { Graph, Id, Step } from '../model/graph';
import { reachableStepIds } from '../model/reachability';
import { isEmptyDraft, type Draft } from './draft';

/**
 * What the canvas shows (spec §5.1): the saved workflow with the draft laid over it. The wiring decides
 * reachability and so the parked steps (§3.5); moved blocks sit where the draft has them (the automatic
 * layout is not run again); wires are routed again with the draft's shapes. Parts naming what the saved
 * document does not have are ignored. Pure; an empty draft gives the saved document back unchanged.
 */
export function applyDraft(saved: StudioDocument, draft: Draft): StudioDocument {
  if (isEmptyDraft(draft)) return saved;
  const { graph } = saved;
  const has = (id: Id) => graph.steps.has(id);

  const steps = new Map<Id, Step>(graph.steps);
  for (const [id, next] of Object.entries(draft.next)) {
    const step = steps.get(id);
    if (step) steps.set(id, { ...step, nextStepIds: next.filter(has) });
  }
  const entryStepIds = (draft.entries ?? graph.workflow.entryStepIds).filter(has);
  const shownGraph: Graph = { ...graph, workflow: { ...graph.workflow, entryStepIds }, steps };

  const reachable = new Set(reachableStepIds(entryStepIds, steps));
  const parkedIds = [
    ...saved.parkedIds.filter((id) => !reachable.has(id)),
    ...[...steps.keys()].filter((id) => !reachable.has(id) && !saved.parkedIds.includes(id)),
  ];

  const placement: Placement = {
    sphere: draft.sphere ? { cx: snap(draft.sphere.x), cy: snap(draft.sphere.y) } : saved.placement.sphere,
    steps: overlay(saved.placement.steps, draft.steps),
    caches: overlay(saved.placement.caches, draft.caches),
  };
  // broken marks come from validate on the saved workflow (§4.4): a wire the draft made is never marked
  const brokenEdges = new Set(saved.wires.filter((w) => w.broken).map((w) => w.id));
  const wires = routeWires({ entryStepIds, steps, brokenEdges, shapes: draft.routes }, placement);
  return { graph: shownGraph, parkedIds, placement, wires, problems: saved.problems };
}

function overlay(base: ReadonlyMap<Id, Point>, moved: Readonly<Record<Id, Point>>): Map<Id, Point> {
  const out = new Map(base);
  for (const [id, p] of Object.entries(moved)) if (out.has(id)) out.set(id, { x: snap(p.x), y: snap(p.y) });
  return out;
}

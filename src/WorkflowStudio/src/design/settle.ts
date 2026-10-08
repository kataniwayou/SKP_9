import type { StudioDocument } from '../app/document';
import { plainWireId, removeCircuitWires, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import { circuitTrace, shortedWires } from '../circuit/families';
import { linkKeys, trace, wiresBetween } from '../circuit/trace';
import { endPointOf, routeCircuit } from '../layout/circuitRoute';
import type { Point } from '../layout/geometry';
import { WORKFLOW_SOURCE } from '../layout/ports';
import type { Id } from '../model/graph';

const onCanvas = (saved: StudioDocument, id: Id) => saved.graph.steps.has(id) && saved.placement.steps.has(id);

/**
 * The links a design says the workflow has (plan 9 §7): the saved workflow's lists with the design's own over them
 * (`next` by step, `entries`; what a stored design or a session holds), both ends on the canvas, as `source->target`.
 */
export function expectedLinks(saved: StudioDocument, next: Readonly<Record<Id, Id[]>>, entries: readonly Id[] | null): Set<string> {
  const out = new Set<string>();
  for (const t of entries ?? saved.graph.workflow.entryStepIds) if (onCanvas(saved, t)) out.add(plainWireId(WORKFLOW_SOURCE, t));
  for (const [id, step] of saved.graph.steps) {
    if (!onCanvas(saved, id)) continue;
    for (const t of Object.hasOwn(next, id) ? next[id]! : step.nextStepIds) if (onCanvas(saved, t)) out.add(plainWireId(id, t));
  }
  return out;
}

/** Where each wire's ends are drawn, to open an end where it is. */
const drawnEnds = (c: Readonly<Circuit>, saved: StudioDocument): ((id: string, side: Side) => Point | null) =>
  endPointOf(routeCircuit(c, { placement: saved.placement, steps: saved.graph.steps }));

/** A plan 7 wire's own target: the step its id `s->t` names, when it is on the canvas. */
function ownTarget(id: string, saved: StudioDocument): Id | null {
  const at = id.indexOf('->');
  const t = at > 0 ? id.slice(at + 2) : '';
  return t !== '' && onCanvas(saved, t) ? t : null;
}

/** The chosen junction ends drawn plain: a plan 7 head back into its own step, any other end open where it is drawn. */
function plainEnds(c: Circuit, saved: StudioDocument, pick: (id: string, side: Side) => boolean): Circuit {
  const point = drawnEnds(c, saved);
  let out = c;
  for (const [id, w] of Object.entries(c)) {
    for (const side of ['tail', 'head'] as const) {
      if (w[side].on !== 'wire' || !pick(id, side)) continue;
      const own = side === 'head' ? ownTarget(id, saved) : null;
      const p = point(id, side) ?? { x: 0, y: 0 };
      out = setEnd(out, id, side, own !== null ? { on: 'step', step: own, y: null } : { on: 'open', x: p.x, y: p.y });
    }
  }
  return out;
}

/** A new automatic wire for each link (`source->target`), by that id when it is free. */
function addPlain(c: Circuit, links: readonly string[]): Circuit {
  const out = Object.assign(Object.create(null) as Circuit, c);
  for (const k of links) {
    const at = k.indexOf('->');
    const source = k.slice(0, at), target = k.slice(at + 2);
    let id = k;
    for (let n = 2; Object.hasOwn(out, id); n++) id = `${k}#${n}`;
    out[id] = { tail: source === WORKFLOW_SOURCE ? { on: 'hub', angle: null } : { on: 'step', step: source, y: null }, head: { on: 'step', step: target, y: null } };
  }
  return out;
}

/**
 * The circuit made to agree with `expected` (decision 6; spec §7 "on load", §8): wires with an end on a step that is
 * not on the canvas go and ends on a wire that is gone open where they are drawn; then, round by round, a missing
 * link is made by a plan 7 wire `s->t` with its head on a junction (back into `t`), an unexpected link has every
 * junction on its way drawn plain, a plain wire still making one goes, and what is still missing gets a new
 * automatic wire. Links through a short-circuited net count as made and are never unexpected; "written" is what Save
 * writes (`circuitTrace`: shorted nets and a step fed its own input left out).
 */
export function reconcile(start: Readonly<Circuit>, expected: ReadonlySet<string>, saved: StudioDocument): Circuit {
  const placed = (e: End) => e.on !== 'step' || onCanvas(saved, e.step);
  const kept = Object.assign(Object.create(null) as Circuit, Object.fromEntries(Object.entries(start).filter(([, w]) => placed(w.tail) && placed(w.head))));
  let c = plainEnds(kept, saved, (id, side) => { const e = kept[id]![side]; return e.on === 'wire' && !Object.hasOwn(kept, e.host); });
  const conditionOf = (id: Id) => saved.graph.steps.get(id)?.entryCondition;
  for (let round = 0; round < 16; round++) {
    const current = circuitTrace(c, conditionOf);
    const shorted = shortedWires(current.nets);
    const made = linkKeys(trace(c).links);
    const written = linkKeys(current.links);
    const missing = [...expected].filter((k) => !made.has(k));
    const extra = [...written].filter((k) => !expected.has(k));
    if (missing.length === 0 && extra.length === 0) return c;
    const own = new Set(missing.filter((k) => Object.hasOwn(c, k) && c[k]!.head.on === 'wire'));
    if (own.size > 0) {
      c = plainEnds(c, saved, (id, side) => side === 'head' && own.has(id));
      continue;
    }
    if (extra.length > 0) {
      const onWay = new Set(extra.flatMap((k) => { const at = k.indexOf('->'); return [...wiresBetween(c, k.slice(0, at), k.slice(at + 2), shorted)]; }));
      const joined = new Set([...onWay].filter((id) => c[id]!.tail.on === 'wire' || c[id]!.head.on === 'wire'));
      c = joined.size > 0 ? plainEnds(c, saved, (id) => joined.has(id)) : removeCircuitWires(c, [...onWay], drawnEnds(c, saved));
      continue;
    }
    c = addPlain(c, missing);
  }
  return c;
}

import type { StudioDocument } from '../app/document';
import { plainWireId, removeCircuitWires, setEnd, type Circuit, type End, type Side } from '../circuit/circuit';
import { circuitTrace, heldSources, shortedWires } from '../circuit/families';
import { linkKeys, trace, wiresBetween } from '../circuit/trace';
import { endPointOf, routeCircuit } from '../layout/circuitRoute';
import type { Point } from '../layout/geometry';
import { WORKFLOW_SOURCE } from '../layout/ports';
import type { Id } from '../model/graph';
import { applyEdits } from './apply';
import type { Design } from './design';
import { withCircuit, type Draft } from './draft';

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

/** The link a wire's id names: `s->t`, or `s->t#n` (one `addPlain` made while `s->t` was taken); null for `w:…`. */
function linkOfId(id: string): string | null {
  const base = id.replace(/#\d+$/, '');
  const at = base.indexOf('->');
  return at > 0 && at + 2 < base.length ? base : null;
}

/** A plan 7 wire's own target: the step its id `s->t` (or `s->t#n`) names, when it is on the canvas. */
function ownTarget(id: string, saved: StudioDocument): Id | null {
  const k = linkOfId(id);
  const t = k === null ? '' : k.slice(k.indexOf('->') + 2);
  return t !== '' && onCanvas(saved, t) ? t : null;
}

/** The wires current passes through for each link (`source->target`). */
function wiresOfLinks(c: Readonly<Circuit>, links: readonly string[], skip: ReadonlySet<string>): Set<string> {
  return new Set(links.flatMap((k) => { const at = k.indexOf('->'); return [...wiresBetween(c, k.slice(0, at), k.slice(at + 2), skip)]; }));
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
 * automatic wire. Links through a short-circuited net count as made and are never unexpected, and so are all links of
 * a source with a wire in such a net (`heldSources`: Save keeps those sources' loaded lists, so their drawing waits for
 * the short circuit to be fixed); "written" is what Save
 * writes (`circuitTrace`: shorted nets and a step fed its own input left out). Of the junctions on an unexpected
 * link's way, those also on the way of a written expected link are kept (they carry a link the workflow has); only
 * when that leaves none are they all drawn plain. Every round takes away a junction end or a wire, or adds the missing
 * wires, so it settles within the cap; should it not, the circuit is returned as it is, with a warning in dev.
 */
export function reconcile(start: Readonly<Circuit>, expected: ReadonlySet<string>, saved: StudioDocument): Circuit {
  const placed = (e: End) => e.on !== 'step' || onCanvas(saved, e.step);
  const kept = Object.assign(Object.create(null) as Circuit, Object.fromEntries(Object.entries(start).filter(([, w]) => placed(w.tail) && placed(w.head))));
  let c = plainEnds(kept, saved, (id, side) => { const e = kept[id]![side]; return e.on === 'wire' && !Object.hasOwn(kept, e.host); });
  const conditionOf = (id: Id) => saved.graph.steps.get(id)?.entryCondition;
  // a round opens a junction end (two a wire at most), removes a wire, or adds missing wires
  const cap = 3 * Object.keys(start).length + expected.size + 2;
  for (let round = 0; round < cap; round++) {
    const current = circuitTrace(c, conditionOf);
    const shorted = shortedWires(current.nets);
    const made = linkKeys(trace(c).links);
    const written = linkKeys(current.links);
    const held = heldSources(c, current.nets);
    const free = (k: string) => !held.has(k.slice(0, k.indexOf('->')));
    const missing = [...expected].filter((k) => !made.has(k) && free(k));
    const extra = [...written].filter((k) => !expected.has(k) && free(k));
    if (missing.length === 0 && extra.length === 0) return c;
    const lost = new Set(missing);
    const own = new Set(Object.keys(c).filter((id) => { const k = linkOfId(id); return k !== null && lost.has(k) && c[id]!.head.on === 'wire'; }));
    if (own.size > 0) {
      c = plainEnds(c, saved, (id, side) => side === 'head' && own.has(id));
      continue;
    }
    if (extra.length > 0) {
      const onWay = wiresOfLinks(c, extra, shorted);
      const joined = [...onWay].filter((id) => c[id]!.tail.on === 'wire' || c[id]!.head.on === 'wire');
      const needed = wiresOfLinks(c, [...written].filter((k) => expected.has(k)), shorted);
      const loose = joined.filter((id) => !needed.has(id));
      const open = new Set(loose.length > 0 ? loose : joined);
      c = open.size > 0 ? plainEnds(c, saved, (id) => open.has(id)) : removeCircuitWires(c, [...onWay], drawnEnds(c, saved));
      continue;
    }
    c = addPlain(c, missing);
  }
  if (import.meta.env.DEV) console.warn(`settle: the circuit did not agree with the workflow after ${cap} rounds`);
  return c;
}

/**
 * A draft made to agree with the workflow (decision 6): its circuit settled against what its own lists say. A draft
 * with no circuit of its own is the workflow's wiring: nothing to settle.
 */
export function settleDraft(draft: Draft, saved: StudioDocument): Draft {
  if (draft.wires === null) return draft;
  return withCircuit(draft, saved, reconcile(draft.wires, expectedLinks(saved, draft.next, draft.entries), saved));
}

/** A design as it opens (the stored one, or a session's): its draft settled against the base with its own entity edits over it. */
export function settleDesign(design: Design, saved: StudioDocument): Design {
  if (design.draft.wires === null) return design;
  return { ...design, draft: settleDraft(design.draft, applyEdits(saved, design.edits)) };
}

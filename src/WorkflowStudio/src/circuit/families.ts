import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Id } from '../model/graph';
import { isFree, type Circuit } from './circuit';
import { trace, type Trace } from './trace';

/** Wires joined through junctions (plan 9 §2.2-2), and the families (entry conditions) their heads on steps decide. */
export interface Net {
  wires: string[];
  /** Ascending. None: undecided (grey, rule 12); two or more: a short circuit (§2.2-7). */
  families: number[];
}

/**
 * The nets of a circuit, in the order of their first wire. A tail decides nothing (rule 7); a head on a step decides
 * (rule 9). A direction-less wire (rule D) is in no live net (the user's rule 1, 2026-10-09: "it's just a wire"): it is
 * a net of its own, undecided, and a junction on it or of it joins nothing, so no wire takes a family through it.
 */
export function netsOf(circuit: Readonly<Circuit>, conditionOf: (step: Id) => number | undefined): Net[] {
  const parent = new Map<string, string>(Object.keys(circuit).map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let y = x; parent.get(y) !== r; ) { const n = parent.get(y)!; parent.set(y, r); y = n; }
    return r;
  };
  const join = (a: string, b: string) => { if (parent.has(b) && !isFree(circuit[b]!)) parent.set(find(a), find(b)); };
  for (const [id, w] of Object.entries(circuit)) {
    if (isFree(w)) continue;
    if (w.tail.on === 'wire') join(id, w.tail.host);
    if (w.head.on === 'wire') join(id, w.head.host);
  }
  const byRoot = new Map<string, Net>();
  for (const [id, w] of Object.entries(circuit)) {
    const root = find(id);
    const net = byRoot.get(root) ?? { wires: [], families: [] };
    byRoot.set(root, net);
    net.wires.push(id);
    const f = w.head.on === 'step' ? conditionOf(w.head.step) : undefined;
    if (f !== undefined && !net.families.includes(f)) net.families.push(f);
  }
  const nets = [...byRoot.values()];
  for (const n of nets) n.families.sort((a, b) => a - b);
  return nets;
}

/**
 * The wires of short-circuited nets, whose links are never written (plan 9 §7): nets whose families disagree, and
 * (`overlapping`, the user's rule 2, 2026-10-09) every net with a wire lying on a wire of another net.
 */
export function shortedWires(nets: readonly Net[], overlapping: Iterable<string> = []): Set<string> {
  const hit = new Set(overlapping);
  return new Set(nets.filter((n) => n.families.length > 1 || (hit.size > 0 && n.wires.some((x) => hit.has(x)))).flatMap((n) => n.wires));
}

/**
 * The current as Save writes it (plan 9 §7): short-circuited nets left out. A step's current reaching its own input (one
 * wire on both its sides, or through junctions) is a link like any other (the user's ruling, 2026-10-20: free style);
 * those steps are also named in `selfFed`.
 */
export function circuitTrace(
  circuit: Readonly<Circuit>,
  conditionOf: (step: Id) => number | undefined,
  /** Wires lying on a wire of another net (`overlapShorts`): their nets are short-circuited too. */
  overlapping: Iterable<string> = [],
): Trace & { nets: Net[]; selfFed: Id[]; shorted: Set<string> } {
  const nets = netsOf(circuit, conditionOf);
  const shorted = shortedWires(nets, overlapping);
  const t = trace(circuit, shorted);
  const links = new Map<SourceId, Id[]>();
  const selfFed: Id[] = [];
  for (const [s, ts] of t.links) {
    if (ts.includes(s as Id)) selfFed.push(s as Id);
    if (ts.length > 0) links.set(s, [...ts]);
  }
  return { links, loop: t.loop, nets, selfFed, shorted };
}

/**
 * The sources held back by short circuits (plan 9 §7, controller ruling): the step of every tail on a step, and the hub
 * (`wf`) for a tail on it, among the wires of short-circuited nets (`shorted`, from `shortedWires`). Every wire joined into a net is in it, so
 * these tails are all the current that can enter it. Save sends these sources' lists as the workflow has them, and
 * settling neither expects nor removes their links, so the drawing waits until the short circuit is fixed.
 */
export function heldSources(circuit: Readonly<Circuit>, shorted: Iterable<string>): Set<SourceId> {
  const out = new Set<SourceId>();
  for (const id of shorted) {
    if (!Object.hasOwn(circuit, id)) continue;
    const t = circuit[id]!.tail;
    if (t.on === 'step') out.add(t.step);
    else if (t.on === 'hub') out.add(WORKFLOW_SOURCE);
  }
  return out;
}

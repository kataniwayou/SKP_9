import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Id } from '../model/graph';
import type { Circuit } from './circuit';
import { trace, type Trace } from './trace';

/** Wires joined through junctions (plan 9 §2.2-2), and the families (entry conditions) their heads on steps decide. */
export interface Net {
  wires: string[];
  /** Ascending. None: undecided (grey, rule 12); two or more: a short circuit (§2.2-7). */
  families: number[];
}

/** The nets of a circuit, in the order of their first wire. A tail decides nothing (rule 7); a head on a step decides (rule 9). */
export function netsOf(circuit: Readonly<Circuit>, conditionOf: (step: Id) => number | undefined): Net[] {
  const parent = new Map<string, string>(Object.keys(circuit).map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let y = x; parent.get(y) !== r; ) { const n = parent.get(y)!; parent.set(y, r); y = n; }
    return r;
  };
  const join = (a: string, b: string) => { if (parent.has(b)) parent.set(find(a), find(b)); };
  for (const [id, w] of Object.entries(circuit)) {
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

/** The wires of nets whose families disagree: their links are never written (plan 9 §7). */
export const shortedWires = (nets: readonly Net[]): Set<string> => new Set(nets.filter((n) => n.families.length > 1).flatMap((n) => n.wires));

/**
 * The current as Save writes it (plan 9 §7): short-circuited nets left out, and a step's current reaching its own
 * input (a hidden self-loop, or one wire on both its sides) is never a link (§2.2-4): those steps are in `selfFed`.
 */
export function circuitTrace(
  circuit: Readonly<Circuit>,
  conditionOf: (step: Id) => number | undefined,
): Trace & { nets: Net[]; selfFed: Id[] } {
  const nets = netsOf(circuit, conditionOf);
  const t = trace(circuit, shortedWires(nets));
  const links = new Map<SourceId, Id[]>();
  const selfFed: Id[] = [];
  for (const [s, ts] of t.links) {
    const kept = ts.filter((x) => x !== s);
    if (kept.length < ts.length) selfFed.push(s);
    if (kept.length > 0) links.set(s, kept);
  }
  return { links, loop: t.loop, nets, selfFed };
}

/**
 * The sources held back by short circuits (plan 9 §7, controller ruling): the step of every tail on a step, and the hub
 * (`wf`) for a tail on it, among the wires of nets whose families disagree. Every wire joined into a net is in it, so
 * these tails are all the current that can enter it. Save sends these sources' lists as the workflow has them, and
 * settling neither expects nor removes their links, so the drawing waits until the short circuit is fixed.
 */
export function heldSources(circuit: Readonly<Circuit>, nets: readonly Net[]): Set<SourceId> {
  const out = new Set<SourceId>();
  for (const id of shortedWires(nets)) {
    const t = circuit[id]!.tail;
    if (t.on === 'step') out.add(t.step);
    else if (t.on === 'hub') out.add(WORKFLOW_SOURCE);
  }
  return out;
}

import type { StudioDocument } from '../app/document';
import { netsOf, shortedWires } from '../circuit/families';
import { conditionInfo } from '../model/entryConditions';
import type { DesignError, Id } from '../model/graph';
import { circuitOf, type Draft } from './draft';

/** How a short circuit's message starts (plan 9 §7). */
export const SHORT_CIRCUIT = 'short circuit:';

/**
 * One error per net whose families disagree (plan 9 §2.2-7, §7; decision 10): kind `step`, stage `wires`, on the
 * first step (by id) of the net's last family that a head of the net lands on; "short circuit: <first> meets <last>".
 * `shown` is what the canvas shows (the design's entity edits included), so an entry condition edited in the
 * Inspector counts.
 */
export function shortCircuitErrors(shown: StudioDocument, draft: Draft): DesignError[] {
  const circuit = circuitOf(shown, draft);
  const conditionOf = (id: Id) => shown.graph.steps.get(id)?.entryCondition;
  return netsOf(circuit, conditionOf).filter((n) => n.families.length > 1).map((n) => {
    const first = n.families[0]!, last = n.families[n.families.length - 1]!;
    const steps = n.wires.flatMap((w) => { const h = circuit[w]!.head; return h.on === 'step' && conditionOf(h.step) === last ? [h.step] : []; }).sort();
    return { kind: 'step', id: steps[0]!, stage: 'wires', field: null, message: `${SHORT_CIRCUIT} ${conditionInfo(first).name} meets ${conditionInfo(last).name}` };
  });
}

/** A short circuit's error (the live list in Problems supersedes any copy a document carries). */
export const isShortCircuitError = (e: DesignError): boolean => e.stage === 'wires' && e.message.startsWith(SHORT_CIRCUIT);

/**
 * The sources whose wires run into a short-circuited net (plan 9 §7, controller ruling): the step of every tail on a
 * step, and the hub when a tail is on it. Save sends these sources' lists as the loaded workflow has them, so no
 * link is dropped or added through the net; every wire joined into a net is in it, so its tails on terminals are
 * all the current that can enter it.
 */
export function shortedSources(shown: StudioDocument, draft: Draft): { steps: Set<Id>; hub: boolean } {
  const circuit = circuitOf(shown, draft);
  const shorted = shortedWires(netsOf(circuit, (id) => shown.graph.steps.get(id)?.entryCondition));
  const steps = new Set<Id>();
  let hub = false;
  for (const id of shorted) {
    const t = circuit[id]!.tail;
    if (t.on === 'step') steps.add(t.step);
    else if (t.on === 'hub') hub = true;
  }
  return { steps, hub };
}

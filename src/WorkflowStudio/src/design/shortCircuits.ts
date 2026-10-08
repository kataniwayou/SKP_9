import type { StudioDocument } from '../app/document';
import { heldSources, netsOf } from '../circuit/families';
import { trace } from '../circuit/trace';
import { WORKFLOW_SOURCE } from '../layout/ports';
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

/** The sources held back by short circuits (`heldSources`): their steps, and whether the hub (the entry list) is one. */
export function heldSourcesOf(shown: StudioDocument, draft: Draft): { steps: Set<Id>; hub: boolean } {
  const circuit = circuitOf(shown, draft);
  const held = heldSources(circuit, netsOf(circuit, (id) => shown.graph.steps.get(id)?.entryCondition));
  const hub = held.delete(WORKFLOW_SOURCE);
  return { steps: held, hub };
}

/**
 * How many links of the held-back sources wait for the short circuit to be fixed (plan 9 §7): the clean links the
 * design adds or removes on those sources, which Save does not write. A link the loaded workflow has only through the
 * shorted net is not counted: it is the short circuit's own.
 */
export function heldLinkCount(base: StudioDocument, shown: StudioDocument, draft: Draft): number {
  const { steps, hub } = heldSourcesOf(shown, draft);
  const all = trace(circuitOf(shown, draft)).links;
  const listOf = (doc: StudioDocument, s: Id) => (s === WORKFLOW_SOURCE ? doc.graph.workflow.entryStepIds : doc.graph.steps.get(s)?.nextStepIds ?? []);
  let n = 0;
  for (const s of [...steps, ...(hub ? [WORKFLOW_SOURCE] : [])]) {
    const saved = listOf(base, s), now = listOf(shown, s), drawn = all.get(s) ?? [];
    n += now.filter((t) => !saved.includes(t)).length + saved.filter((t) => !now.includes(t) && !drawn.includes(t)).length;
  }
  return n;
}

import type { StudioDocument } from '../app/document';
import { netsOf } from '../circuit/families';
import { trace } from '../circuit/trace';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { conditionInfo } from '../model/entryConditions';
import type { DesignError, Id } from '../model/graph';
import { circuitOf, type Draft } from './draft';
import { wireName } from './wireName';

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
  const families: DesignError[] = netsOf(circuit, conditionOf).filter((n) => n.families.length > 1).map((n) => {
    const first = n.families[0]!, last = n.families[n.families.length - 1]!;
    const steps = n.wires.flatMap((w) => { const h = circuit[w]!.head; return h.on === 'step' && conditionOf(h.step) === last ? [h.step] : []; }).sort();
    return { kind: 'step', id: steps[0]!, stage: 'wires', field: null, message: `${SHORT_CIRCUIT} ${conditionInfo(first).name} meets ${conditionInfo(last).name}` };
  });
  return [...families, ...overlapErrors(shown)];
}

/**
 * One error per pair of wires sharing a stretch of line across nets (the user's rule 2, 2026-10-09), in the order they
 * are drawn: kind `wire` on the first, "short circuit: <wire> overlaps <wire>", each wire named as the Inspector names it.
 */
function overlapErrors(shown: StudioDocument): DesignError[] {
  const order = new Map(shown.wires.map((w, i) => [w.id, i]));
  const out: DesignError[] = [];
  for (const w of shown.wires) {
    for (const other of w.shortWith ?? []) {
      if ((order.get(other) ?? -1) <= order.get(w.id)!) continue;
      out.push({ kind: 'wire', id: w.id, other, stage: 'wires', field: null, message: `${SHORT_CIRCUIT} ${wireName(shown, w.id)} overlaps ${wireName(shown, other)}` });
    }
  }
  return out;
}

/** A short circuit's error (the live list in Problems supersedes any copy a document carries). */
export const isShortCircuitError = (e: DesignError): boolean => e.stage === 'wires' && e.message.startsWith(SHORT_CIRCUIT);

/**
 * The sources held back by short circuits: the tail terminal (a step, or the hub for the entry list) of every wire drawn
 * short (a net whose families disagree, or one lying on another net's wire). Read from the drawn wires themselves, never
 * from the shown lists: those already leave a shorted net's links out (review 2026-10-09), so a circuit rebuilt from them
 * would hold nothing back and Save would drop the links.
 */
export function heldSourcesOf(shown: StudioDocument, _draft: Draft): { steps: Set<Id>; hub: boolean } {
  const steps = new Set<Id>();
  let hub = false;
  for (const w of shown.wires) {
    if (!w.short || w.source === null) continue;
    if (w.source === WORKFLOW_SOURCE) hub = true;
    else steps.add(w.source);
  }
  return { steps, hub };
}

/**
 * The lists Save writes (plan 9 §7): a step's next steps and the entry steps as the drawing gives them (`shown`), except
 * that a source held back by a short circuit keeps its list as the base (BaseApi) has it. `buildDesignRequest` sends
 * these, and the Inspector's read-outs show them, so the two never disagree.
 */
export function writtenLists(base: StudioDocument, shown: StudioDocument, draft: Draft): {
  held: { steps: Set<Id>; hub: boolean }; nextOf: (id: Id) => Id[]; entries: Id[];
} {
  const g = base.graph;
  const held = heldSourcesOf(shown, draft);
  const nextOf = (id: Id): Id[] => (held.steps.has(id) ? g.steps.get(id)?.nextStepIds ?? [] : shown.graph.steps.get(id)?.nextStepIds ?? g.steps.get(id)?.nextStepIds ?? []);
  return { held, nextOf, entries: held.hub ? g.workflow.entryStepIds : shown.graph.workflow.entryStepIds };
}

/**
 * How many links of the held-back sources wait for the short circuit to be fixed (plan 9 §7): the clean links the
 * design adds or removes on those sources, which Save does not write. A link the loaded workflow has only through the
 * shorted net is not counted: it is the short circuit's own.
 */
export function heldLinkCount(base: StudioDocument, shown: StudioDocument, draft: Draft): number {
  const { steps, hub } = heldSourcesOf(shown, draft);
  // the circuit from the base (with the draft's own over it): the shown lists leave a shorted net's links out
  const all = trace(circuitOf(base, draft)).links;
  const listOf = (doc: StudioDocument, s: Id) => (s === WORKFLOW_SOURCE ? doc.graph.workflow.entryStepIds : doc.graph.steps.get(s)?.nextStepIds ?? []);
  let n = 0;
  for (const s of [...steps, ...(hub ? [WORKFLOW_SOURCE] : [])]) {
    const saved = listOf(base, s), now = listOf(shown, s), drawn = all.get(s) ?? [];
    n += now.filter((t) => !saved.includes(t)).length + saved.filter((t) => !now.includes(t) && !drawn.includes(t)).length;
  }
  return n;
}

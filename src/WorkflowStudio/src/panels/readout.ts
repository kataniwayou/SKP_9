import type { StudioDocument } from '../app/document';
import { isFree, type Circuit, type End } from '../circuit/circuit';
import { netsOf } from '../circuit/families';
import { trace, wiresBetween } from '../circuit/trace';
import { applyDesign, applyEdits } from '../design/apply';
import type { EntityEdits } from '../design/design';
import { circuitOf, type Draft } from '../design/draft';
import { shortCircuitErrors, writtenLists } from '../design/shortCircuits';
import { wireName } from '../design/wireName';
import { contactDistance, type WireRoute } from '../layout/circuitRoute';
import { clampLanding } from '../layout/geometry';
import { WORKFLOW_SOURCE, type SourceId } from '../layout/ports';
import type { Pt } from '../layout/router';
import { conditionInfo } from '../model/entryConditions';
import { entityName } from '../model/entityNames';
import type { DesignError, Id } from '../model/graph';

/**
 * Everything the Inspector's read-outs read (the user's request, 2026-10-09): the drawing exactly as the canvas draws
 * it (the design over the base) and what Save would write from it. Built from the same functions the canvas, Output's pinned problems
 * and Save use (`applyDesign`, `circuitOf`, `trace`, `writtenLists`, `shortCircuitErrors`), so the text cannot disagree
 * with what is drawn or saved. Pure.
 */
export interface ReadoutModel {
  /** The workflow as loaded from BaseApi: what Save compares with. */
  base: StudioDocument;
  /** What the canvas shows. */
  shown: StudioDocument;
  /** The circuit drawn. */
  circuit: Circuit;
  draft: Draft;
  /** Save's lists: a source held back by a short circuit keeps the base's list. */
  written: ReturnType<typeof writtenLists>;
  /** Every link the drawn current makes, short-circuited nets included (by source, in the order first reached). */
  drawn: Map<SourceId, Id[]>;
  /** The live short circuits, as Output pins them. */
  shorts: DesignError[];
}

export function readoutModel(base: StudioDocument, draft: Draft, edits: EntityEdits): ReadoutModel {
  const shown = applyDesign(base, draft, edits);
  // the circuit `applyDraft` draws: the draft's own, else the (edited) workflow's wires
  const circuit = circuitOf(applyEdits(base, edits, draft.blocks), draft);
  return {
    base, shown, circuit, draft, written: writtenLists(base, shown, draft), drawn: trace(circuit).links, shorts: shortCircuitErrors(shown, draft),
  };
}

/** A step or the hub (`wf`) by its unique name; an id the canvas does not hold, as it is. */
export function sourceName(shown: StudioDocument, id: SourceId): string {
  if (id === WORKFLOW_SOURCE) return 'workflow';
  const s = shown.graph.steps.get(id);
  return s ? entityName(s.name, s.version, s.id) : id;
}

/** What Save does with one link the drawing makes. */
export type LinkStatus = 'written' | 'kept' | 'held' | 'self';

/** A link `from → to`: written; kept (its source is held back and BaseApi already has it); held back; or a step's own input. */
export function linkStatus(m: ReadoutModel, from: SourceId, to: Id): LinkStatus {
  if (from === to) return 'self';
  const list = from === WORKFLOW_SOURCE ? m.written.entries : m.written.nextOf(from);
  if (!list.includes(to)) return 'held';
  const held = from === WORKFLOW_SOURCE ? m.written.held.hub : m.written.held.steps.has(from);
  return held ? 'kept' : 'written';
}

const STATUS_NOTE: Readonly<Record<LinkStatus, string>> = {
  written: '',
  kept: ' (kept as BaseApi has it: short circuit)',
  held: ' (held back: short circuit)',
  self: ' (not written: a step never feeds itself)',
};

/** One row of the wire read-out: a label and one value, or several (one per line). */
export interface ReadoutRow {
  label: string;
  value: string | string[];
}

export interface WireReadout {
  /** As the Inspector and Output's pinned problems name it: "{from} → {to}". */
  name: string;
  rows: ReadoutRow[];
}

const px = (v: number) => `${Math.round(v)} px`;
const at = (p: Pt | undefined) => (p ? `${Math.round(p[0])}, ${Math.round(p[1])}` : '?');

/** Interior points of a drawn path where it turns. */
export function cornersOf(points: readonly Pt[]): number {
  let n = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, p = points[i]!, b = points[i + 1]!;
    if ((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0) n++;
  }
  return n;
}

/** One end as drawn: what it is on and where. */
function endText(m: ReadoutModel, r: WireRoute, e: End, side: 'tail' | 'head', held: boolean): string {
  const kind = side === 'tail' ? r.tailOn : r.headOn;
  const point = side === 'tail' ? r.points[0] : r.points[r.points.length - 1];
  if (kind === 'open') {
    // an end on a step off the canvas, or on a wire that is gone, is drawn open too
    return `open (at ${at(point)})`;
  }
  if (e.on === 'step') {
    const height = e.y === null ? 'automatic' : `${px(clampLanding(e.y))} down${held ? ', held while the other end is open' : ''}`;
    return `step ${sourceName(m.shown, e.step)}, ${side === 'tail' ? 'output' : 'input'} side (${height})`;
  }
  if (e.on === 'hub') {
    const where = e.angle !== null ? `at ${e.angle}°` : e.dy !== undefined ? `held ${px(e.dy)} from its centre` : 'automatic';
    return `the workflow hub (${where})`;
  }
  if (e.on === 'wire') {
    const host = m.shown.wires.find((w) => w.id === e.host);
    const along = host ? `, ${px(contactDistance(host.points, e.at))} along it` : '';
    return `a junction on wire ${wireName(m.shown, e.host) ?? e.host}${along}`;
  }
  return `open (at ${at(point)})`;
}

/** Why a wire is drawn short: its net's families meeting, and every stretch its net lies on another wire. */
function shortReasons(m: ReadoutModel, id: string): string[] {
  const conditionOf = (s: Id) => m.shown.graph.steps.get(s)?.entryCondition;
  const net = netsOf(m.circuit, conditionOf).find((n) => n.wires.includes(id));
  const out: string[] = [];
  if (net && net.families.length > 1) {
    out.push(`${conditionInfo(net.families[0]!).name} meets ${conditionInfo(net.families[net.families.length - 1]!).name}`);
  }
  const name = (w: string) => wireName(m.shown, w) ?? w;
  const seen = new Set<string>();
  for (const w of [id, ...(net?.wires ?? []).filter((x) => x !== id)]) {
    for (const other of m.shown.wires.find((x) => x.id === w)?.shortWith ?? []) {
      const pair = [w, other].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      out.push(w === id ? `overlaps ${name(other)}` : `${name(w)} overlaps ${name(other)}`);
    }
  }
  return out;
}

/**
 * The picked wire read as text (the user's request, 2026-10-09): what each end is on, its direction, its condition,
 * the links Save would write through it, its shape and the wires joined on it. Null when the drawing has no such wire.
 */
export function wireReadout(m: ReadoutModel, id: string): WireReadout | null {
  const r = m.shown.wires.find((w) => w.id === id);
  const w = Object.hasOwn(m.circuit, id) ? m.circuit[id] : undefined;
  if (!r || !w) return null;
  const free = isFree(w);
  const reasons = r.short ? shortReasons(m, id) : [];
  const condition = r.short
    ? (reasons.length > 0 ? reasons.map((x) => `short circuit: ${x}`) : 'short circuit')
    : r.condition === null ? 'undecided' : conditionInfo(r.condition).name;
  // the links whose current passes through this wire (direction-less wires carry none)
  const carries: string[] = [];
  for (const [from, tos] of m.drawn) {
    for (const to of tos) {
      if (!wiresBetween(m.circuit, from, to).has(id)) continue;
      carries.push(`${sourceName(m.shown, from)} → ${sourceName(m.shown, to)}${STATUS_NOTE[linkStatus(m, from, to)]}`);
    }
  }
  const corners = cornersOf(r.points);
  const shape = (w.bends?.xs.length ?? 0) > 0 ? `by hand, ${corners} corner${corners === 1 ? '' : 's'}` : 'automatic';
  const joined = Object.entries(m.circuit)
    .filter(([k, x]) => k !== id && ((x.tail.on === 'wire' && x.tail.host === id) || (x.head.on === 'wire' && x.head.host === id)))
    .map(([k]) => k).sort().map((k) => wireName(m.shown, k) ?? k);
  return {
    name: wireName(m.shown, id) ?? id,
    rows: [
      { label: free ? 'One end' : 'From (tail)', value: endText(m, r, w.tail, 'tail', w.held === 'tail') },
      { label: free ? 'Other end' : 'To (head)', value: endText(m, r, w.head, 'head', w.held === 'head') },
      { label: 'Direction', value: free ? 'no direction (touches no step or hub)' : 'directed' },
      { label: 'Condition', value: condition },
      { label: 'Carries', value: carries.length > 0 ? carries : 'nothing' },
      { label: 'Shape', value: shape },
      { label: 'Joined on it', value: joined.length > 0 ? joined : 'none' },
    ],
  };
}

/** One next step (or entry step) as Save would write it, or held back. */
export interface GraphLink {
  id: Id;
  name: string;
  /** Drawn, but Save does not write it (its source is held back by a short circuit). */
  held: boolean;
}

export interface GraphStepRow {
  id: Id;
  name: string;
  condition: string;
  /** What Save writes as its nextStepIds, in that order, then the drawn links held back. */
  next: GraphLink[];
  /** Its source is held back by a short circuit: Save keeps BaseApi's list. */
  heldBack: boolean;
}

export interface GraphProblem {
  label: string;
  names: string[];
}

export interface GraphReadout {
  /** What Save writes as the entry steps, then the drawn entries held back. */
  entries: (GraphLink & { condition: string })[];
  entriesHeldBack: boolean;
  steps: GraphStepRow[];
  /** Only the kinds there are; empty: none. */
  problems: GraphProblem[];
}

/** A source's links as Save writes them, then those drawn but held back. */
function linksOf(m: ReadoutModel, from: SourceId): GraphLink[] {
  const written = from === WORKFLOW_SOURCE ? m.written.entries : m.written.nextOf(from);
  const held = (m.drawn.get(from) ?? []).filter((t) => t !== from && !written.includes(t));
  return [
    ...written.map((id) => ({ id, name: sourceName(m.shown, id), held: false })),
    ...held.map((id) => ({ id, name: sourceName(m.shown, id), held: true })),
  ];
}

const conditionName = (m: ReadoutModel, id: Id): string => {
  const c = m.shown.graph.steps.get(id)?.entryCondition;
  return c === undefined ? '—' : conditionInfo(c).name;
};

/** Every step of the drawing by unique name: the order both read-outs list steps in. */
const stepsByName = (m: ReadoutModel): { id: Id; name: string }[] => [...m.shown.graph.steps.values()]
  .map((s) => ({ id: s.id, name: entityName(s.name, s.version, s.id) }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * The workflow's graph read as text (the user's request, 2026-10-09): its entry steps, one row per step (by unique name)
 * with its entry condition and the next steps Save would write, and the drawing's problems.
 */
export function graphReadout(m: ReadoutModel): GraphReadout {
  const { shown, circuit } = m;
  const steps = stepsByName(m)
    .map(({ id, name }) => ({ id, name, condition: conditionName(m, id), next: linksOf(m, id), heldBack: m.written.held.steps.has(id) }));

  const wired = new Set<Id>();
  for (const w of Object.values(circuit)) for (const e of [w.tail, w.head]) if (e.on === 'step') wired.add(e.step);
  const named = (rs: readonly WireRoute[]) => rs.map((r) => wireName(shown, r.id) ?? r.id);
  const problems: GraphProblem[] = [
    { label: 'Steps with no wires', names: steps.filter((s) => !wired.has(s.id)).map((s) => s.name) },
    { label: 'Open wires', names: named(shown.wires.filter((r) => r.tailOn === 'open' || r.headOn === 'open')) },
    { label: 'Direction-less wires', names: named(shown.wires.filter((r) => r.free)) },
    { label: 'Short circuits', names: m.shorts.map((e) => e.message) },
  ].filter((p) => p.names.length > 0);

  return {
    entries: linksOf(m, WORKFLOW_SOURCE).map((l) => ({ ...l, condition: conditionName(m, l.id) })),
    entriesHeldBack: m.written.held.hub,
    steps,
    problems,
  };
}

/** A source feeding a step (the workflow hub, or a step whose next steps hold it): written by Save, or held back. */
export interface StepSource {
  /** A step id, or `wf` for the hub (the step is an entry step). */
  id: SourceId;
  name: string;
  held: boolean;
}

/** A wire touching a step's side, named as Output's pinned problems name it, with what is wrong with it (open, no direction, short circuit). */
export interface StepWire {
  id: string;
  name: string;
  notes: string[];
}

export interface StepReadout {
  condition: string;
  /** Its processor's unique name, or null when the design removed it (2026-10-10: "none"). */
  processor: string | null;
  /** What feeds it, the hub first, then steps by unique name: exactly the workflow Graph's links into it. */
  in: StepSource[];
  /** Its next steps as Save writes them, then those drawn but held back: its workflow Graph row. */
  out: GraphLink[];
  /** Its own source is held back by a short circuit: Save keeps BaseApi's list. */
  heldBack: boolean;
  /** How many wires have an end on its sides. */
  wireCount: number;
  /** Those of them that are open, direction-less or in a short circuit. */
  flagged: StepWire[];
}

/**
 * A picked step's place in the graph read as text (the user's request, 2026-10-09): its entry condition, what feeds it
 * and what it feeds, built from the same links as the workflow's Graph (`linksOf`), so the two never disagree; and the
 * wires on its sides. Null when the drawing has no such step.
 */
export function stepReadout(m: ReadoutModel, id: Id): StepReadout | null {
  const { shown, circuit } = m;
  if (!shown.graph.steps.has(id)) return null;
  const steps = stepsByName(m);
  const into: StepSource[] = [];
  for (const src of [WORKFLOW_SOURCE, ...steps.map((s) => s.id)]) {
    for (const l of linksOf(m, src)) if (l.id === id) into.push({ id: src, name: sourceName(shown, src), held: l.held });
  }
  const touching = Object.keys(circuit).filter((k) => {
    const w = circuit[k]!;
    return (w.tail.on === 'step' && w.tail.step === id) || (w.head.on === 'step' && w.head.step === id);
  }).sort();
  const flagged: StepWire[] = [];
  for (const k of touching) {
    const r = shown.wires.find((x) => x.id === k);
    if (!r) continue;
    const notes = [
      ...(r.tailOn === 'open' || r.headOn === 'open' ? ['open'] : []),
      ...(r.free ? ['no direction'] : []),
      ...(r.short ? ['short circuit'] : []),
    ];
    if (notes.length > 0) flagged.push({ id: k, name: wireName(shown, k) ?? k, notes });
  }
  const pid = shown.graph.steps.get(id)!.processorId;
  const p = pid === null ? undefined : shown.graph.processors.get(pid);
  const processor = pid === null ? null : p ? entityName(p.name, p.version, p.id) : pid;
  return { condition: conditionName(m, id), processor, in: into, out: linksOf(m, id), heldBack: m.written.held.steps.has(id), wireCount: touching.length, flagged };
}

import type { StudioDocument } from '../app/document';
import { NEW_WIRE_PREFIX, type Circuit, type CircuitWire, type End, type Side } from '../circuit/circuit';
import { contactOn, hubLead, routeCircuit } from '../layout/circuitRoute';
import type { Pt } from '../layout/router';
import { CACHE_H, CACHE_W, snap, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Cache, Id, Processor, Schema } from '../model/graph';
import type { Pick } from '../store/picks';
import { applyDraft, applyEdits } from './apply';
import type { Blocks } from './blocks';
import type { EntityEdits } from './design';
import { circuitOf, withCircuit, type Draft } from './draft';
import { endOf, judgeDrop, lineReachOf, pointOfTarget, targetOf, toneOf, dropLabel, type DropTarget as WireTarget, type Verdict } from './drop';
import { blockAt, wireAt } from './hit';
import { overlapJudge } from './overlapJudge';
import { commitSplit, splitAt, splitLabel, splitTone, type Split } from './split';

/**
 * What a Toolbox tile drags (2026-10-11): a new, empty step or cache, a new undecided wire (each a new virtual entity, as a
 * paste makes), an existing processor (dropped only on a step: the step points at it, the same entity) or an existing
 * cache (linked to the workflow: the same entity, never a copy).
 */
export type ToolItem =
  | { kind: 'step' }
  | { kind: 'wire' }
  | { kind: 'newCache' }
  | { kind: 'processor'; processor: Processor; schemas: Schema[] }
  | { kind: 'cache'; cache: Cache };

/** How long the dropped wire is (flow px): a short horizontal run, ready to be dragged onto contacts. */
export const DROPPED_WIRE = 96;

/**
 * What a drop of `item` at `p` (flow coordinates) on a canvas showing `shown` does: `place` puts a new block or wire there;
 * `assign` / `replace` give the step under the pointer the processor; `noStep` (a processor anywhere but on a step) and
 * `linked` (a cache this workflow already has) are refused.
 */
export type ToolVerdict =
  | { kind: 'place' }
  /** A Wire tile over a contact (2026-10-20): judged as a dragged wire end there; `points`: the wire as it would be drawn. */
  | { kind: 'wire'; target: Exclude<WireTarget, { on: 'open' }>; why: Verdict; points: Pt[] | null }
  /** An empty step over a wire's run (Visio, plan 10 §4.6): released, the wire splits through it, or the refusal. */
  | ({ kind: 'split' } & Split)
  | { kind: 'assign' | 'replace'; stepId: Id }
  | { kind: 'noStep' }
  | { kind: 'linked'; cacheId: Id };

/** Default entry condition of a new step: PreviousCompleted (BaseApi's default). */
const NEW_STEP_CONDITION = 1;
/** The id an empty step is judged under while it is dragged (it gets its own when dropped). */
const NEW_STEP = 'step:tool';

export function judgeTool(shown: StudioDocument, item: ToolItem, p: Point, wiring?: { circuit: Readonly<Circuit>; reach: number }): ToolVerdict {
  if (item.kind === 'wire' && wiring) return judgeWireTool(shown, wiring.circuit, p, wiring.reach);
  if (item.kind === 'step' && wiring) {
    const split = splitAt(shown, wiring.circuit, landingBox(item, p)!, NEW_STEP, NEW_STEP_CONDITION);
    if (split) return { kind: 'split', ...split };
  }
  if (item.kind === 'processor') {
    const over = blockAt(shown, p);
    if (over === null || over === SPHERE_NODE_ID || over.startsWith(CACHE_NODE_PREFIX) || !shown.graph.steps.has(over)) return { kind: 'noStep' };
    return { kind: shown.graph.steps.get(over)!.processorId === null ? 'assign' : 'replace', stepId: over };
  }
  if (item.kind === 'cache' && shown.graph.caches.has(item.cache.id)) return { kind: 'linked', cacheId: item.cache.id };
  return { kind: 'place' };
}

/** The label a verdict shows by the pointer, and its tone (green: the drop does it; red: refused). */
export function toolLabel(v: ToolVerdict, saving = false): { text: string; tone: 'ok' | 'no' } | null {
  if (saving) return { text: 'locked: a Save or the AI drawing is under way', tone: 'no' };
  switch (v.kind) {
    case 'place': return null;
    case 'assign': return { text: 'assign processor', tone: 'ok' };
    case 'replace': return { text: 'replace processor', tone: 'ok' };
    case 'noStep': return { text: 'drop on a step', tone: 'no' };
    case 'linked': return { text: 'already in this workflow', tone: 'no' };
    case 'wire': return { text: dropLabel(v.why), tone: toneOf(v.why) === 'no' ? 'no' : 'ok' };
    case 'split': return { text: splitLabel(v.why), tone: splitTone(v.why) };
  }
}

/** The id a Wire tile's wire is judged under while it is dragged (it gets its own when dropped). */
const TOOL_WIRE = `${NEW_WIRE_PREFIX}tool`;

/** The end of a Wire tile's wire that lands on contact `t`: a step's input takes its head, an output or the hub its tail. */
const contactSide = (t: WireTarget): Side => (t.on === 'step' && t.side === 'out') || t.on === 'hub' ? 'tail' : 'head';

/**
 * A Wire tile dropped on contact `t` (the user's request, 2026-10-20): that end on the contact, the other open
 * `DROPPED_WIRE` away from it — left of a step's input, right of an output, along the run a hub wire starts, square off a
 * line it joins — so it is drawn as a short straight stub, automatic, ready to be dragged on.
 */
export function toolWire(shown: StudioDocument, t: Exclude<WireTarget, { on: 'open' }>): CircuitWire {
  const p = pointOfTarget(shown, t);
  const away = (dx: number, dy: number): End => ({ on: 'open', x: snap(p.x + dx), y: snap(p.y + dy) });
  const end = endOf(t);
  switch (t.on) {
    case 'step': return t.side === 'in' ? { tail: away(-DROPPED_WIRE, 0), head: end } : { tail: end, head: away(DROPPED_WIRE, 0) };
    case 'hub': {
      // a hub tail's run starts right of the ring (above or below it from the left half, hubLead): the open head lies
      // `DROPPED_WIRE` along that run, so the stub is drawn out of the ring and straight on — never back round the hub
      // (the user's report, 2026-10-21); at the run's own height, off the grid as a ring point may be, so it stays straight
      const start = hubLead(shown.placement.sphere.cx, shown.placement.sphere.cy, t.angle).start;
      return { tail: end, head: { on: 'open', x: snap(start.x + DROPPED_WIRE), y: start.y } };
    }
    case 'wire': {
      const host = shown.wires.find((w) => w.id === t.host);
      const upright = host ? contactOn(host.points, t.at).vertical : false;
      return { tail: upright ? away(DROPPED_WIRE, 0) : away(0, DROPPED_WIRE), head: end };
    }
  }
}

/**
 * A Wire tile held at `p` (flow) over `shown`, whose circuit is `circuit`: over a step side or the hub within `reach`
 * (flow px, a block's drop reach), or a line within a line's (`lineReachOf`), the same verdict a dragged wire end gets there — "connect here", "join here", or its refusal — and a
 * short circuit when the wire as it would be drawn lies on another net's wire (rule 2); elsewhere a free wire is placed.
 */
export function judgeWireTool(shown: StudioDocument, circuit: Readonly<Circuit>, p: Point, reach: number): ToolVerdict {
  const over = blockAt(shown, p, reach);
  const line = over === null ? wireAt(shown, p, lineReachOf(reach)) : null;
  const t = targetOf(shown, circuit, p, over, line);
  if (t.on === 'open') return { kind: 'place' };
  const side = contactSide(t);
  const laid = toolWire(shown, t);
  // judged as its contact end dragged onto `t`, the other end already where it will lie
  const held: Circuit = { ...circuit, [TOOL_WIRE]: side === 'head' ? { tail: laid.tail, head: { on: 'open', x: p.x, y: p.y } } : { tail: { on: 'open', x: p.x, y: p.y }, head: laid.head } };
  let why = judgeDrop(shown, held, TOOL_WIRE, side, t);
  if (toneOf(why) === 'no') return { kind: 'wire', target: t, why, points: null };
  const after: Circuit = { ...circuit, [TOOL_WIRE]: laid };
  const drawn = routeCircuit(after, { placement: shown.placement, steps: shown.graph.steps }).find((w) => w.id === TOOL_WIRE);
  const points = drawn ? [...drawn.points] : null;
  if (points && overlapJudge(shown, TOOL_WIRE, circuit, 'strict')(points, () => after)) why = 'short';
  return { kind: 'wire', target: t, why, points };
}

/** The box a dropped block takes, centred on the pointer and on the 8 px grid (flow coordinates). */
export function landingBox(item: ToolItem, p: Point): { x: number; y: number; w: number; h: number } | null {
  const size = item.kind === 'step' ? { w: STEP_W, h: STEP_H } : item.kind === 'newCache' || item.kind === 'cache' ? { w: CACHE_W, h: CACHE_H } : null;
  return size && { x: snap(p.x - size.w / 2), y: snap(p.y - size.h / 2), ...size };
}

/** A dropped wire's two ends: its head at `p` (the ghost's arrow tip), on the grid, its tail `DROPPED_WIRE` to the left. */
export const wireLanding = (p: Point): [Point, Point] => {
  const z = { x: snap(p.x), y: snap(p.y) };
  return [{ x: z.x - DROPPED_WIRE, y: z.y }, z];
};

/** `base`, then `base-2`, `base-3`, … : the first not in `taken`. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const copy = <T>(r: Readonly<Record<string, T>> = {}): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, r);

/**
 * A Toolbox drop on a workflow's canvas (2026-10-11), as a paste is: one history step, the new item picked. `base` is the
 * workflow as loaded, `edits` and `draft` the design over it; a new cache has no root yet (set in the Inspector). Null
 * when the drop is refused
 * (`judgeTool`): a processor not on a step, or a cache already in this workflow.
 */
export function dropTool(
  base: StudioDocument, edits: EntityEdits, draft: Draft, item: ToolItem, p: Point, newId: () => string, reach = 0,
): { draft: Draft; picks: Pick[] } | null {
  const saved = applyEdits(base, edits, draft.blocks);
  const shown = applyDraft(saved, draft);
  const verdict = judgeTool(shown, item, p, { circuit: circuitOf(saved, draft), reach });
  if (verdict.kind === 'noStep' || verdict.kind === 'linked' || (verdict.kind === 'wire' && toneOf(verdict.why) === 'no')
    || (verdict.kind === 'split' && splitTone(verdict.why) === 'no')) return null;
  const b = draft.blocks;
  const withBlocks = (blocks: Blocks): Draft => ({ ...draft, blocks });

  switch (item.kind) {
    case 'step': {
      const id = newId();
      const box = landingBox(item, p)!;
      const name = uniqueName('step', new Set([...shown.graph.steps.values()].map((s) => s.name)));
      const steps = copy(b.steps);
      steps[id] = { copyOf: null, name, version: '1.0.0', description: null, processorId: null, entryCondition: NEW_STEP_CONDITION, at: { x: box.x, y: box.y }, assignment: null };
      const placed = withBlocks({ ...b, steps });
      if (verdict.kind !== 'split') return { draft: placed, picks: [{ kind: 'node', id }] };
      // over a wire's run: the wire splits through the new step (plan 10 §4.6), in the same history step
      const withStep = applyEdits(base, edits, placed.blocks);
      return { draft: commitSplit(withStep, shown, placed, verdict, id, `${NEW_WIRE_PREFIX}${newId()}`), picks: [{ kind: 'node', id }] };
    }
    case 'newCache': {
      const id = newId();
      const box = landingBox(item, p)!;
      const name = uniqueName('cache', new Set([...shown.graph.caches.values()].map((c) => c.name)));
      // no root yet (the user's rule, 2026-10-11): drawn dashed with a ⚠ until the Inspector sets one; Save fails until then
      const caches = copy(b.caches);
      caches[id] = { copyOf: null, name, version: '1.0.0', description: null, root: '', items: '{}', at: { x: box.x, y: box.y } };
      return { draft: withBlocks({ ...b, caches }), picks: [{ kind: 'node', id: cacheNodeId(id) }] };
    }
    case 'cache': {
      const c = item.cache;
      const box = landingBox(item, p)!;
      const linked = copy(b.linked);
      linked[c.id] = { name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, at: { x: box.x, y: box.y } };
      // a cache this design deleted and now links again is simply kept
      const removed = { ...b.removed, caches: b.removed.caches.filter((x) => x !== c.id) };
      return { draft: withBlocks({ ...b, linked, removed }), picks: [{ kind: 'node', id: cacheNodeId(c.id) }] };
    }
    case 'processor': {
      const stepId = (verdict as { stepId: Id }).stepId;
      const pr = item.processor;
      const processors = copy(b.refs.processors), schemas = copy(b.refs.schemas);
      if (!saved.graph.processors.has(pr.id)) processors[pr.id] = pr;
      for (const s of item.schemas) if (!saved.graph.schemas.has(s.id)) schemas[s.id] = s;
      const refs = { processors, schemas };
      if (Object.hasOwn(b.steps, stepId)) {
        // a step the design created: its own processor
        const steps = copy(b.steps);
        steps[stepId] = { ...steps[stepId]!, processorId: pr.id };
        return { draft: withBlocks({ ...b, steps, refs }), picks: [{ kind: 'node', id: stepId }] };
      }
      // a step the workflow has: the same processor it was loaded with needs no mark
      const unassigned = b.unassigned.filter((x) => x !== stepId);
      const assigned = copy(b.assigned);
      if (base.graph.steps.get(stepId)?.processorId === pr.id) delete assigned[stepId];
      else assigned[stepId] = pr.id;
      return { draft: withBlocks({ ...b, unassigned, assigned, refs }), picks: [{ kind: 'node', id: stepId }] };
    }
    case 'wire': {
      const [a, z] = wireLanding(p);
      const id = `${NEW_WIRE_PREFIX}${newId()}`;
      const circuit = copy(circuitOf(saved, draft));
      // on a contact: that end connected or joined there, the other open beside it (2026-10-20); else a free wire
      circuit[id] = verdict.kind === 'wire' ? toolWire(shown, verdict.target)
        : { tail: { on: 'open', x: a.x, y: a.y }, head: { on: 'open', x: z.x, y: z.y }, bends: { xs: [a.x], ys: [] } };
      return { draft: withCircuit(draft, saved, circuit), picks: [{ kind: 'wire', id }] };
    }
  }
}

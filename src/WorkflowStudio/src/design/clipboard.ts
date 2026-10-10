import type { StudioDocument } from '../app/document';
import { NEW_WIRE_PREFIX, parseCircuit, removeCircuitWires, shiftBends, type Circuit, type CircuitWire, type End } from '../circuit/circuit';
import { endPointOf } from '../layout/circuitRoute';
import { CACHE_H, CACHE_W, CELL, GRID, SPHERE_R, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import { isNum, shapeFromPoints } from '../layout/shape';
import { assignmentByStep } from '../model/assignments';
import type { Id, Processor, Schema } from '../model/graph';
import { nodePickIds, wirePickIds, type Pick } from '../store/picks';
import { applyDraft, applyEdits } from './apply';
import { parseFields, type Blocks, type NewStep } from './blocks';
import type { EntityEdits, FieldValue } from './design';
import { circuitOf, withCircuit, type Draft } from './draft';

/** A step as copied: its id in the workflow it came from, the fields it showed, where it was. */
export interface ClipStep {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  processorId: Id;
  entryCondition: number;
  at: Point;
  /** Its assignment as copied: the real row it copies (`copyOf`) and the fields it showed (payload included). */
  assignment: { copyOf: Id | null; fields: Record<string, FieldValue> } | null;
}

export interface ClipCache {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  root: string;
  items: string;
  at: Point;
}

/**
 * The studio's clipboard (copy and paste, 2026-10-10): what Ctrl+C copied, in any open workflow, kept with the session
 * so a refresh keeps it. The workflow (hub) and processors are never copied: a step keeps its processor (`processors`,
 * `schemas`: what a paste into a workflow that does not carry them needs to draw them).
 */
export interface Clip {
  /** The workflow it was copied in. */
  from: Id;
  steps: ClipStep[];
  caches: ClipCache[];
  /** The wires copied, by their ids where copied, their ends naming the copied steps and wires by those ids. */
  wires: Circuit;
  processors: Processor[];
  schemas: Schema[];
  /** How many times it was pasted: each paste of it starts one more 32 px step away (the cascade). */
  pasted: number;
}

/** One paste's offset step (4 grid steps), and the margin a pasted block keeps from every other block. */
export const PASTE_STEP = 4 * GRID;
export const PASTE_MARGIN = GRID;

const isStepNode = (id: string) => id !== SPHERE_NODE_ID && !id.startsWith(CACHE_NODE_PREFIX);

/** The workflow as the canvas draws it, and the workflow (with the draft's blocks and the edits) it is drawn over. */
function views(base: StudioDocument, edits: EntityEdits, draft: Draft): { saved: StudioDocument; shown: StudioDocument } {
  const saved = applyEdits(base, edits, draft.blocks);
  return { saved, shown: applyDraft(saved, draft) };
}

/** Where an end of a wire is, against the copied steps and wires: on one of them, on something left out, or open. */
type Footing = 'in' | 'out' | 'open';

function footing(e: End, steps: ReadonlySet<Id>, wires: ReadonlySet<string>): Footing {
  switch (e.on) {
    case 'step': return steps.has(e.step) ? 'in' : 'out';
    case 'hub': return 'out';
    case 'wire': return wires.has(e.host) ? 'in' : 'out';
    case 'open': return 'open';
  }
}

/**
 * What Ctrl+C copies (2026-10-10, the user's decisions 2-4): the picked steps and caches (the hub is skipped), each step
 * with its assignment as the design shows it; the wires running between copied items (an end on a copied step or joined
 * on a copied wire, none on anything left out; an open end stays open; junctions among them keep their place along their
 * host); a picked wire with no end on a copied item is copied as a free wire, both ends open where it is drawn and its
 * drawn shape kept. A picked wire with an end on something left out and one on a copied item is left out. Null when the
 * picks hold nothing to copy (the hub alone).
 */
export function copyClip(base: StudioDocument, edits: EntityEdits, draft: Draft, picks: readonly Pick[], from: Id): Clip | null {
  const { saved, shown } = views(base, edits, draft);
  const g = shown.graph;
  const circuit = circuitOf(saved, draft);
  const nodes = nodePickIds(picks);
  const stepIds = nodes.filter((id) => isStepNode(id) && g.steps.has(id) && shown.placement.steps.has(id));
  const cacheIds = nodes.filter((id) => id.startsWith(CACHE_NODE_PREFIX)).map((id) => id.slice(CACHE_NODE_PREFIX.length))
    .filter((id) => g.caches.has(id) && shown.placement.caches.has(id));
  const picked = wirePickIds(picks).filter((id) => Object.hasOwn(circuit, id));
  if (stepIds.length + cacheIds.length + picked.length === 0) return null;

  const steps = new Set(stepIds);
  // the wires between copied items: a junction wire comes when its host does, so this grows until it settles
  const inside = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, w] of Object.entries(circuit)) {
      if (inside.has(id)) continue;
      const t = footing(w.tail, steps, inside), h = footing(w.head, steps, inside);
      if (t !== 'out' && h !== 'out' && (t === 'in' || h === 'in')) { inside.add(id); grew = true; }
    }
  }
  const wires: Circuit = Object.create(null) as Circuit;
  for (const id of inside) wires[id] = circuit[id]!;
  const drawn = new Map(shown.wires.map((w) => [w.id, w.points]));
  for (const id of picked) {
    if (inside.has(id)) continue;
    const w = circuit[id]!;
    if (footing(w.tail, steps, inside) === 'in' || footing(w.head, steps, inside) === 'in') continue;
    const points = drawn.get(id);
    if (!points || points.length < 2) continue;
    // a free wire: both ends open where it is drawn, its drawn shape kept (as a wire moved whole, rule B)
    const [x0, y0] = points[0]!, [x1, y1] = points[points.length - 1]!;
    const shape = shapeFromPoints(points);
    wires[id] = { tail: { on: 'open', x: x0, y: y0 }, head: { on: 'open', x: x1, y: y1 }, bends: shape.xs.length > 0 ? shape : { xs: [x0], ys: [] } };
  }

  const byStep = assignmentByStep(g.assignments);
  const clipSteps: ClipStep[] = stepIds.map((id) => {
    const s = g.steps.get(id)!;
    const at = shown.placement.steps.get(id)!;
    return {
      id, name: s.name, version: s.version, description: s.description, processorId: s.processorId, entryCondition: s.entryCondition,
      at: { x: at.x, y: at.y }, assignment: assignmentClip(id, byStep.get(id), draft.blocks, edits),
    };
  });
  const clipCaches: ClipCache[] = cacheIds.map((id) => {
    const c = g.caches.get(id)!;
    const at = shown.placement.caches.get(id)!;
    return { id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, at: { x: at.x, y: at.y } };
  });
  const processors = [...new Set(clipSteps.map((s) => s.processorId))].flatMap((pid) => { const p = g.processors.get(pid); return p ? [p] : []; });
  const schemaIds = new Set(processors.flatMap((p) => [p.inputSchemaId, p.outputSchemaId, p.configSchemaId].filter((x): x is Id => x !== null)));
  const schemas = [...schemaIds].flatMap((sid) => { const s = g.schemas.get(sid); return s ? [s] : []; });
  return { from, steps: clipSteps, caches: clipCaches, wires, processors, schemas, pasted: 0 };
}

/**
 * A copied step's assignment (decision 3): the fields the design shows, its payload included, and the real row they
 * come from (`copyOf`, so BaseApi fills what the studio does not hold: its name, version, description). A pasted step's
 * copy keeps its own original's row; an assignment created in the Inspector has no row, only its fields.
 */
function assignmentClip(stepId: Id, a: { id: Id; payload: string } | undefined, blocks: Blocks, edits: EntityEdits): ClipStep['assignment'] {
  if (!a) return null;
  const op = edits.assignments[stepId];
  const edited = op && op.op !== 'delete' && op.id === a.id ? op.fields : {};
  const pasted = blocks.steps[stepId]?.assignment;
  if (pasted && pasted.id === a.id) return { copyOf: pasted.copyOf, fields: { ...pasted.fields, ...edited, payload: a.payload } };
  if (op?.op === 'create' && op.id === a.id) return { copyOf: null, fields: { ...op.fields, payload: a.payload } };
  return { copyOf: a.id, fields: { ...edited, payload: a.payload } };
}

// ---- where a paste lands ----

interface Box { x: number; y: number; w: number; h: number }

/** The blocks of a canvas in buckets of 256 px, so a box asks only its neighbours (fast on a crowded canvas). */
class BoxIndex {
  private static readonly CELL = 256;
  private readonly cells = new Map<string, Box[]>();

  constructor(boxes: readonly Box[]) {
    for (const b of boxes) for (const k of this.keys(b)) (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(b);
  }

  private *keys(b: Box): Generator<string> {
    const c = BoxIndex.CELL;
    for (let i = Math.floor(b.x / c); i <= Math.floor((b.x + b.w) / c); i++) {
      for (let j = Math.floor(b.y / c); j <= Math.floor((b.y + b.h) / c); j++) yield `${i},${j}`;
    }
  }

  /** Whether `b` overlaps a box (sharing more than an edge). */
  hits(b: Box): boolean {
    for (const k of this.keys(b)) {
      for (const o of this.cells.get(k) ?? []) {
        if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) return true;
      }
    }
    return false;
  }
}

/** Every block of a canvas as a box: the hub's square, the steps, the caches. */
export function blockBoxes(doc: StudioDocument): Box[] {
  const { cx, cy } = doc.placement.sphere;
  return [
    { x: cx - SPHERE_R, y: cy - SPHERE_R, w: 2 * SPHERE_R, h: 2 * SPHERE_R },
    ...[...doc.placement.steps.values()].map((p) => ({ x: p.x, y: p.y, w: STEP_W, h: STEP_H })),
    ...[...doc.placement.caches.values()].map((p) => ({ x: p.x, y: p.y, w: CACHE_W, h: CACHE_H })),
  ];
}

/** How far out the search goes (in 32 px steps) before the group goes below everything. */
const MAX_RING = 64;

/**
 * Where a pasted group lands (the user's rule, 2026-10-10): `start` (the cascade's +32 / +32 per paste) when no block of
 * the group, grown by `margin` on every side, overlaps a block already there or one of the group's own originals;
 * otherwise the nearest offset from `start` on the 32 px grid where none does, the group moved as one rigid unit. Rings
 * of growing size are searched in turn, each nearest first, then right and down before left and up (deterministic).
 * Past the last ring the group goes below every block.
 */
export function freeOffset(group: readonly Box[], obstacles: readonly Box[], start: Point, margin = PASTE_MARGIN): Point {
  if (group.length === 0) return start;
  const index = new BoxIndex(obstacles.map((o) => ({ x: o.x - margin, y: o.y - margin, w: o.w + 2 * margin, h: o.h + 2 * margin })));
  const fits = (dx: number, dy: number) => group.every((b) => !index.hits({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }));
  if (fits(start.x, start.y)) return start;
  for (let r = 1; r <= MAX_RING; r++) {
    const ring: [number, number][] = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) if (Math.max(Math.abs(i), Math.abs(j)) === r) ring.push([i, j]);
    ring.sort(([ai, aj], [bi, bj]) => (ai * ai + aj * aj) - (bi * bi + bj * bj)
      || (Number(ai < 0) + Number(aj < 0)) - (Number(bi < 0) + Number(bj < 0)) || bi - ai || bj - aj);
    for (const [i, j] of ring) {
      const dx = start.x + i * CELL, dy = start.y + j * CELL;
      if (fits(dx, dy)) return { x: dx, y: dy };
    }
  }
  const bottom = Math.max(...obstacles.map((o) => o.y + o.h), ...group.map((b) => b.y + b.h));
  const top = Math.min(...group.map((b) => b.y));
  return { x: start.x, y: Math.ceil((bottom + margin + CELL - top) / CELL) * CELL };
}

/** The boxes of a clip's blocks where they were copied. */
const clipBoxes = (clip: Clip): Box[] => [
  ...clip.steps.map((s) => ({ x: s.at.x, y: s.at.y, w: STEP_W, h: STEP_H })),
  ...clip.caches.map((c) => ({ x: c.at.x, y: c.at.y, w: CACHE_W, h: CACHE_H })),
];

const copy = <T>(r: Readonly<Record<string, T>>): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, r);

/**
 * Ctrl+V (2026-10-10, the user's decisions 3-5 and the free-space rule): the clip's blocks and wires as new ones, every
 * one with a new id (a step a new step entity with the same processor, its assignment a new one with the original's
 * fields; a cache a new cache; a wire a new design wire), same names and versions, moved together by `freeOffset` from
 * where they were copied (+32 / +32 per paste so far plus this one), clear of every block of the workflow pasted into
 * and, pasted into the workflow it was copied in (`into`), of the area its originals had. Copied wires keep their
 * shapes moved by the same offset, junctions their place along their host. The pasted items are the new picks. Null
 * when the clip holds nothing.
 */
export function pasteClip(base: StudioDocument, edits: EntityEdits, draft: Draft, clip: Clip, newId: () => string, into: Id = clip.from): { draft: Draft; picks: Pick[] } | null {
  if (clip.steps.length + clip.caches.length + Object.keys(clip.wires).length === 0) return null;
  const { saved, shown } = views(base, edits, draft);
  const k = clip.pasted + 1;
  const start = { x: k * PASTE_STEP, y: k * PASTE_STEP };
  const group = clipBoxes(clip);
  const { x: dx, y: dy } = freeOffset(group, [...blockBoxes(shown), ...(into === clip.from ? group : [])], start);

  const stepIds = new Map(clip.steps.map((s) => [s.id, newId()]));
  const cacheIds = new Map(clip.caches.map((c) => [c.id, newId()]));
  const wireIds = new Map(Object.keys(clip.wires).map((id) => [id, `${NEW_WIRE_PREFIX}${newId()}`]));

  const steps = copy(draft.blocks.steps);
  for (const s of clip.steps) {
    const made: NewStep = {
      copyOf: s.id, name: s.name, version: s.version, description: s.description, processorId: s.processorId, entryCondition: s.entryCondition,
      at: { x: s.at.x + dx, y: s.at.y + dy },
      assignment: s.assignment && { id: newId(), copyOf: s.assignment.copyOf, fields: { ...s.assignment.fields } },
    };
    steps[stepIds.get(s.id)!] = made;
  }
  const caches = copy(draft.blocks.caches);
  for (const c of clip.caches) {
    caches[cacheIds.get(c.id)!] = { copyOf: c.id, name: c.name, version: c.version, description: c.description, root: c.root, items: c.items, at: { x: c.at.x + dx, y: c.at.y + dy } };
  }
  const processors = copy(draft.blocks.refs.processors), schemas = copy(draft.blocks.refs.schemas);
  for (const p of clip.processors) if (!saved.graph.processors.has(p.id)) processors[p.id] = p;
  for (const s of clip.schemas) if (!saved.graph.schemas.has(s.id)) schemas[s.id] = s;
  const blocks: Blocks = { ...draft.blocks, steps, caches, refs: { processors, schemas } };

  const withBlocks: Draft = { ...draft, blocks };
  const pastedOn = applyEdits(base, edits, blocks);
  const circuit = copy(circuitOf(pastedOn, withBlocks));
  const end = (e: End): End => {
    switch (e.on) {
      case 'step': return { on: 'step', step: stepIds.get(e.step) ?? e.step, y: e.y };
      case 'wire': return { on: 'wire', host: wireIds.get(e.host) ?? e.host, at: e.at };
      case 'open': return { on: 'open', x: e.x + dx, y: e.y + dy };
      case 'hub': return e;
    }
  };
  for (const [id, w] of Object.entries(clip.wires)) {
    const made: CircuitWire = { tail: end(w.tail), head: end(w.head) };
    if (w.bends && w.bends.xs.length > 0) made.bends = shiftBends(w.bends, dx, dy);
    if (w.held !== undefined) made.held = w.held;
    circuit[wireIds.get(id)!] = made;
  }
  const next = withCircuit(withBlocks, pastedOn, circuit);
  const picks: Pick[] = [
    ...clip.steps.map((s): Pick => ({ kind: 'node', id: stepIds.get(s.id)! })),
    ...clip.caches.map((c): Pick => ({ kind: 'node', id: cacheNodeId(cacheIds.get(c.id)!) })),
    ...Object.keys(clip.wires).map((id): Pick => ({ kind: 'wire', id: wireIds.get(id)! })),
  ];
  return { draft: next, picks };
}

/**
 * Delete (2026-10-10, the user's decision 6): the picked steps and caches leave the design with every wire that has an
 * end on a deleted step, and the picked wires go too; a wire joined on a wire that goes opens where it is drawn (plan 9
 * §2.2-6). The hub is never deleted (skipped). A pasted step or cache is simply gone; one the workflow has is removed
 * (Save deletes the entity). The picks left: the hub, if it was picked. Null when nothing is deleted.
 */
export function deletePicked(base: StudioDocument, edits: EntityEdits, draft: Draft, picks: readonly Pick[]): { draft: Draft; picks: Pick[] } | null {
  const { saved, shown } = views(base, edits, draft);
  const circuit = circuitOf(saved, draft);
  const nodes = nodePickIds(picks);
  const stepIds = nodes.filter((id) => isStepNode(id) && saved.graph.steps.has(id) && saved.placement.steps.has(id));
  const cacheIds = nodes.filter((id) => id.startsWith(CACHE_NODE_PREFIX)).map((id) => id.slice(CACHE_NODE_PREFIX.length))
    .filter((id) => saved.graph.caches.has(id));
  const gone = new Set(stepIds);
  const onGone = (e: End) => e.on === 'step' && gone.has(e.step);
  const wires = [...new Set([
    ...wirePickIds(picks).filter((id) => Object.hasOwn(circuit, id)),
    ...Object.entries(circuit).filter(([, w]) => onGone(w.tail) || onGone(w.head)).map(([id]) => id),
  ])];
  if (stepIds.length + cacheIds.length + wires.length === 0) return null;

  const steps = copy(draft.blocks.steps), caches = copy(draft.blocks.caches);
  const removedSteps = [...draft.blocks.removed.steps], removedCaches = [...draft.blocks.removed.caches];
  const moved = copy(draft.steps), movedCaches = copy(draft.caches);
  for (const id of stepIds) {
    if (Object.hasOwn(steps, id)) delete steps[id];
    else if (!removedSteps.includes(id)) removedSteps.push(id);
    delete moved[id];
  }
  for (const id of cacheIds) {
    if (Object.hasOwn(caches, id)) delete caches[id];
    else if (!removedCaches.includes(id)) removedCaches.push(id);
    delete movedCaches[id];
  }
  // what pasted steps still need from other workflows; nothing else is kept
  const used = new Set(Object.values(steps).map((s) => s.processorId));
  const processors = copy<Processor>({});
  for (const [pid, p] of Object.entries(draft.blocks.refs.processors)) if (used.has(pid)) processors[pid] = p;
  const slots = new Set(Object.values(processors).flatMap((p) => [p.inputSchemaId, p.outputSchemaId, p.configSchemaId]));
  const schemas = copy<Schema>({});
  for (const [sid, s] of Object.entries(draft.blocks.refs.schemas)) if (slots.has(sid)) schemas[sid] = s;
  const blocks: Blocks = { steps, caches, removed: { steps: removedSteps, caches: removedCaches }, refs: { processors, schemas } };

  const after = removeCircuitWires(circuit, wires, endPointOf(shown.wires));
  const next = withCircuit({ ...draft, blocks, steps: moved, caches: movedCaches }, applyEdits(base, edits, blocks), after);
  return { draft: next, picks: picks.filter((p) => p.kind === 'node' && p.id === SPHERE_NODE_ID) };
}

// ---- reading back (the session's clipboard); anything malformed is dropped ----

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const pointOf = (v: unknown): Point | null => (isRecord(v) && isNum(v.x) && isNum(v.y) ? { x: v.x, y: v.y } : null);

function clipStep(v: unknown): ClipStep | null {
  if (!isRecord(v)) return null;
  const id = str(v.id), name = str(v.name), version = str(v.version), processorId = str(v.processorId), at = pointOf(v.at);
  if (!id || name === null || version === null || !processorId || !isNum(v.entryCondition) || !at) return null;
  const a = isRecord(v.assignment) ? { copyOf: str(v.assignment.copyOf) || null, fields: parseFields(v.assignment.fields) } : null;
  return { id, name, version, description: str(v.description), processorId, entryCondition: v.entryCondition, at, assignment: a };
}

function clipCache(v: unknown): ClipCache | null {
  if (!isRecord(v)) return null;
  const id = str(v.id), name = str(v.name), version = str(v.version), root = str(v.root), items = str(v.items), at = pointOf(v.at);
  if (!id || name === null || version === null || root === null || items === null || !at) return null;
  return { id, name, version, description: str(v.description), root, items, at };
}

const listOf = <T>(v: unknown, parse: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.flatMap((x) => { const p = parse(x); return p === null ? [] : [p]; }) : []);
const ref = <T>(v: unknown): T | null => (isRecord(v) && typeof v.id === 'string' && v.id !== '' && typeof v.name === 'string' ? (v as unknown as T) : null);

/** The clipboard a session kept, or null when it is not one. */
export function parseClip(v: unknown): Clip | null {
  if (!isRecord(v) || typeof v.from !== 'string') return null;
  const steps = listOf(v.steps, clipStep), caches = listOf(v.caches, clipCache);
  const wires = parseCircuit(v.wires) ?? (Object.create(null) as Circuit);
  // a wire naming a step or a wire the clip does not hold could not be pasted: it is dropped
  const stepIds = new Set(steps.map((s) => s.id));
  const ok = (e: End) => (e.on === 'step' ? stepIds.has(e.step) : e.on === 'wire' ? Object.hasOwn(wires, e.host) : e.on === 'open');
  for (let dropped = true; dropped;) {
    dropped = false;
    for (const [id, w] of Object.entries(wires)) if (!ok(w.tail) || !ok(w.head)) { delete wires[id]; dropped = true; }
  }
  if (steps.length + caches.length + Object.keys(wires).length === 0) return null;
  return {
    from: v.from, steps, caches, wires, processors: listOf(v.processors, ref<Processor>), schemas: listOf(v.schemas, ref<Schema>),
    pasted: isNum(v.pasted) && v.pasted >= 0 ? Math.floor(v.pasted) : 0,
  };
}


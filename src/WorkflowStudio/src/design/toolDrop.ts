import type { StudioDocument } from '../app/document';
import { NEW_WIRE_PREFIX } from '../circuit/circuit';
import { CACHE_H, CACHE_W, snap, STEP_H, STEP_W, type Point } from '../layout/geometry';
import { CACHE_NODE_PREFIX, cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Cache, Id, Processor, Schema } from '../model/graph';
import type { Pick } from '../store/picks';
import { applyDraft, applyEdits } from './apply';
import type { Blocks } from './blocks';
import type { EntityEdits } from './design';
import { circuitOf, withCircuit, type Draft } from './draft';
import { blockAt } from './hit';

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
  | { kind: 'assign' | 'replace'; stepId: Id }
  | { kind: 'noStep' }
  | { kind: 'linked'; cacheId: Id };

export function judgeTool(shown: StudioDocument, item: ToolItem, p: Point): ToolVerdict {
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
  if (saving) return { text: 'saving: wait for the answer', tone: 'no' };
  switch (v.kind) {
    case 'place': return null;
    case 'assign': return { text: 'assign processor', tone: 'ok' };
    case 'replace': return { text: 'replace processor', tone: 'ok' };
    case 'noStep': return { text: 'drop on a step', tone: 'no' };
    case 'linked': return { text: 'already in this workflow', tone: 'no' };
  }
}

/** The box a dropped block takes, centred on the pointer and on the 8 px grid (flow coordinates). */
export function landingBox(item: ToolItem, p: Point): { x: number; y: number; w: number; h: number } | null {
  const size = item.kind === 'step' ? { w: STEP_W, h: STEP_H } : item.kind === 'newCache' || item.kind === 'cache' ? { w: CACHE_W, h: CACHE_H } : null;
  return size && { x: snap(p.x - size.w / 2), y: snap(p.y - size.h / 2), ...size };
}

/** A dropped wire's two ends: from the pointer, on the grid, `DROPPED_WIRE` to the right. */
export const wireLanding = (p: Point): [Point, Point] => {
  const a = { x: snap(p.x), y: snap(p.y) };
  return [a, { x: a.x + DROPPED_WIRE, y: a.y }];
};

/** `base`, then `base-2`, `base-3`, … : the first not in `taken`. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const copy = <T>(r: Readonly<Record<string, T>> = {}): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, r);

/** Default entry condition of a new step: PreviousCompleted (BaseApi's default). */
const NEW_STEP_CONDITION = 1;

/**
 * A Toolbox drop on a workflow's canvas (2026-10-11), as a paste is: one history step, the new item picked. `base` is the
 * workflow as loaded, `edits` and `draft` the design over it; `knownRoots` every cache root the studio knows (the open
 * workflows', and every cache BaseApi listed), so a new cache's root is no other's. Null when the drop is refused
 * (`judgeTool`): a processor not on a step, or a cache already in this workflow.
 */
export function dropTool(
  base: StudioDocument, edits: EntityEdits, draft: Draft, item: ToolItem, p: Point, newId: () => string, knownRoots: Iterable<string> = [],
): { draft: Draft; picks: Pick[] } | null {
  const saved = applyEdits(base, edits, draft.blocks);
  const shown = applyDraft(saved, draft);
  const verdict = judgeTool(shown, item, p);
  if (verdict.kind === 'noStep' || verdict.kind === 'linked') return null;
  const b = draft.blocks;
  const withBlocks = (blocks: Blocks): Draft => ({ ...draft, blocks });

  switch (item.kind) {
    case 'step': {
      const id = newId();
      const box = landingBox(item, p)!;
      const name = uniqueName('step', new Set([...shown.graph.steps.values()].map((s) => s.name)));
      const steps = copy(b.steps);
      steps[id] = { copyOf: null, name, version: '1.0.0', description: null, processorId: null, entryCondition: NEW_STEP_CONDITION, at: { x: box.x, y: box.y }, assignment: null };
      return { draft: withBlocks({ ...b, steps }), picks: [{ kind: 'node', id }] };
    }
    case 'newCache': {
      const id = newId();
      const box = landingBox(item, p)!;
      const name = uniqueName('cache', new Set([...shown.graph.caches.values()].map((c) => c.name)));
      const root = uniqueName('cache', new Set([...knownRoots, ...[...shown.graph.caches.values()].map((c) => c.root)]));
      const caches = copy(b.caches);
      caches[id] = { copyOf: null, name, version: '1.0.0', description: null, root, items: '{}', at: { x: box.x, y: box.y } };
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
      circuit[id] = { tail: { on: 'open', x: a.x, y: a.y }, head: { on: 'open', x: z.x, y: z.y }, bends: { xs: [a.x], ys: [] } };
      return { draft: withCircuit(draft, saved, circuit), picks: [{ kind: 'wire', id }] };
    }
  }
}

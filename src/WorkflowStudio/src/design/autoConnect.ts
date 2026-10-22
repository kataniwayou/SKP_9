import type { StudioDocument } from '../app/document';
import { addCircuitWire, NEW_WIRE_PREFIX, type Circuit, type CircuitWire, type End } from '../circuit/circuit';
import { CACHE_H, CACHE_W, LAYOUT_GAP, PMID, SPHERE_R, STEP_H, STEP_W } from '../layout/geometry';
import { CACHE_NODE_PREFIX, SPHERE_NODE_ID } from '../layout/nodeIds';
import type { Id } from '../model/graph';
import type { Pick } from '../store/picks';
import { applyDraft, applyEdits } from './apply';
import type { EntityEdits } from './design';
import { circuitOf, withCircuit, type Draft } from './draft';
import { judgeDrop, toneOf } from './drop';
import { addStep } from './toolDrop';

/**
 * Visio's AutoConnect arrows (plan 10 phase 6, spec §4.8; measured 2026-10-22, `visio-reference/scripts/ui9.ps1`): the
 * arrow a block shows on each side, where a click there lands a new step, and what it wires.
 */
export type Dir = 'right' | 'left' | 'up' | 'down';

type Box = { x: number; y: number; w: number; h: number };

const hasTail = (c: Readonly<Circuit>, id: string) =>
  Object.values(c).some((w) => (id === SPHERE_NODE_ID ? w.tail.on === 'hub' : w.tail.on === 'step' && w.tail.step === id));
const hasHead = (c: Readonly<Circuit>, id: string) => Object.values(c).some((w) => w.head.on === 'step' && w.head.step === id);

/**
 * The arrows block `id` shows (Visio: a side with a wire shows none): a step its right arrow while its output has no
 * wire, its left while its input has none, up and down always; the hub its right arrow while it has no tail; a cache none.
 */
export function arrowsOf(shown: StudioDocument, circuit: Readonly<Circuit>, id: string): Dir[] {
  if (id === SPHERE_NODE_ID) return hasTail(circuit, id) ? [] : ['right'];
  if (!shown.placement.steps.has(id)) return [];
  return [...(hasTail(circuit, id) ? [] : ['right' as const]), ...(hasHead(circuit, id) ? [] : ['left' as const]), 'up', 'down'];
}

/** Where a click on block `id`'s `dir` arrow lands a new step: one layout gap that way, in line with the block. */
export function landingOf(shown: StudioDocument, id: string, dir: Dir): Box {
  if (id === SPHERE_NODE_ID) {
    const { cx, cy } = shown.placement.sphere;
    return { x: cx + SPHERE_R + LAYOUT_GAP, y: cy - PMID, w: STEP_W, h: STEP_H };
  }
  const p = shown.placement.steps.get(id)!;
  const x = dir === 'right' ? p.x + STEP_W + LAYOUT_GAP : dir === 'left' ? p.x - LAYOUT_GAP - STEP_W : p.x;
  const y = dir === 'down' ? p.y + STEP_H + LAYOUT_GAP : dir === 'up' ? p.y - LAYOUT_GAP - STEP_H : p.y;
  return { x, y, w: STEP_W, h: STEP_H };
}

/** What a click there does: a new step on an empty spot; the step already on it wired (`ok`: the rules allow it); refused on a cache or the hub. */
export type AutoTarget = { kind: 'new'; box: Box } | { kind: 'step'; step: Id; ok: boolean } | { kind: 'blocked' };

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** The wire a click makes between block `id` and step `other`: from the block's output (or the hub), but into its input for `left`. */
function wireFor(id: string, dir: Dir, other: Id): CircuitWire {
  const at = (step: Id): End => ({ on: 'step', step, y: null });
  const source: End = id === SPHERE_NODE_ID ? { on: 'hub', angle: null } : at(id);
  return dir === 'left' ? { tail: at(other), head: at(id) } : { tail: source, head: at(other) };
}

/** The id a wire to an existing step is judged under. */
const PROBE = `${NEW_WIRE_PREFIX}auto`;

/**
 * Visio's: a click wires to a shape already on the landing spot (level, or half a shape off: their boxes overlap), the
 * one overlapping it most; judged as a dragged end onto that step's side is. A cache or the hub there refuses it.
 */
export function autoTarget(shown: StudioDocument, circuit: Readonly<Circuit>, id: string, dir: Dir): AutoTarget {
  const box = landingOf(shown, id, dir);
  let best: { step: Id; area: number } | null = null;
  for (const [s, p] of shown.placement.steps) {
    if (s === id) continue;
    const area = overlap(box, { x: p.x, y: p.y, w: STEP_W, h: STEP_H });
    if (area > 0 && (best === null || area > best.area)) best = { step: s, area };
  }
  if (best !== null) {
    const w = wireFor(id, dir, best.step);
    // judged as the wire's far end dropped on the step's side, its other end where the click makes it
    const probe = dir === 'left' ? { tail: { on: 'open', x: 0, y: 0 } as End, head: w.head } : { tail: w.tail, head: { on: 'open', x: 0, y: 0 } as End };
    const c = addCircuitWire(circuit, PROBE, probe);
    const why = judgeDrop(shown, c, PROBE, dir === 'left' ? 'tail' : 'head', { on: 'step', step: best.step, side: dir === 'left' ? 'out' : 'in', y: PMID });
    return { kind: 'step', step: best.step, ok: toneOf(why) === 'ok' };
  }
  const { cx, cy } = shown.placement.sphere;
  const blocks = [{ x: cx - SPHERE_R, y: cy - SPHERE_R, w: 2 * SPHERE_R, h: 2 * SPHERE_R },
    ...[...shown.placement.caches.values()].map((p) => ({ x: p.x, y: p.y, w: CACHE_W, h: CACHE_H }))];
  return blocks.some((b) => overlap(box, b) > 0) ? { kind: 'blocked' } : { kind: 'new', box };
}

/**
 * A click on block `id`'s `dir` arrow (Visio's AutoConnect): on an empty spot a new empty step there, wired to (or, for
 * `left`, into) the block, picked; on a step there only the wire, the picks cleared. One draft (one Undo step). Null when
 * the block shows no such arrow, or the click is refused.
 */
export function autoConnect(
  base: StudioDocument, edits: EntityEdits, draft: Draft, id: string, dir: Dir, newId: () => string,
): { draft: Draft; picks: Pick[] } | null {
  const saved = applyEdits(base, edits, draft.blocks);
  const shown = applyDraft(saved, draft);
  const circuit = circuitOf(saved, draft);
  if (id.startsWith(CACHE_NODE_PREFIX) || !arrowsOf(shown, circuit, id).includes(dir)) return null;
  const t = autoTarget(shown, circuit, id, dir);
  if (t.kind === 'blocked' || (t.kind === 'step' && !t.ok)) return null;
  if (t.kind === 'step') {
    return { draft: withCircuit(draft, saved, addCircuitWire(circuit, `${NEW_WIRE_PREFIX}${newId()}`, wireFor(id, dir, t.step))), picks: [] };
  }
  const added = addStep(shown, draft, { x: t.box.x, y: t.box.y }, newId);
  const withStep = applyEdits(base, edits, added.draft.blocks);
  const c = addCircuitWire(circuitOf(withStep, added.draft), `${NEW_WIRE_PREFIX}${newId()}`, wireFor(id, dir, added.id));
  return { draft: withCircuit(added.draft, withStep, c), picks: [{ kind: 'node', id: added.id }] };
}

import type { BoardState, ItemRef } from '../design/board';
import type { GhostItem } from '../design/ghosts';
import type { Point, Rect } from '../model/geometry';
import { PROCESSOR_H, PROCESSOR_W, SCHEMA_H, SCHEMA_W } from '../model/geometry';
import { steplessProcessors } from '../design/schemaStates';
import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W } from './geometry';
import { overlaps } from './overlap';

type Kind = ItemRef['kind'];
const SIZE: Record<Kind, { w: number; h: number }> = {
  workflow: { w: TRIANGLE_W, h: TRIANGLE_H }, step: { w: STEP_W, h: STEP_H }, cache: { w: CACHE_W, h: CACHE_H },
  schema: { w: SCHEMA_W, h: SCHEMA_H }, processor: { w: PROCESSOR_W, h: PROCESSOR_H },
};

/** An item's box on the board at `at`, in the sizes the board declares for it. */
export const rectAt = (kind: Kind, at: Point): Rect => ({ x: at.x, y: at.y, ...SIZE[kind] });

/**
 * Every placed triangle, step, cache and ghost on the board, keyed as `kind:id` (a ghost by its own key), less `except`:
 * what a toolbox drop or a nudge must not land on [user, 2026-11-25]. Items not yet placed take no room.
 */
export function occupied(b: BoardState, ghosts: readonly GhostItem[], except: ReadonlySet<string> = new Set(), withSchemas = false): Rect[] {
  const out: Rect[] = [];
  const add = (key: string, kind: Kind, at: Point | null | undefined) => { if (at && !except.has(key)) out.push(rectAt(kind, at)); };
  for (const w of Object.values(b.workflows)) add(`workflow:${w.id}`, 'workflow', w.at);
  for (const s of Object.values(b.steps)) add(`step:${s.id}`, 'step', s.at);
  for (const c of Object.values(b.caches)) add(`cache:${c.id}`, 'cache', c.at);
  // schemas mode: every placed schema card and stepless processor card is an obstacle too
  if (withSchemas) {
    for (const s of Object.values(b.schemas)) add(`schema:${s.id}`, 'schema', s.at);
    for (const id of steplessProcessors(b)) add(`processor:${id}`, 'processor', b.processors[id]!.at);
  }
  for (const g of ghosts) {
    // a schema ghost is drawn only in the Schemas mode, and only while its schema is gone
    if (g.kind === 'schema') { if (withSchemas && !b.schemas[g.row.id]) add(`ghost:${g.key}`, 'schema', g.row.at); continue; }
    if (g.kind !== 'step' && g.kind !== 'cache' && g.kind !== 'workflow') continue;
    // a ghost whose item is back on the board is not drawn
    const live = g.kind === 'step' ? b.steps[g.row.id] : g.kind === 'cache' ? b.caches[g.row.id] : b.workflows[g.row.id];
    if (!live) add(g.key.startsWith('ghost:') ? g.key : `ghost:${g.key}`, g.kind, g.row.at);
  }
  return out;
}

/** Whether a nudge's new boxes would lie on any other item (touching inside the drop gap is allowed: only a real overlap). */
export const nudgeBlocked = (moving: Rect[], others: Rect[]): boolean => moving.some((m) => others.some((o) => overlaps(m, o)));

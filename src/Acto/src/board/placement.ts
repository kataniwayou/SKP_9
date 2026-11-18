import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import type { BoardState } from '../design/board';
import { freeOffset } from '../operate/freeOffset';
import { STEP_H, STEP_W } from './geometry';

/** Card sizes for no-overlap placement (a triangle and a cache chip are smaller than a step). */
const TRIANGLE = { w: 120, h: 104 };
const CACHE = { w: 160, h: 56 };
const STEP = { w: STEP_W, h: STEP_H };
const CACHE_BELOW = 120;
const STEP_RIGHT = 280;
const TRIANGLE_LEFT = 160;
const COLUMN_GAP = 320;
const COLUMN_STEP = 40;

type Kind = 'workflows' | 'steps' | 'caches';
const SIZE: Record<Kind, { w: number; h: number }> = { workflows: TRIANGLE, steps: STEP, caches: CACHE };

/**
 * Gives every row without a location (`at === null`) one: next to what connects to it, else in a column to the right of
 * everything placed. Rows that already have a location stay where they are; no placed card is covered.
 */
export function placeMissing(b: BoardState): BoardState {
  const at = new Map<string, Point>(); // key `${kind}:${id}`
  const key = (k: Kind, id: Id) => `${k}:${id}`;
  const missing: [Kind, Id][] = [];
  for (const k of ['workflows', 'steps', 'caches'] as const) {
    for (const [id, row] of Object.entries(b[k])) {
      if (row.at) at.set(key(k, id), row.at);
      else missing.push([k, id]);
    }
  }
  if (missing.length === 0) return b;

  const rects = (): Rect[] => [...at].map(([kk, p]) => ({ ...p, ...SIZE[kk.slice(0, kk.indexOf(':')) as Kind] }));
  const put = (k: Kind, id: Id, want: Point) => {
    const size = SIZE[k];
    const d = freeOffset([{ ...want, ...size }], rects(), { x: 0, y: 0 });
    at.set(key(k, id), { x: want.x + d.x, y: want.y + d.y });
  };

  // where an item should sit, by what is already placed; null when nothing placed connects to it
  const anchor = (k: Kind, id: Id): Point | null => {
    if (k === 'caches') {
      for (const w of Object.values(b.workflows)) {
        const p = w.cacheIds.includes(id) ? at.get(key('workflows', w.id)) : undefined;
        if (p) return { x: p.x, y: p.y + CACHE_BELOW };
      }
    } else if (k === 'steps') {
      for (const s of Object.values(b.steps)) {
        const p = s.nextStepIds.includes(id) ? at.get(key('steps', s.id)) : undefined;
        if (p) return { x: p.x + STEP_RIGHT, y: p.y };
      }
      for (const w of Object.values(b.workflows)) {
        const p = w.entryStepIds.includes(id) ? at.get(key('workflows', w.id)) : undefined;
        if (p) return { x: p.x + STEP_RIGHT, y: p.y };
      }
    } else {
      for (const sid of b.workflows[id]!.entryStepIds) {
        const p = at.get(key('steps', sid));
        if (p) return { x: p.x - TRIANGLE_LEFT, y: p.y };
      }
      for (const cid of b.workflows[id]!.cacheIds) {
        const p = at.get(key('caches', cid));
        if (p) return { x: p.x, y: p.y - CACHE_BELOW };
      }
    }
    return null;
  };

  let rest = missing;
  let column: Point | null = null;
  while (rest.length > 0) {
    const stuck: [Kind, Id][] = [];
    let progressed = false;
    for (const [k, id] of rest) {
      const want = anchor(k, id);
      if (want) { put(k, id, want); progressed = true; } else stuck.push([k, id]);
    }
    rest = stuck;
    if (!progressed && rest.length > 0) {
      const [k, id] = rest.shift()!;
      if (!column) {
        const right = Math.max(-COLUMN_GAP, ...rects().map((r) => r.x + r.w));
        column = { x: right + COLUMN_GAP, y: Math.min(0, ...rects().map((r) => r.y)) };
      }
      put(k, id, column);
      column = { x: column.x, y: column.y + SIZE[k].h + COLUMN_STEP };
    }
  }

  const fill = <R extends { id: Id; at: Point | null }>(k: Kind, rows: Record<Id, R>): Record<Id, R> =>
    Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.at ? r : { ...r, at: at.get(key(k, id))! }]));
  return {
    ...b,
    workflows: fill('workflows', b.workflows),
    steps: fill('steps', b.steps),
    caches: fill('caches', b.caches),
  };
}

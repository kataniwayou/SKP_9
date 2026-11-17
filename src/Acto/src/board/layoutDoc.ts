import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';

/**
 * A workflow's stored layout as Acto reads it: step and cache positions, parked steps, and the
 * workflow's frame rectangle on the board. Nothing in a layout is ever an error; any part that is
 * not the right shape is ignored.
 */
export interface ActoLayout {
  steps: Record<Id, Point>;
  caches: Record<Id, Point>;
  parked: Id[];
  board: Rect | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function toPoint(v: unknown): Point | null {
  if (!isRecord(v)) return null;
  const { x, y } = v;
  return isNum(x) && isNum(y) ? { x, y } : null;
}

function toRect(v: unknown): Rect | null {
  if (!isRecord(v)) return null;
  const { x, y, w, h } = v;
  return isNum(x) && isNum(y) && isNum(w) && isNum(h) ? { x, y, w, h } : null;
}

function toPoints(v: unknown): Record<Id, Point> {
  // Null prototype: an id such as `__proto__` is an ordinary key, never an alias.
  const out: Record<Id, Point> = Object.create(null) as Record<Id, Point>;
  if (!isRecord(v)) return out;
  for (const [id, raw] of Object.entries(v)) {
    const point = toPoint(raw);
    if (point) out[id] = point;
  }
  return out;
}

/** Never throws; always a fresh object. */
export function parseActoLayout(raw: unknown): ActoLayout {
  if (!isRecord(raw)) return { steps: toPoints(null), caches: toPoints(null), parked: [], board: null };
  const parked = Array.isArray(raw.parked)
    ? [...new Set(raw.parked.filter((id): id is string => typeof id === 'string' && id !== ''))]
    : [];
  return { steps: toPoints(raw.steps), caches: toPoints(raw.caches), parked, board: toRect(raw.board) };
}

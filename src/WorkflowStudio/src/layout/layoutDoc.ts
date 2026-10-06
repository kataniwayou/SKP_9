import type { Id } from '../model/graph';
import type { Point } from './geometry';

/**
 * The workflow's stored canvas layout (the `Layout` column), version 1: positions only, never graph
 * facts (spec §4.3). The tables decide what exists; an id in here that no longer exists is ignored by
 * the caller, and any part that is not the shape below is ignored here. Nothing in a layout is ever
 * an error.
 */
export interface LayoutDoc {
  /** The sphere's centre. */
  sphere: Point | null;
  /** Top-left corners of steps, parked ones included. */
  steps: Record<Id, Point>;
  /** Top-left corners of cache tags. */
  caches: Record<Id, Point>;
  /** Steps placed on the canvas but not wired in. */
  parked: Id[];
}

export const EMPTY_LAYOUT: LayoutDoc = Object.freeze({ sphere: null, steps: {}, caches: {}, parked: [] }) as LayoutDoc;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function toPoint(v: unknown): Point | null {
  if (!isRecord(v)) return null;
  const { x, y } = v;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? { x, y } : null;
}

function toPoints(v: unknown): Record<Id, Point> {
  const out: Record<Id, Point> = {};
  if (!isRecord(v)) return out;
  for (const [id, raw] of Object.entries(v)) {
    const point = toPoint(raw);
    if (point) out[id] = point;
  }
  return out;
}

export function parseLayout(raw: unknown): LayoutDoc {
  if (!isRecord(raw)) return EMPTY_LAYOUT;
  const parked = Array.isArray(raw.parked)
    ? [...new Set(raw.parked.filter((id): id is string => typeof id === 'string' && id !== ''))]
    : [];
  return { sphere: toPoint(raw.sphere), steps: toPoints(raw.steps), caches: toPoints(raw.caches), parked };
}

import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import type { BoardState } from '../design/board';
import { freeOffset } from '../operate/freeOffset';
import type { GhostItem } from '../design/ghosts';
import { moveItems } from '../design/edits';
import { schemaRefs, steplessProcessors } from '../design/schemaStates';
import { PROCESSOR_H, PROCESSOR_W, SCHEMA_H, SCHEMA_W } from '../model/geometry';
import { STEP_H, STEP_W } from './geometry';
import { occupied, rectAt } from './occupied';
import { overlaps, pushAside } from './overlap';

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

const SCHEMA_BELOW = 140;
const CARD = { schema: { w: SCHEMA_W, h: SCHEMA_H }, processor: { w: PROCESSOR_W, h: PROCESSOR_H } };

/**
 * Gives every schema and every stepless processor without a location one. A processor card goes 140 px below everything
 * placed, stacking 40 px apart; a schema goes 140 px below its first holder (steps first, then processor cards, by id) at
 * the nearest free spot; one with no placed holder goes in a column 320 px right of everything, stacking 40 px apart.
 */
export function placeSchemas(b: BoardState): BoardState {
  const stepless = steplessProcessors(b);
  const procs = stepless.filter((id) => b.processors[id]!.at === null);
  const schemas = Object.keys(b.schemas).sort().filter((id) => b.schemas[id]!.at === null);
  if (procs.length === 0 && schemas.length === 0) return b;

  const placed = new Map<string, Rect>();
  for (const w of Object.values(b.workflows)) if (w.at) placed.set(`workflow:${w.id}`, { ...w.at, ...TRIANGLE });
  for (const s of Object.values(b.steps)) if (s.at) placed.set(`step:${s.id}`, { ...s.at, ...STEP });
  for (const c of Object.values(b.caches)) if (c.at) placed.set(`cache:${c.id}`, { ...c.at, ...CACHE });
  for (const s of Object.values(b.schemas)) if (s.at) placed.set(`schema:${s.id}`, { ...s.at, ...CARD.schema });
  for (const id of stepless) { const p = b.processors[id]!; if (p.at) placed.set(`processor:${id}`, { ...p.at, ...CARD.processor }); }
  const rects = () => [...placed.values()];

  const processorAt: Record<Id, Point> = {};
  const schemaAt: Record<Id, Point> = {};

  if (procs.length > 0) {
    const all = rects();
    const x = all.length ? Math.min(...all.map((r) => r.x)) : 0;
    let y = (all.length ? Math.max(...all.map((r) => r.y + r.h)) : -SCHEMA_BELOW) + SCHEMA_BELOW;
    for (const id of procs) {
      processorAt[id] = { x, y };
      placed.set(`processor:${id}`, { x, y, ...CARD.processor });
      y += PROCESSOR_H + COLUMN_STEP;
    }
  }

  const holders = new Map<Id, Point>(); // a schema's first placed holder
  for (const ref of schemaRefs(b)) {
    if (holders.has(ref.schemaId)) continue;
    const at = ref.owner.kind === 'step' ? b.steps[ref.owner.id]?.at : processorAt[ref.owner.id] ?? b.processors[ref.owner.id]?.at;
    if (at) holders.set(ref.schemaId, at);
  }

  let column: Point | null = null;
  for (const id of schemas) {
    const holder = holders.get(id);
    let want: Point;
    if (holder) want = { x: holder.x, y: holder.y + SCHEMA_BELOW };
    else {
      if (!column) {
        const all = rects();
        const right = all.length ? Math.max(...all.map((r) => r.x + r.w)) : -COLUMN_GAP;
        column = { x: right + COLUMN_GAP, y: all.length ? Math.min(...all.map((r) => r.y)) : 0 };
      }
      want = column;
      column = { x: column.x, y: column.y + SCHEMA_H + COLUMN_STEP };
    }
    const d = freeOffset([{ ...want, ...CARD.schema }], rects(), { x: 0, y: 0 });
    schemaAt[id] = { x: want.x + d.x, y: want.y + d.y };
    placed.set(`schema:${id}`, { ...schemaAt[id]!, ...CARD.schema });
  }

  return {
    ...b,
    schemas: Object.fromEntries(Object.entries(b.schemas).map(([id, s]) => [id, schemaAt[id] ? { ...s, at: schemaAt[id]! } : s])),
    processors: Object.fromEntries(Object.entries(b.processors).map(([id, p]) => [id, processorAt[id] ? { ...p, at: processorAt[id]! } : p])),
  };
}

/**
 * Turning schemas mode on [user, 2026-11-26]: places what has no location (`placeSchemas`), then moves each schema and
 * stepless processor that lies over another card or block aside (`pushAside`), in `schemaRefs` order then orphans by id.
 * Steps, caches and triangles stay where they are.
 */
export function settleSchemas(b: BoardState, ghosts: readonly GhostItem[]): BoardState {
  let cur = placeSchemas(b);
  const order: { kind: 'schema' | 'processor'; id: Id }[] = [];
  const seen = new Set<string>();
  const push = (kind: 'schema' | 'processor', id: Id) => { if (!seen.has(`${kind}:${id}`)) { seen.add(`${kind}:${id}`); order.push({ kind, id }); } };
  for (const ref of schemaRefs(cur)) {
    if (ref.owner.kind === 'processor') push('processor', ref.owner.id);
    push('schema', ref.schemaId);
  }
  for (const id of Object.keys(cur.schemas).sort()) push('schema', id);
  for (const { kind, id } of order) {
    const row = kind === 'schema' ? cur.schemas[id] : cur.processors[id];
    if (!row?.at) continue;
    const mine = rectAt(kind, row.at);
    const others = occupied(cur, ghosts, new Set([`${kind}:${id}`]), true);
    if (!others.some((o) => overlaps(mine, o))) continue;
    const d = pushAside([mine], others);
    if (d.x === 0 && d.y === 0) continue;
    cur = moveItems(cur, [{ ref: { kind, id }, at: { x: row.at.x + d.x, y: row.at.y + d.y } }]);
  }
  return cur;
}

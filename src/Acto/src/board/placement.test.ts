import { describe, expect, it } from 'vitest';
import { board as fixture } from '../design/boardFixtures';
import type { BoardState } from '../design/board';
import { STEP_H, STEP_W } from './geometry';
import { overlaps } from './overlap';
import { placeMissing, placeSchemas, settleSchemas } from './placement';

/** The fixture with its cards moved well apart, so only the rule under test decides a position. */
const board = (): BoardState => {
  const b = fixture();
  b.workflows.hourly!.at = { x: 0, y: -1000 };
  b.caches.c1!.at = { x: 0, y: 1000 };
  b.steps.lonely!.at = { x: 600, y: 1000 };
  return b;
};

const clear = (b: BoardState, ...ids: string[]): BoardState => {
  const out = structuredClone(b) as BoardState;
  for (const id of ids) {
    for (const t of ['workflows', 'steps', 'caches'] as const) {
      const r = out[t][id] as { at: unknown } | undefined;
      if (r) r.at = null;
    }
  }
  return out;
};

describe('placeMissing', () => {
  it('places a triangle 160 px left of its first entry step', () => {
    const r = placeMissing(clear(board(), 'daily'));
    expect(r.workflows.daily!.at).toEqual({ x: 200 - 160, y: 200 });
  });

  it('leaves placed items alone and returns the same board when nothing is missing', () => {
    const b = board();
    expect(placeMissing(b)).toBe(b);
    const r = placeMissing(clear(b, 'daily'));
    expect(r.steps).toEqual(b.steps);
    expect(r.workflows.hourly).toEqual(b.workflows.hourly);
    expect(r.caches).toEqual(b.caches);
  });

  it('puts a step 280 px right of its first wired-in source', () => {
    const r = placeMissing(clear(board(), 'expand'));
    expect(r.steps.expand!.at).toEqual({ x: 200 + 280, y: 200 });
  });

  it('puts a cache 120 px below its first linking triangle', () => {
    const r = placeMissing(clear(board(), 'c1'));
    expect(r.caches.c1!.at).toEqual({ x: 0, y: 120 });
  });

  it('places an unconnected step in a column 320 px right of everything placed', () => {
    const r = placeMissing(clear(board(), 'lonely'));
    // rightmost placed card: expand at 400 (+ STEP_W)
    expect(r.steps.lonely!.at!.x).toBe(400 + STEP_W + 320);
  });

  it('keeps an orphan with nothing placed at all on the board', () => {
    const b = clear(board(), 'daily', 'hourly', 'fetch', 'expand', 'lonely', 'c1');
    const r = placeMissing(b);
    const all = [...Object.values(r.workflows), ...Object.values(r.steps), ...Object.values(r.caches)];
    expect(all.every((x) => x.at !== null)).toBe(true);
  });

  it('never overlaps two step cards', () => {
    const b = clear(board(), 'expand', 'lonely');
    b.steps.fetch!.nextStepIds = ['expand', 'lonely'];
    const r = placeMissing(b);
    const steps = Object.values(r.steps).map((s) => s.at!);
    for (let i = 0; i < steps.length; i++) {
      for (let j = i + 1; j < steps.length; j++) {
        const a = steps[i]!, c = steps[j]!;
        const apart = a.x + STEP_W <= c.x || c.x + STEP_W <= a.x || a.y + STEP_H <= c.y || c.y + STEP_H <= a.y;
        expect(apart).toBe(true);
      }
    }
  });
});

describe('placeSchemas / settleSchemas', () => {
  const sch = (id: string, b: BoardState) => ({ id, name: id, version: '1', description: null, definition: '{}', audit: b.processors.p1!.audit, at: null, updatedAt: null });
  it('an unplaced wired schema lands 140px below its first step; an unplaced orphan lands in the column right of everything; a stepless processor lands below everything', () => {
    const b0 = board();
    const b: BoardState = {
      ...b0,
      schemas: { s1: sch('s1', b0), o1: sch('o1', b0), o2: sch('o2', b0), s2: sch('s2', b0) },
      processors: {
        p1: { ...b0.processors.p1!, inputSchemaId: 's1' },
        p2: { ...b0.processors.p1!, id: 'p2', inputSchemaId: 's2' },
        p3: { ...b0.processors.p1!, id: 'p3', inputSchemaId: 's2' },
      },
    };
    const r = placeSchemas(b);
    // the first holder by id is step 'expand' (x 400, y 200)
    expect(r.schemas.s1!.at).toEqual({ x: 400, y: 340 });
    // right edge is lonely (600 + 210); the column is 320 beyond it, from the topmost placed top
    const top = Math.min(b0.workflows.daily!.at!.y, b0.workflows.hourly!.at!.y, b0.caches.c1!.at!.y);
    expect(r.schemas.o1!.at).toEqual({ x: 810 + 320, y: top });
    expect(r.schemas.o2!.at).toEqual({ x: 810 + 320, y: top + 52 + 40 });
    // stepless processors: 140 below everything placed (bottom 1092, the lonely step), stacked 40 apart
    expect(r.processors.p2!.at).toEqual({ x: 0, y: 1092 + 140 });
    expect(r.processors.p3!.at).toEqual({ x: 0, y: 1092 + 140 + 64 + 40 });
    expect(placeSchemas(r)).toBe(r);
  });
  it('settleSchemas pushes a schema that overlaps a step aside and leaves steps where they are', () => {
    const b0 = board();
    const b: BoardState = {
      ...b0,
      schemas: { s1: { ...sch('s1', b0), at: { x: 210, y: 210 } } },
      processors: { p1: { ...b0.processors.p1!, inputSchemaId: 's1' } },
    };
    const r = settleSchemas(b, []);
    const at = r.schemas.s1!.at!;
    expect(at).not.toEqual({ x: 210, y: 210 });
    for (const s of Object.values(r.steps)) expect(overlaps({ ...at, w: 190, h: 52 }, { ...s.at!, w: STEP_W, h: STEP_H })).toBe(false);
    expect(r.steps).toEqual(b.steps);
  });
});

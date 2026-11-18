import { describe, expect, it } from 'vitest';
import { board as fixture } from '../design/boardFixtures';
import type { BoardState } from '../design/board';
import { STEP_H, STEP_W } from './geometry';
import { placeMissing } from './placement';

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

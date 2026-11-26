import { describe, expect, it } from 'vitest';
import { board, schemaBoard } from '../design/boardFixtures';
import { focusBounds, itemBounds } from './focus';
import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_W } from './geometry';

describe('focusBounds', () => {
  const b = board(); // daily at (0,0); fetch (200,200), expand (400,200); lonely (600,200)
  it('is the triangle and the steps it reaches when no steps are named', () => {
    expect(focusBounds(b, 'daily')).toEqual({ x: 0, y: 0, w: 400 + STEP_W, h: 200 + STEP_H });
  });
  it('is the box around the named steps', () => {
    expect(focusBounds(b, 'daily', ['fetch', 'expand'])).toEqual({ x: 200, y: 200, w: 200 + STEP_W, h: STEP_H });
  });
  it('steps that are not there are skipped; none left is the triangle and its reach', () => {
    expect(focusBounds(b, 'daily', ['expand', 'gone'])).toEqual({ x: 400, y: 200, w: STEP_W, h: STEP_H });
    expect(focusBounds(b, 'daily', ['gone'])).toEqual(focusBounds(b, 'daily'));
  });
  it('is the triangle alone for a workflow that reaches nothing, and null for one not on the board', () => {
    const empty = { ...b, workflows: { ...b.workflows, daily: { ...b.workflows.daily, entryStepIds: [] } } };
    expect(focusBounds(empty, 'daily')).toEqual({ x: 0, y: 0, w: TRIANGLE_W, h: 104 });
    expect(focusBounds(b, 'ghost')).toBeNull();
  });
});

describe('itemBounds', () => {
  const b = board();
  it('is the step box, the cache box; null for an id not on the board', () => {
    expect(itemBounds(b, { kind: 'step', id: 'expand' })).toEqual({ x: 400, y: 200, w: STEP_W, h: STEP_H });
    expect(itemBounds(b, { kind: 'cache', id: 'c1' })).toEqual({ x: 0, y: -100, w: CACHE_W, h: CACHE_H });
    expect(itemBounds(b, { kind: 'step', id: 'nope' })).toBeNull();
  });
  it('is the schema and processor card boxes; null for a card with no place', () => {
    const s = schemaBoard();
    expect(itemBounds(s, { kind: 'schema', id: 'sx' })).toEqual({ x: 200, y: 400, w: 190, h: 52 });
    expect(itemBounds(s, { kind: 'processor', id: 'p2' })).toEqual({ x: 900, y: 500, w: 210, h: 64 });
    expect(itemBounds(s, { kind: 'processor', id: 'p1' })).toBeNull();
  });
});

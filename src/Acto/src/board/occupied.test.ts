import { describe, expect, it } from 'vitest';
import { board } from '../design/boardFixtures';
import type { GhostItem } from '../design/ghosts';
import { STEP_H, STEP_W } from './geometry';
import type { BoardState } from '../design/board';
import { nudgeBlocked, occupied, rectAt } from './occupied';

describe('occupied [user, 2026-11-25]', () => {
  it('holds every placed triangle, step and cache, in the board\'s sizes', () => {
    const b = board();
    const boxes = occupied(b, []);
    expect(boxes).toHaveLength(Object.keys(b.workflows).length + Object.keys(b.steps).length + Object.keys(b.caches).length);
    expect(boxes).toContainEqual({ ...b.steps.fetch!.at!, w: STEP_W, h: STEP_H });
  });

  it('leaves out what is excepted, and counts a ghost unless its item is back on the board', () => {
    const b = board();
    const gone: GhostItem = { key: 'step:gone', kind: 'step', row: { ...b.steps.lonely!, id: 'gone', at: { x: 5000, y: 5000 } } };
    const back: GhostItem = { key: 'step:fetch', kind: 'step', row: { ...b.steps.fetch!, at: { x: 7000, y: 7000 } } };
    const boxes = occupied(b, [gone, back], new Set(['step:lonely']));
    expect(boxes).toContainEqual(rectAt('step', { x: 5000, y: 5000 }));
    expect(boxes).not.toContainEqual(rectAt('step', { x: 7000, y: 7000 }));
    expect(boxes).not.toContainEqual(rectAt('step', b.steps.lonely!.at!));
  });

  it('withSchemas adds placed schemas and stepless processors; without it nothing changes', () => {
    const b = board();
    const sch = (id: string, at: { x: number; y: number } | null) => ({ id, name: id, version: '1', description: null, definition: '{}', audit: b.processors.p1!.audit, at, updatedAt: null });
    const withS: BoardState = {
      ...b,
      schemas: { s1: sch('s1', { x: 3000, y: 3000 }), s2: sch('s2', null) },
      processors: { ...b.processors, p9: { ...b.processors.p1!, id: 'p9', outputSchemaId: 's1', at: { x: 4000, y: 4000 } } },
    };
    expect(occupied(withS, [])).toEqual(occupied(b, []));
    const boxes = occupied(withS, [], new Set(), true);
    expect(boxes).toHaveLength(occupied(b, []).length + 2);
    expect(boxes).toContainEqual(rectAt('schema', { x: 3000, y: 3000 }));
    expect(boxes).toContainEqual(rectAt('processor', { x: 4000, y: 4000 }));
    expect(occupied(withS, [], new Set(['schema:s1', 'processor:p9']), true)).toEqual(occupied(b, []));
  });

  it('withSchemas counts a schema ghost whose schema is gone; without it, never', () => {
    const b = board();
    const g: GhostItem = { key: 'schema:gone', kind: 'schema', row: { id: 'gone', name: 'gone', version: '1', description: null, audit: b.processors.p1!.audit, at: { x: 5000, y: 5000 }, updatedAt: null } };
    expect(occupied(b, [g], new Set(), true)).toContainEqual(rectAt('schema', { x: 5000, y: 5000 }));
    expect(occupied(b, [g])).not.toContainEqual(rectAt('schema', { x: 5000, y: 5000 }));
  });
  it('blocks a nudge onto another item, not one that only comes near it', () => {
    const other = rectAt('step', { x: 300, y: 0 });
    expect(nudgeBlocked([rectAt('step', { x: 100, y: 0 })], [other])).toBe(true);
    expect(nudgeBlocked([rectAt('step', { x: 300 - STEP_W - 4, y: 0 })], [other])).toBe(false);
  });
});

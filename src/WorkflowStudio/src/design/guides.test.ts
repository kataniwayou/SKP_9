import { describe, expect, it } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { guideBoxes, snapToGuides } from './guides';

const step = (id: string, x: number, y: number) => ({ id, x, y, w: 224, h: 160, mid: y + 96 });

describe('alignment guides (Visio dynamic grid, plan 10)', () => {
  it('snaps an edge 8 and 12 px off within a 12 px reach, and draws the line', () => {
    const g = snapToGuides(step('a', 8, 400), [step('b', 0, 0)], 12);
    expect([g.dx, g.dy]).toEqual([-8, 0]);
    expect(g.hit.x).toBe(true);
    expect(g.lines).toContainEqual({ x1: 0, y1: 0, x2: 0, y2: 560 });
    expect(snapToGuides(step('a', 12, 400), [step('b', 0, 0)], 12).dx).toBe(-12);
  });

  it('does nothing 16 px off with a 12 px reach', () => {
    expect(snapToGuides(step('a', 16, 400), [step('b', 0, 0)], 12)).toEqual({ dx: 0, dy: 0, hit: { x: false, y: false }, lines: [], gaps: [] });
  });

  it('matches an unrounded position (5 flow px is 10 screen px at 200%)', () => {
    const g = snapToGuides(step('a', 5, 400), [step('b', 0, 0)], 6);
    expect(g.dx).toBe(-5);
    expect(g.hit.x).toBe(true);
  });

  it('lines up processor middles, so a wire between them runs straight', () => {
    const g = snapToGuides(step('a', 400, 8), [step('b', 0, 0)], 12);
    expect(g.dy).toBe(-8);
    expect(g.lines).toContainEqual({ x1: 0, y1: 96, x2: 624, y2: 96 });
  });

  it('draws one line per matching coordinate, to the nearest matching block only', () => {
    const g = snapToGuides(step('m', 1000, 4), [step('far', 0, 0), step('near', 600, 0)], 12);
    expect(g.dy).toBe(-4);
    const tops = g.lines.filter((l) => l.y1 === 0 && l.y2 === 0);
    expect(tops).toEqual([{ x1: 600, y1: 0, x2: 1224, y2: 0 }]);
  });

  it('boxes every block of a document, with a processor middle on steps only', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const boxes = guideBoxes(doc);
    const s1 = doc.placement.steps.get('s1')!;
    expect(boxes.find((b) => b.id === 's1')).toEqual({ id: 's1', x: s1.x, y: s1.y, w: 224, h: 160, mid: s1.y + 96 });
    expect(boxes.find((b) => b.id === 'wf')?.mid).toBeUndefined();
  });
});

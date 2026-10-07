import { describe, expect, it } from 'vitest';
import { graphDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { guideBoxes, snapToGuides } from './guides';

const step = (id: string, x: number, y: number) => ({ id, x, y, w: 224, h: 160, mid: y + 96 });

describe('alignment guides', () => {
  it('snaps an edge lined up within one grid step, and draws the line', () => {
    const g = snapToGuides(step('a', 8, 400), [step('b', 0, 0)]);
    expect([g.dx, g.dy]).toEqual([-8, 0]);
    expect(g.lines).toContainEqual({ x1: 0, y1: 0, x2: 0, y2: 560 });
  });

  it('lines up processor middles, so a wire between them runs straight', () => {
    const g = snapToGuides(step('a', 400, 8), [step('b', 0, 0)]);
    expect(g.dy).toBe(-8);
    expect(g.lines).toContainEqual({ x1: 0, y1: 96, x2: 624, y2: 96 });
  });

  it('does nothing two grid steps away', () => {
    expect(snapToGuides(step('a', 16, 400), [step('b', 0, 0)])).toEqual({ dx: 0, dy: 0, lines: [] });
  });

  it('boxes every block of a document, with a processor middle on steps only', async () => {
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1')] }));
    const boxes = guideBoxes(doc);
    const s1 = doc.placement.steps.get('s1')!;
    expect(boxes.find((b) => b.id === 's1')).toEqual({ id: 's1', x: s1.x, y: s1.y, w: 224, h: 160, mid: s1.y + 96 });
    expect(boxes.find((b) => b.id === 'wf')?.mid).toBeUndefined();
  });
});

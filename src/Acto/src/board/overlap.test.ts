import { describe, expect, it } from 'vitest';
import { covered, DROP_GAP, overlaps, pushAside } from './overlap';

describe('pushAside [user, 2026-11-25, option B]', () => {
  const card = (x: number, y: number) => ({ x, y, w: 210, h: 80 });

  it('leaves a drop that touches nothing where it was let go', () => {
    expect(pushAside([card(0, 0)], [card(400, 0)])).toEqual({ x: 0, y: 0 });
    // near but not on: inside the gap is left alone
    expect(pushAside([card(0, 0)], [card(210 + DROP_GAP / 2, 0)])).toEqual({ x: 0, y: 0 });
  });

  it('moves a drop on another item by the smallest offset that clears it by the gap', () => {
    const d = pushAside([card(0, 0)], [card(20, 10)]);
    const landed = { ...card(0, 0), x: d.x, y: d.y };
    expect(overlaps(landed, card(20, 10), DROP_GAP)).toBe(false);
    // nearest: a vertical slide (80 + gap) beats a horizontal one (210 + gap)
    expect(Math.abs(d.y)).toBeLessThan(140);
  });

  it('clears every other item, not only the one it landed on', () => {
    const others = [card(0, 0), card(0, 100), card(0, -100)];
    const d = pushAside([card(0, 0)], others);
    for (const o of others) expect(overlaps({ ...card(0, 0), x: d.x, y: d.y }, o, DROP_GAP)).toBe(false);
  });

  it('moves a group as one', () => {
    const group = [card(0, 0), card(0, 100)];
    const d = pushAside(group, [card(10, 50)]);
    for (const g of group) expect(overlaps({ ...g, x: g.x + d.x, y: g.y + d.y }, card(10, 50), DROP_GAP)).toBe(false);
  });

  it('names what the dragged items lie over', () => {
    const others = [{ id: 'a', box: card(0, 0) }, { id: 'b', box: card(500, 0) }];
    expect(covered([card(100, 20)], others).map((o) => o.id)).toEqual(['a']);
  });
});

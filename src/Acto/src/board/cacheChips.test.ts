import { describe, expect, it } from 'vitest';
import { CHIP_GAP, CHIP_W, cacheChipAt } from './cacheChips';

describe('cacheChipAt', () => {
  it('lays chips in a row along the frame bottom inside the padding', () => {
    const f = { x: 0, y: 0, w: 420, h: 200 };
    expect(cacheChipAt(0, f)).toEqual({ x: 28, y: 98 });
    expect(cacheChipAt(2, f)).toEqual({ x: 28 + 2 * (CHIP_W + CHIP_GAP), y: 98 });
  });
});

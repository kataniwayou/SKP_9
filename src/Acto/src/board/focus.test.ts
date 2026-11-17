import { describe, expect, it } from 'vitest';
import { focusBounds } from './focus';
import { HEADER_H, STEP_H, STEP_W } from './geometry';

const frame = { x: 100, y: 200, w: 800, h: 500 };
const stepAt = new Map([['a', { x: 28, y: 28 }], ['b', { x: 400, y: 128 }]]);

describe('focusBounds', () => {
  it('is the frame when no steps are named', () => {
    expect(focusBounds(frame, stepAt)).toEqual(frame);
    expect(focusBounds(frame, stepAt, [])).toEqual(frame);
  });

  it('is the box around the named steps, on the board (frame offset and header included)', () => {
    expect(focusBounds(frame, stepAt, ['a', 'b'])).toEqual({
      x: 100 + 28, y: 200 + HEADER_H + 28, w: 400 + STEP_W - 28, h: 128 + STEP_H - 28,
    });
  });

  it('steps that are not there are skipped; none left is the frame', () => {
    expect(focusBounds(frame, stepAt, ['a', 'gone'])).toEqual({ x: 128, y: 200 + HEADER_H + 28, w: STEP_W, h: STEP_H });
    expect(focusBounds(frame, stepAt, ['gone'])).toEqual(frame);
  });
});

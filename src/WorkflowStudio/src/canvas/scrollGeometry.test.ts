import { describe, expect, it } from 'vitest';
import { axisOf, thumbOf, SCROLL_PAD } from './scrollGeometry';

describe('axisOf', () => {
  it('needs no bar when the drawing and its margin fit in view', () => {
    expect(axisOf(100, 700, 800)).toBeNull();
  });

  it('spans from the drawing start to the view end when the drawing starts before the view', () => {
    // drawing from -500 to 600 on screen, view 0..800: the scroll range is -500-pad .. 800
    const a = axisOf(-500, 600, 800)!;
    expect(a).toEqual({ size: 800, full: 800 + 500 + SCROLL_PAD, pos: 500 + SCROLL_PAD });
  });

  it('spans the whole drawing when it is larger than the view on both sides', () => {
    const a = axisOf(-300, 1500, 800)!;
    expect(a.full).toBe(1800 + 2 * SCROLL_PAD);
    expect(a.pos).toBe(300 + SCROLL_PAD);
  });

  it('includes the view when the user has panned past the drawing', () => {
    const a = axisOf(900, 2000, 800)!;   // the drawing lies entirely to the right of the view
    expect(a.pos).toBe(0);
    expect(a.full).toBe(2000 + SCROLL_PAD);
  });
});

describe('thumbOf', () => {
  it('is as long as the visible share of the track, and sits at the scrolled share', () => {
    expect(thumbOf({ size: 500, full: 1000, pos: 250 }, 400)).toEqual({ len: 200, at: 100 });
  });

  it('is never shorter than 32 px', () => {
    expect(thumbOf({ size: 10, full: 10_000, pos: 0 }, 400).len).toBe(32);
  });

  it('reaches the track end when scrolled to the end', () => {
    const t = thumbOf({ size: 500, full: 1000, pos: 500 }, 400);
    expect(t.at + t.len).toBe(400);
  });
});

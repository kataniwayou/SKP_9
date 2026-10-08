import { describe, expect, it } from 'vitest';
import { simplify, type Pt } from './router';
import { pointsOfShape } from './shape';
import { coreFrom, endMoved, movedEndShape, translatePoints } from './wireMove';

describe('a wire moved whole', () => {
  it('shifts every point by the same amount: the same shape, somewhere else', () => {
    const pts: Pt[] = [[512, 168], [552, 168], [552, 352], [576, 352]];
    expect(translatePoints(pts, -40, 56)).toEqual([[472, 224], [512, 224], [512, 408], [536, 408]]);
    expect(translatePoints(pts, 0, 0)).toEqual(pts);
  });
});

describe('an end dragged with one corner (an L)', () => {
  const flat: Pt[] = [[800, 352], [864, 352]];

  it('a horizontal last run dragged down keeps its axis to the pointer\'s x, then one vertical leg goes to the pointer', () => {
    expect(endMoved(flat, 'head', { x: 864, y: 432 })).toEqual([[800, 352], [864, 352], [864, 432]]);
    // dragged down and to the side: the run is lengthened to the pointer's x, still one corner
    expect(endMoved(flat, 'head', { x: 912, y: 432 })).toEqual([[800, 352], [912, 352], [912, 432]]);
  });

  it('a vertical last run (once an L was made) dragged sideways gets a horizontal leg', () => {
    const l: Pt[] = [[800, 352], [864, 352], [864, 432]];
    expect(endMoved(l, 'head', { x: 944, y: 432 })).toEqual([[800, 352], [864, 352], [864, 432], [944, 432]]);
    expect(endMoved(l, 'head', { x: 944, y: 480 })).toEqual([[800, 352], [864, 352], [864, 480], [944, 480]]);
  });

  it('dragged along its own axis, the last run is only lengthened or shortened: no corner', () => {
    expect(endMoved(flat, 'head', { x: 960, y: 352 })).toEqual([[800, 352], [960, 352]]);
    const bent: Pt[] = [[512, 168], [552, 168], [552, 352], [576, 352]];
    expect(endMoved(bent, 'head', { x: 640, y: 352 })).toEqual([[512, 168], [552, 168], [552, 352], [640, 352]]);
  });

  it('the tail is the mirror image: its first run keeps its axis to the pointer, then one leg to the pointer', () => {
    expect(endMoved(flat, 'tail', { x: 800, y: 432 })).toEqual([[800, 432], [800, 352], [864, 352]]);
    const l: Pt[] = [[800, 432], [800, 352], [864, 352]];
    expect(endMoved(l, 'tail', { x: 720, y: 432 })).toEqual([[720, 432], [800, 432], [800, 352], [864, 352]]);
  });

  it('a run of no length at the dragged end is skipped: the run before it decides the axis', () => {
    expect(endMoved([[800, 352], [864, 352], [864, 352]], 'head', { x: 864, y: 432 })).toEqual([[800, 352], [864, 352], [864, 432]]);
  });
});

describe('the core of a moved end', () => {
  it('starts at the fixed end\'s core start, dropping a lead before it (a tail on the hub\'s left half)', () => {
    // ring point, down out of the hub's square, then right to where the core starts (264, 400)
    const full: Pt[] = [[128, 352], [128, 400], [400, 400], [400, 480]];
    expect(coreFrom(full, [264, 400])).toEqual([[264, 400], [400, 400], [400, 480]]);
    // a start that is the first point keeps the whole path
    expect(coreFrom(full, [128, 352])).toEqual(full);
  });

  it('gives bends that draw the L again from the fixed end\'s core to the moved end, for either side', () => {
    const pts: Pt[] = [[128, 352], [128, 400], [400, 400], [400, 480], [576, 480]];
    const head = movedEndShape(pts, 'head', { x: 640, y: 560 }, [264, 400]);
    expect(head.points).toEqual([[128, 352], [128, 400], [400, 400], [400, 480], [640, 480], [640, 560]]);
    expect(simplify(pointsOfShape({ sx: 264, sy: 400, tx: 640, ty: 560 }, head.bends))).toEqual([[264, 400], [400, 400], [400, 480], [640, 480], [640, 560]]);

    const flat: Pt[] = [[800, 352], [864, 352]];
    const tail = movedEndShape(flat, 'tail', { x: 800, y: 432 }, [864, 352]);
    expect(tail.points).toEqual([[800, 432], [800, 352], [864, 352]]);
    expect(simplify(pointsOfShape({ sx: 800, sy: 432, tx: 864, ty: 352 }, tail.bends))).toEqual(tail.points);
  });
});

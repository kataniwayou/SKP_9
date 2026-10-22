import { describe, expect, it } from 'vitest';
import { jumpsOf } from './jumps';

describe("line jumps at crossings (plan 10 phase 3, spec §4.2: Visio's arc on the horizontal wire)", () => {
  it('puts a jump on the level run where an upright run of another wire crosses it', () => {
    const j = jumpsOf([
      { id: 'h', points: [[0, 100], [400, 100]] },
      { id: 'v', points: [[200, 0], [200, 300]] },
    ]);
    expect(j.get('h')).toEqual([[200, 100]]);
    expect(j.has('v')).toBe(false);
  });

  it('none where the crossing is at either run\'s end (a junction, a bend, an end)', () => {
    const j = jumpsOf([
      { id: 'h', points: [[0, 100], [400, 100]] },
      { id: 'tee', points: [[200, 100], [200, 300]] },
      { id: 'near', points: [[4, 0], [4, 300]] },
    ]);
    expect(j.has('h')).toBe(false);
  });

  it('none where wires only lie along each other or meet end to end, and none on a wire crossing itself', () => {
    const j = jumpsOf([
      { id: 'a', points: [[0, 100], [400, 100]] },
      { id: 'b', points: [[200, 100], [600, 100]] },
      { id: 'self', points: [[0, 500], [400, 500], [400, 600], [200, 600], [200, 400]] },
    ]);
    expect(j.size).toBe(0);
  });

  it('several crossings on one run, in order along it', () => {
    const j = jumpsOf([
      { id: 'h', points: [[400, 100], [0, 100]] },
      { id: 'v1', points: [[100, 0], [100, 300]] },
      { id: 'v2', points: [[300, 300], [300, 0]] },
    ]);
    expect(j.get('h')).toEqual([[300, 100], [100, 100]]);
  });

  it("keeps every crossing, those nearer than a jump too: the path draws them as one arc (phase 3's deferred list)", () => {
    const j = jumpsOf([
      { id: 'h', points: [[0, 100], [400, 100]] },
      { id: 'v1', points: [[200, 0], [200, 300]] },
      { id: 'v2', points: [[208, 0], [208, 300]] },
    ]);
    expect(j.get('h')).toEqual([[200, 100], [208, 100]]);
  });
});

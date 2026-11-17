import { describe, expect, it } from 'vitest';
import { bw } from './fixtures';
import { toFlow } from './toFlow';

describe('toFlow', () => {
  it('nests steps in their frame and gives shared steps one node per frame', () => {
    const { nodes } = toFlow([bw('w1', ['a', 's']), bw('w2', ['s'])]);
    expect(nodes.filter((n) => n.type === 'step').map((n) => [n.id, n.parentId])).toEqual([
      ['st:w1:a', 'wf:w1'], ['st:w1:s', 'wf:w1'], ['st:w2:s', 'wf:w2']]);
  });
  it('makes one coloured edge per wire', () => {
    const { edges } = toFlow([bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 4 }])]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.data).toMatchObject({ condition: 4 });
  });
  it('keeps one wire when a workflow lists the same wire twice', () => {
    const w = { id: 'a>b', from: 'a', to: 'b', condition: 4 };
    expect(toFlow([bw('w1', ['a', 'b'], [w, w])]).edges).toHaveLength(1);
  });
  it('offsets steps below the header and lands wires in board coordinates', () => {
    const { nodes, edges } = toFlow([bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }])]);
    expect(nodes.find((n) => n.id === 'st:w1:a')!.position.y).toBeGreaterThanOrEqual(46);
    const d = edges[0]!.data as { out: { x: number }; in: { x: number } };
    expect(d.in.x).toBeGreaterThan(d.out.x);
  });
  it('gives an empty workflow a frame at the minimum size', () => {
    const frame = toFlow([bw('w2', [])]).nodes.find((n) => n.id === 'wf:w2')!;
    expect(frame.style).toMatchObject({ width: 420, height: 196 });
  });
});

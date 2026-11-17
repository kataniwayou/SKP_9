import { describe, expect, it } from 'vitest';
import { bw } from './fixtures';
import { HEADER_H, STEP_H, STEP_W } from './geometry';
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
  it('places steps relative to a frame at (1000, 500) and lands wires in board coordinates', () => {
    const w = bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 1 }], { x: 1000, y: 500 });
    const a = w.stepAt.get('a')!;
    const b = w.stepAt.get('b')!;
    const { nodes, edges } = toFlow([w]);
    expect(nodes.find((n) => n.id === 'wf:w1')!.position).toEqual({ x: 1000, y: 500 });
    expect(nodes.find((n) => n.id === 'st:w1:a')!.position).toEqual({ x: a.x, y: a.y + HEADER_H });
    expect(nodes.find((n) => n.id === 'st:w1:b')!.position).toEqual({ x: b.x, y: b.y + HEADER_H });
    expect(edges[0]!.data).toMatchObject({
      out: { x: 1000 + a.x + STEP_W, y: 500 + HEADER_H + a.y + STEP_H / 2 },
      in: { x: 1000 + b.x, y: 500 + HEADER_H + b.y + STEP_H / 2 },
    });
  });
  it('keeps a step below the header: its extent starts at the content origin', () => {
    const w = bw('w1', ['a']);
    const step = toFlow([w]).nodes.find((n) => n.id === 'st:w1:a')!;
    expect(step.extent).toEqual([[0, HEADER_H], [w.frame.w, w.frame.h]]);
  });
  it('gives an empty workflow a frame at the minimum size', () => {
    const frame = toFlow([bw('w2', [])]).nodes.find((n) => n.id === 'wf:w2')!;
    expect(frame.style).toMatchObject({ width: 420, height: 196 });
  });
});

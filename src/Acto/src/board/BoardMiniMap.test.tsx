import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const setCenter = vi.fn();
vi.mock('@xyflow/react', async (orig) => {
  const m = await orig<typeof import('@xyflow/react')>();
  return { ...m, useReactFlow: () => ({ ...m.useReactFlow(), setCenter }) };
});

import { Board } from './Board';
import { bw } from './fixtures';

const frames = () => [...document.querySelectorAll('.react-flow__minimap [data-mini-frame]')] as SVGElement[];

describe('Board minimap', () => {
  it('draws each frame with its name and only frames', async () => {
    render(<Board workflows={[bw('w1', ['a']), bw('w2', [], [], { x: 700, y: 0 })]} picks={[]} onPick={() => {}} />);
    await vi.waitFor(() => expect(frames()).toHaveLength(2));
    expect(frames().map((f) => f.querySelector('text')?.textContent)).toEqual(['w1-name', 'w2-name']);
    expect(document.querySelectorAll('.react-flow__minimap-node')).toHaveLength(0);
  });

  it('outlines a picked frame in the accent colour and the others by state', async () => {
    render(<Board workflows={[bw('w1', ['a']), bw('w2', [], [], { x: 700, y: 0 })]}
      picks={[{ kind: 'workflow', workflowId: 'w1' }]} onPick={() => {}} />);
    await vi.waitFor(() => expect(frames()).toHaveLength(2));
    // the theme's accent token, not a fixed pink; the others by their run state's token
    const stroke = (i: number) => (frames()[i]!.querySelector('rect') as SVGRectElement).style.stroke;
    expect(stroke(0)).toBe('var(--accent)');
    expect(stroke(1)).toMatch(/^var\(--st-/);
  });

  it('writes a frame name in the band above its steps, never over the step blocks', async () => {
    render(<Board workflows={[bw('w1', ['a', 'b']), bw('w2', [], [], { x: 700, y: 0 })]} picks={[]} onPick={() => {}} />);
    await vi.waitFor(() => expect(document.querySelectorAll('.react-flow__minimap [data-mini-step]').length).toBe(2));
    const text = frames()[0]!.querySelector('text')!;
    expect(text.textContent).toBe('w1-name');
    const bottom = Number(text.getAttribute('y')) + 0.22 * Number(text.getAttribute('font-size'));
    const tops = [...document.querySelectorAll('.react-flow__minimap [data-mini-step]')].map((r) => Number(r.getAttribute('y')));
    expect(bottom).toBeLessThanOrEqual(Math.min(...tops));
  });

  it('centres the board on a clicked frame at the current zoom', async () => {
    const w = bw('w1', ['a'], [], { x: 100, y: 200 });
    render(<Board workflows={[w]} picks={[]} onPick={() => {}} initialZoom={0.5} />);
    await vi.waitFor(() => expect(frames()).toHaveLength(1));
    fireEvent.click(frames()[0]!.querySelector('rect')!);
    expect(setCenter).toHaveBeenCalledWith(w.frame.x + w.frame.w / 2, w.frame.y + w.frame.h / 2, { zoom: 0.5 });
  });
});

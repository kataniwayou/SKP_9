import { render } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { DesignOverlay } from './DesignOverlay';
import type { Guides } from './guides';

/** The overlay at zoom 1 (one screen px is one flow px), inside a React Flow viewport as the canvas has it. */
function overlay(guides: Guides) {
  const { container } = render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow nodes={[]} edges={[]} defaultViewport={{ x: 0, y: 0, zoom: 1 }}>
          <DesignOverlay band={null} guides={guides} wires={[]} bendsOf={() => ({ xs: [], ys: [] })} onSegment={() => {}} onEnd={() => {}} ghost={null} />
        </ReactFlow>
      </div>
    </ReactFlowProvider>,
  );
  return container;
}

const num = (el: Element, a: string) => Number(el.getAttribute(a));

describe("the dynamic grid drawn as Visio's (plan 10 phase 1)", () => {
  it('draws each guide line dashed, overshooting 8 screen px at both ends', () => {
    const c = overlay({ lines: [{ x1: 0, y1: 50, x2: 400, y2: 50 }], gaps: [] });
    const lines = c.querySelectorAll('line.design-guide');
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    expect([num(l, 'x1'), num(l, 'y1'), num(l, 'x2'), num(l, 'y2')]).toEqual([-8, 50, 408, 50]);
    expect(l.getAttribute('stroke-dasharray')).toBe('4 3');
  });

  it('draws a gap mark as an arrowed line with two ticks 18 px below', () => {
    const c = overlay({ lines: [], gaps: [{ axis: 'x', from: 224, to: 288, at: 160 }] });
    const marks = c.querySelectorAll('g.design-gap');
    expect(marks).toHaveLength(1);
    const segs = [...marks[0]!.querySelectorAll('line')].map((l) => [num(l, 'x1'), num(l, 'y1'), num(l, 'x2'), num(l, 'y2')]);
    expect(segs).toContainEqual([224, 178, 288, 178]);
    expect(segs).toContainEqual([224, 168, 224, 188]);
    expect(segs).toContainEqual([288, 168, 288, 188]);
    expect(marks[0]!.querySelectorAll('path.design-gap-head')).toHaveLength(2);
  });

  it('draws a vertical gap mark 18 px right of its pair', () => {
    const c = overlay({ lines: [], gaps: [{ axis: 'y', from: 160, to: 224, at: 224 }] });
    const segs = [...c.querySelectorAll('g.design-gap line')].map((l) => [num(l, 'x1'), num(l, 'y1'), num(l, 'x2'), num(l, 'y2')]);
    expect(segs).toContainEqual([242, 160, 242, 224]);
    expect(segs).toContainEqual([232, 160, 252, 160]);
    expect(segs).toContainEqual([232, 224, 252, 224]);
  });
});

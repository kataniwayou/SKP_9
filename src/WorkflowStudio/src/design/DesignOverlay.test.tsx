import { render } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { plainCircuit, setEnd } from '../circuit/circuit';
import { routeCircuit, type WireRoute } from '../layout/circuitRoute';
import { shapeFromPoints } from '../layout/shape';
import { DesignOverlay } from './DesignOverlay';
import type { Guides } from './guides';

/** The overlay at zoom 1 (one screen px is one flow px), inside a React Flow viewport as the canvas has it. */
function overlay(guides: Guides, wires: WireRoute[] = []) {
  const { container } = render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow nodes={[]} edges={[]} defaultViewport={{ x: 0, y: 0, zoom: 1 }}>
          <DesignOverlay band={null} guides={guides} wires={wires} bendsOf={(w) => shapeFromPoints(w.core.points)} onSegment={() => {}} onEnd={() => {}} ghost={null} />
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

describe("a picked wire's ends and dots, as Visio's (plan 10 phase 2)", () => {
  // s1 -> s2 with a bend: s2 placed lower than s1 by hand is not needed, the router's wire is enough; its head opened
  async function wires() {
    const d = await loadedDocument(graphDto({ workflow: workflowDto({ entryStepIds: ['s1'] }), steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2')] }));
    const c = plainCircuit(d.graph.workflow.entryStepIds, d.graph.steps, (id) => d.placement.steps.has(id));
    const ctx = { placement: d.placement, steps: d.graph.steps };
    const glued = routeCircuit(c, ctx).find((w) => w.id === 's1->s2')!;
    const opened = routeCircuit(setEnd(c, 's1->s2', 'head', { on: 'open', x: 2000, y: 2000 }), ctx).find((w) => w.id === 's1->s2')!;
    return { glued, opened };
  }

  it('draws glued ends as green dots and open ends as hollow circles, 8 screen px', async () => {
    const { glued, opened } = await wires();
    let c = overlay({ lines: [], gaps: [] }, [glued]);
    expect(c.querySelectorAll('circle.design-handle.end.glued')).toHaveLength(2);
    expect(c.querySelector('circle.design-handle.end')!.getAttribute('r')).toBe('4');
    c = overlay({ lines: [], gaps: [] }, [opened]);
    expect(c.querySelectorAll('circle.design-handle.end.open')).toHaveLength(1);
    expect(c.querySelectorAll('circle.design-handle.end.glued')).toHaveLength(1);
  });

  it('draws run handles as 6 px dots and a 4 px dot at every bend', async () => {
    const { opened } = await wires();
    const c = overlay({ lines: [], gaps: [] }, [opened]);
    const runs = c.querySelectorAll('circle.design-handle.seg');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]!.getAttribute('r')).toBe('3');
    const bends = c.querySelectorAll('circle.design-bend');
    expect(bends.length).toBe(Math.max(0, opened.core.points.length - 2));
    if (bends.length) expect(bends[0]!.getAttribute('r')).toBe('2');
  });
});

describe("Visio's landing square (plan 10 phase 2)", () => {
  function withHint(tone: 'ok' | 'no') {
    const { container } = render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodes={[]} edges={[]} defaultViewport={{ x: 0, y: 0, zoom: 1 }}>
            <DesignOverlay band={null} guides={{ lines: [], gaps: [] }} wires={[]} bendsOf={() => ({ xs: [], ys: [] })} onSegment={() => {}} onEnd={() => {}} ghost={null}
              hints={[{ id: 's1', line: false, tone, why: tone === 'ok' ? 'connect' : 'wrongSide', at: { x: 120, y: 60 }, contact: { x: 100, y: 50 } }]} />
          </ReactFlow>
        </div>
      </ReactFlowProvider>,
    );
    return container;
  }

  it('draws a 10 screen px square frame centred on where the end would land, green when it glues', () => {
    const sq = withHint('ok').querySelector('rect.design-contact.ok')!;
    expect([num(sq, 'x'), num(sq, 'y'), num(sq, 'width'), num(sq, 'height')]).toEqual([95, 45, 10, 10]);
  });

  it('red when refused', () => {
    expect(withHint('no').querySelector('rect.design-contact.no')).not.toBeNull();
  });
});

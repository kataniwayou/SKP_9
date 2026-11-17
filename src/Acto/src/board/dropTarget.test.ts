import { describe, expect, it } from 'vitest';
import { dropVerdict, dropVerdictItem, stepAt } from './dropTarget';
import { HEADER_H } from './geometry';
import { bw } from './fixtures';

const boards = () => {
  const w = bw('w1', ['a'], [], { x: 100, y: 100 });
  w.graph.workflow.cacheIds = ['c1'];
  w.graph.caches.set('c1', { id: 'c1', name: 'orders', version: '1', description: null, root: '', items: '{}', audit: w.graph.workflow.audit });
  return [w];
};

describe('dropVerdict', () => {
  it('a workflow on empty board creates one there', () => {
    expect(dropVerdict({ kind: 'workflow' }, { x: 5000, y: 5000 }, boards())).toEqual({ do: 'newWorkflow', at: { x: 5000, y: 5000 } });
  });
  it('a workflow inside a frame is refused', () => {
    expect(dropVerdict({ kind: 'workflow' }, { x: 150, y: 150 }, boards())).toEqual({ refused: 'Drop a new workflow on empty board' });
  });
  it('a step or cache on empty board is refused', () => {
    expect(dropVerdict({ kind: 'step', processorId: 'p' }, { x: 0, y: 0 }, boards())).toEqual({ refused: 'Drop a step inside a workflow' });
    expect(dropVerdict({ kind: 'cache-new' }, { x: 0, y: 0 }, boards())).toEqual({ refused: 'Drop a cache inside a workflow' });
    expect(dropVerdict({ kind: 'cache', cacheId: 'x' }, { x: 0, y: 0 }, boards())).toEqual({ refused: 'Drop a cache inside a workflow' });
  });
  it('a step inside a frame, off any step, is added relative to the frame content', () => {
    const b = boards();
    const f = b[0]!.frame;
    expect(dropVerdict({ kind: 'step', processorId: 'p' }, { x: f.x + f.w - 10, y: f.y + f.h - 10 }, b))
      .toEqual({ do: 'addStep', workflowId: 'w1', at: { x: f.w - 10, y: f.h - 10 - HEADER_H } });
  });
  it('a step on a step swaps its processor', () => {
    const b = boards();
    const p = b[0]!.stepAt.get('a')!;
    expect(dropVerdict({ kind: 'step', processorId: 'p' }, { x: 100 + p.x + 5, y: 100 + HEADER_H + p.y + 5 }, b)).toEqual({ do: 'swap', workflowId: 'w1', stepId: 'a' });
  });
  it('a new cache inside a frame; an unlinked cache links; a linked one is refused', () => {
    const b = boards();
    expect(dropVerdict({ kind: 'cache-new' }, { x: 150, y: 150 }, b)).toEqual({ do: 'newCache', workflowId: 'w1' });
    expect(dropVerdict({ kind: 'cache', cacheId: 'c2' }, { x: 150, y: 150 }, b)).toEqual({ do: 'linkCache', workflowId: 'w1', cacheId: 'c2' });
    expect(dropVerdict({ kind: 'cache', cacheId: 'c1' }, { x: 150, y: 150 }, b)).toEqual({ refused: 'orders is already linked to w1-name' });
  });
  it('parses only our payloads', () => {
    expect(dropVerdictItem('{"kind":"step","processorId":"p"}')).toEqual({ kind: 'step', processorId: 'p' });
    expect(dropVerdictItem('nope')).toBeNull();
  });
});

describe('stepAt', () => {
  it('finds the step under a board point, and nothing off the steps', () => {
    const b = boards();
    const p = b[0]!.stepAt.get('a')!;
    expect(stepAt(b, { x: 100 + p.x + 5, y: 100 + HEADER_H + p.y + 5 })).toEqual({ workflowId: 'w1', stepId: 'a' });
    expect(stepAt(b, { x: 100 + p.x - 5, y: 100 + HEADER_H + p.y + 5 })).toBeNull();
    expect(stepAt(b, { x: 5000, y: 5000 })).toBeNull();
  });
});

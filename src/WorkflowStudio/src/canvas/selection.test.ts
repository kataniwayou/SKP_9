import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, stepDto } from '../api/fixtures';
import { graphFromDto } from '../api/toModel';
import { DIE_SELECTED_CLASS, SELECTED_CLASS, selectionFromClick, withSelection } from './selection';
import type { StudioNode } from './toFlow';

const nodes = [{ id: 'wf' }, { id: 's1' }, { id: 's2' }, { id: 'cache:c1' }] as StudioNode[];
const graph = graphFromDto(graphDto({
  steps: [stepDto('s1', { processorId: 'p1' }), stepDto('s2', { processorId: 'gone' })],
  processors: [processorDto('p1')],
  caches: [cacheDto('c1')],
} as never));

describe('withSelection', () => {
  it('keeps a node class it already had beside the selection class', () => {
    const own = [{ id: 's1', type: 'step', position: { x: 0, y: 0 }, className: 'mine', data: {} }] as unknown as StudioNode[];
    expect(withSelection(own, { kind: 'step', stepId: 's1' })[0]!.className).toBe('mine studio-sel');
  });

  it('returns the same array when nothing is selected', () => {
    expect(withSelection(nodes, null)).toBe(nodes);
  });

  it.each([
    [{ kind: 'workflow' } as const, 'wf', SELECTED_CLASS],
    [{ kind: 'step', stepId: 's2' } as const, 's2', SELECTED_CLASS],
    [{ kind: 'processor', processorId: 'p1', stepId: 's1' } as const, 's1', DIE_SELECTED_CLASS],
    [{ kind: 'cache', cacheId: 'c1' } as const, 'cache:c1', SELECTED_CLASS],
  ])('marks exactly one node for %o', (selection, id, className) => {
    const marked = withSelection(nodes, selection).filter((n) => n.className);
    expect(marked.map((n) => [n.id, n.className])).toEqual([[id, className]]);
  });

  it('marks nothing for a selection whose entity is not drawn', () => {
    expect(withSelection(nodes, { kind: 'step', stepId: 'elsewhere' }).some((n) => n.className)).toBe(false);
  });
});

describe('selectionFromClick', () => {
  const die = document.createElement('g');
  die.setAttribute('class', 'chipg');
  const inDie = document.createElement('rect');
  die.appendChild(inDie);
  const outside = document.createElement('rect');

  it('selects the sphere, a cache and a step', () => {
    expect(selectionFromClick({ id: 'wf', type: 'workflow' }, outside, graph)).toEqual({ kind: 'workflow' });
    expect(selectionFromClick({ id: 'cache:c1', type: 'cache' }, outside, graph)).toEqual({ kind: 'cache', cacheId: 'c1' });
    expect(selectionFromClick({ id: 's1', type: 'step' }, outside, graph)).toEqual({ kind: 'step', stepId: 's1' });
  });

  it('selects the processor when the click lands inside the die', () => {
    expect(selectionFromClick({ id: 's1', type: 'step' }, inDie, graph)).toEqual({ kind: 'processor', processorId: 'p1', stepId: 's1' });
  });

  it('falls back to the step when its processor is not in the graph', () => {
    expect(selectionFromClick({ id: 's2', type: 'step' }, inDie, graph)).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('selects nothing for an unknown step or node type', () => {
    expect(selectionFromClick({ id: 'zz', type: 'step' }, outside, graph)).toBeNull();
    expect(selectionFromClick({ id: 'x', type: 'other' }, null, graph)).toBeNull();
  });
});

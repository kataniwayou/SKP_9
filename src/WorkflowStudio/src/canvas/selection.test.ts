import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, stepDto } from '../api/fixtures';
import { graphFromDto } from '../api/toModel';
import { DIE_SELECTED_CLASS, DROP_MOVE_CLASS, DROP_NO_CLASS, DROP_OK_CLASS, PICK_CLASS, SELECTED_CLASS, selectionForPicks, selectionFromClick, withHint, withPicks, withSelection } from './selection';
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

  it('outlines the block under a dragged wire end green or red (plan 4)', () => {
    const nodes = [{ id: 's1', type: 'step', position: { x: 0, y: 0 }, data: {} }] as never;
    expect(withHint(nodes, { id: 's1', tone: 'ok' })[0]!.className).toBe(DROP_OK_CLASS);
    expect(withHint(nodes, { id: 's1', tone: 'move' })[0]!.className).toBe(DROP_MOVE_CLASS);
    expect(withHint(nodes, { id: 's1', tone: 'no' })[0]!.className).toBe(DROP_NO_CLASS);
    expect(withHint(nodes, null)).toBe(nodes);
    expect(withHint(nodes, { id: null, tone: 'move' })).toBe(nodes);
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

  it('marks picked blocks and wires (plan 4)', () => {
    const nodes = [{ id: 's1', type: 'step', position: { x: 0, y: 0 }, data: {} }, { id: 's2', type: 'step', position: { x: 0, y: 0 }, data: {} }] as never;
    const edges = [{ id: 's1->s2', type: 'cable', source: 's1', target: 's2', data: { points: [], colour: '', delay: 0 } }] as never;
    const out = withPicks(nodes, edges, [{ kind: 'node', id: 's2' }, { kind: 'wire', id: 's1->s2' }]);
    expect(out.nodes.map((n) => [n.selected, n.className])).toEqual([[false, undefined], [true, PICK_CLASS]]);
    expect(out.edges[0]!.data).toMatchObject({ picked: true });
  });

  it('ignores picks naming blocks or wires that no longer exist (undo, redo)', () => {
    const nodes = [{ id: 's1', type: 'step', position: { x: 0, y: 0 }, data: {} }] as never;
    const out = withPicks(nodes, [], [{ kind: 'node', id: 'gone' }, { kind: 'wire', id: 'gone->s1' }]);
    expect(out.nodes.map((n) => [n.selected, n.className])).toEqual([[false, undefined]]);
  });

  it('one picked block stands for its entity; a wire, several or none for nothing (plan 4)', () => {
    expect(selectionForPicks([{ kind: 'node', id: 'wf' }], null, graph)).toEqual({ kind: 'workflow' });
    expect(selectionForPicks([{ kind: 'node', id: 'cache:c1' }], null, graph)).toEqual({ kind: 'cache', cacheId: 'c1' });
    expect(selectionForPicks([{ kind: 'node', id: 's1' }], null, graph)).toEqual({ kind: 'step', stepId: 's1' });
    const die = { kind: 'processor', processorId: 'p1', stepId: 's1' } as const;
    expect(selectionForPicks([{ kind: 'node', id: 's1' }], { id: 's1', selection: die }, graph)).toEqual(die);
    expect(selectionForPicks([{ kind: 'node', id: 'gone' }], null, graph)).toBeNull();
    expect(selectionForPicks([{ kind: 'wire', id: 's1->s2' }], null, graph)).toBeNull();
    expect(selectionForPicks([{ kind: 'node', id: 's1' }, { kind: 'node', id: 's2' }], null, graph)).toBeNull();
    expect(selectionForPicks([], null, graph)).toBeNull();
  });
});

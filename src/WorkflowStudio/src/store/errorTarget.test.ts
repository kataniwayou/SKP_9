import { describe, expect, it } from 'vitest';
import { assignmentDto, cacheDto, graphDto, processorDto, stepDto } from '../api/fixtures';
import { graphFromDto } from '../api/toModel';
import { createAssignment, EMPTY_EDITS } from '../design/design';
import type { DesignError } from '../model/graph';
import { errorTarget } from './errorTarget';

const graph = graphFromDto(graphDto({
  steps: [stepDto('s1', { processorId: 'p1' }), stepDto('s2', { processorId: 'p1' })],
  processors: [processorDto('p1')],
  assignments: [assignmentDto('a1', { stepId: 's2' })],
  caches: [cacheDto('c1')],
}));
const error = (kind: string, id: string): DesignError => ({ kind, id, stage: 'x', field: null, message: 'm' });

describe('errorTarget (plan 8 §4.1: a Problems row selects its entity)', () => {
  it('selects the workflow, a step, a cache, and a processor on the first step that uses it', () => {
    expect(errorTarget(error('workflow', 'wf1'), graph, EMPTY_EDITS)).toEqual({ kind: 'workflow' });
    expect(errorTarget(error('step', 's2'), graph, EMPTY_EDITS)).toEqual({ kind: 'step', stepId: 's2' });
    expect(errorTarget(error('cache', 'c1'), graph, EMPTY_EDITS)).toEqual({ kind: 'cache', cacheId: 'c1' });
    expect(errorTarget(error('processor', 'p1'), graph, EMPTY_EDITS)).toEqual({ kind: 'processor', processorId: 'p1', stepId: 's1' });
  });

  it('selects an assignment\'s step, a created one\'s too, and a schema copy\'s processor', () => {
    expect(errorTarget(error('assignment', 'a1'), graph, EMPTY_EDITS)).toEqual({ kind: 'step', stepId: 's2' });
    const edits = { ...createAssignment(EMPTY_EDITS, 's1', 'x', 'n1'), schemas: { 'p1:config': { id: 'copy', name: 'n', version: 'v', description: null, definition: '{}' } } };
    expect(errorTarget(error('assignment', 'n1'), graph, edits)).toEqual({ kind: 'step', stepId: 's1' });
    expect(errorTarget(error('schema', 'copy'), graph, edits)).toEqual({ kind: 'processor', processorId: 'p1', stepId: 's1' });
  });

  it('selects nothing for an entity this canvas does not hold', () => {
    expect(errorTarget(error('step', 'gone'), graph, EMPTY_EDITS)).toBeNull();
    expect(errorTarget(error('schema', 'unknown'), graph, EMPTY_EDITS)).toBeNull();
  });
});

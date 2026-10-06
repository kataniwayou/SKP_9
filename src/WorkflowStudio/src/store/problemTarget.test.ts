import { describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import { graphFromDto } from '../api/toModel';
import type { WorkflowProblem } from '../model/graph';
import { problemTarget } from './problemTarget';

const graph = graphFromDto(graphDto({
  steps: [stepDto('s1', { nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { processorId: 'p2' })],
  processors: [processorDto('p1'), processorDto('p2')],
  assignments: [{ id: 'a1', name: 'x', version: '1.0.0', description: null, stepId: 's2', payload: '{}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
} as never));
const problem = (gate: string, offending: unknown): WorkflowProblem => ({ gate, title: 't', detail: 'd', offending });

describe('problemTarget', () => {
  it('cycle: the first step of the chain this document holds', () => {
    expect(problemTarget(problem('cycle', { stepChain: ['gone', 's2', 's1'] }), graph)).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('missingStep: the parent step, or the workflow when the parent is all zeros (a missing entry step)', () => {
    expect(problemTarget(problem('missingStep', { parentStepId: 's1', missingChildId: 'x' }), graph)).toEqual({ kind: 'step', stepId: 's1' });
    expect(problemTarget(problem('missingStep', { parentStepId: '00000000-0000-0000-0000-000000000000', missingChildId: 'x' }), graph))
      .toEqual({ kind: 'workflow' });
  });

  it('schemaEdge: the child step, falling back to the parent', () => {
    expect(problemTarget(problem('schemaEdge', { parentStepId: 's1', childStepId: 's2' }), graph)).toEqual({ kind: 'step', stepId: 's2' });
    expect(problemTarget(problem('schemaEdge', { parentStepId: 's1', childStepId: 'gone' }), graph)).toEqual({ kind: 'step', stepId: 's1' });
  });

  it('payloadConfigSchema: the step the assignment belongs to', () => {
    expect(problemTarget(problem('payloadConfigSchema', { assignmentId: 'a1', errors: ['bad'] }), graph)).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('processorLiveness: the processor (procId, not processorId) on the first step using it', () => {
    expect(problemTarget(problem('processorLiveness', { procId: 'p2', reason: '0 healthy' }), graph))
      .toEqual({ kind: 'processor', processorId: 'p2', stepId: 's2' });
    expect(problemTarget(problem('processorLiveness', { processorId: 'p2' }), graph)).toBeNull();
  });

  it.each([
    ['an unknown gate', problem('frozen', { stepId: 's1' })],
    ['offending null', problem('cycle', null)],
    ['offending a string', problem('schemaEdge', 's1->s2')],
    ['a chain that is not an array', problem('cycle', { stepChain: 's1' })],
    ['ids of the wrong type', problem('schemaEdge', { parentStepId: 1, childStepId: { id: 's2' } })],
    ['an id this document does not hold', problem('missingStep', { parentStepId: 'elsewhere' })],
    ['an unknown assignment', problem('payloadConfigSchema', { assignmentId: 'a9' })],
  ])('names nothing for %s, without throwing', (_name, p) => {
    expect(problemTarget(p, graph)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from './fixtures';
import { graphFromDto, stepFromDto } from './toModel';

describe('graphFromDto', () => {
  it('converts every collection to maps keyed by id and keeps the layout opaque', () => {
    const graph = graphFromDto(graphDto({
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 5 })],
      processors: [processorDto('p1', { outputSchemaId: 'sc1' })],
      schemas: [{ id: 'sc1', name: 'orders-out', version: '1.4.2', description: null, definition: '{}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
      assignments: [{ id: 'a1', name: 'x', version: '1.0.0', description: null, stepId: 's1', payload: '{"k":1}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
      caches: [{ id: 'c1', name: 'cache', version: '1.0.0', description: null, root: 'r', items: '{"a":"1"}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
      layout: { steps: { s1: { x: 8, y: 16 } } },
    } as never));

    expect([...graph.steps.keys()]).toEqual(['s1', 's2']);
    expect(graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(graph.steps.get('s2')!.entryCondition).toBe(5);
    expect(graph.processors.get('p1')!.outputSchemaId).toBe('sc1');
    expect(graph.schemas.get('sc1')!.version).toBe('1.4.2');
    expect(graph.assignments).toEqual([{ id: 'a1', stepId: 's1', payload: '{"k":1}', updatedAt: '' }]);
    expect(graph.caches.get('c1')!.root).toBe('r');
    expect(graph.layout).toEqual({ steps: { s1: { x: 8, y: 16 } } });
  });

  it('turns missing optional lists into empty lists', () => {
    const graph = graphFromDto(graphDto({
      workflow: workflowDto({ assignmentIds: null, cacheIds: null } as never),
      steps: [stepDto('s1', { nextStepIds: null } as never)],
    }));

    expect(graph.workflow.cacheIds).toEqual([]);
    expect(graph.workflow.assignmentIds).toEqual([]);
    expect(graph.steps.get('s1')!.nextStepIds).toEqual([]);
  });

  it('maps an absent layout to null', () => {
    expect(graphFromDto(graphDto({ layout: undefined } as never)).layout).toBeNull();
  });
});

describe('the fields the Inspector shows', () => {
  it('keeps description, audit, source hash, instance id and cache version', () => {
    const who = { createdAt: '2026-10-01T08:00:00Z', createdBy: 'ana', updatedAt: '2026-10-02T09:30:00Z', updatedBy: null };
    const graph = graphFromDto(graphDto({
      workflow: workflowDto({ description: 'nightly', ...who }),
      steps: [stepDto('s1', { description: 'first', ...who })],
      processors: [processorDto('p1', { description: 'reads', sourceHash: 'f'.repeat(64), instanceId: 'blue', ...who })],
      schemas: [schemaDto('sc1', { description: 'in', ...who })],
      caches: [cacheDto('c1', { version: '2.0.0', description: 'lookups', ...who })],
    }));

    const audit = { createdAt: '2026-10-01T08:00:00Z', createdBy: 'ana', updatedAt: '2026-10-02T09:30:00Z', updatedBy: null };
    expect(graph.workflow).toMatchObject({ description: 'nightly', audit });
    expect(graph.steps.get('s1')).toMatchObject({ description: 'first', audit });
    expect(graph.processors.get('p1')).toMatchObject({ description: 'reads', sourceHash: 'f'.repeat(64), instanceId: 'blue', audit });
    expect(graph.schemas.get('sc1')).toMatchObject({ description: 'in', audit });
    expect(graph.caches.get('c1')).toMatchObject({ version: '2.0.0', description: 'lookups', audit });
  });

  it('turns absent audit fields into empty text and null, never undefined', () => {
    const graph = graphFromDto(graphDto({
      workflow: workflowDto({ createdAt: undefined, createdBy: undefined, updatedAt: undefined, updatedBy: undefined, description: undefined } as never),
    }));
    expect(graph.workflow.audit).toEqual({ createdAt: '', createdBy: null, updatedAt: '', updatedBy: null });
    expect(graph.workflow.description).toBeNull();
  });
});

describe('stepFromDto', () => {
  it('rejects a DTO without an id, because nothing downstream can key it', () => {
    expect(() => stepFromDto(stepDto('', { id: undefined } as never))).toThrow(/id/);
  });
});

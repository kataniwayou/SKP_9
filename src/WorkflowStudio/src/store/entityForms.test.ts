import { describe, expect, it } from 'vitest';
import type { EntityKind } from '../api/entities';
import { assignmentDto, cacheDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import {
  createAssignmentDto, jsonProblem, missingRequired, newAssignmentDto, savedText, shownText, splitErrors, UPDATE_KEYS, updateDto,
} from './entityForms';

describe('updateDto: the DTO round trip (spec §9)', () => {
  it('sends a workflow back as read, with only its writable fields changed', () => {
    const read = workflowDto({ entryStepIds: ['s1', 's2'], assignmentIds: ['a1'], cacheIds: ['c1'], cronExpression: '0 * * * *', description: 'old' });
    expect(updateDto('workflow', read, { name: 'renamed', cronExpression: '' })).toEqual({
      name: 'renamed', version: '1.0.0', description: 'old', entryStepIds: ['s1', 's2'], assignmentIds: ['a1'], cacheIds: ['c1'], cronExpression: null,
    });
  });

  it("sends a step's next steps and processor back unchanged, and its entry condition as a number", () => {
    const read = stepDto('s1', { nextStepIds: ['s2', 's3'], processorId: 'p9', entryCondition: 1 });
    expect(updateDto('step', read, { entryCondition: '4', description: 'now' })).toEqual({
      name: 'step-s1', version: '1.0.0', description: 'now', processorId: 'p9', nextStepIds: ['s2', 's3'], entryCondition: 4,
    });
  });

  it('keeps a null structural list null', () => {
    expect(updateDto('step', stepDto('s1', { nextStepIds: null }), {}).nextStepIds).toBeNull();
  });

  it("sends a processor's schema ids back unchanged; a blank instance id is null", () => {
    const read = processorDto('p1', { inputSchemaId: 'i1', outputSchemaId: null, configSchemaId: 'c1', instanceId: 'east' });
    expect(updateDto('processor', read, { instanceId: '  ' })).toEqual({
      name: 'proc-p1', version: '1.0.0', description: null, sourceHash: 'a'.repeat(64), instanceId: null,
      inputSchemaId: 'i1', outputSchemaId: null, configSchemaId: 'c1',
    });
  });

  it("sends an assignment's step back unchanged", () => {
    expect(updateDto('assignment', assignmentDto('a1', { stepId: 's7', payload: '{"k":1}' }), { payload: '{"k":2}' })).toEqual({
      name: 'assignment-a1', version: '1.0.0', description: null, stepId: 's7', payload: '{"k":2}',
    });
  });

  it('sends a schema and a cache with their writable fields, JSON text as typed', () => {
    expect(updateDto('schema', schemaDto('sc1'), { definition: '{"type":"object"}' })).toEqual({
      name: 'schema-sc1', version: '1.0.0', description: null, definition: '{"type":"object"}',
    });
    expect(updateDto('cache', cacheDto('c1'), { root: 'orders', items: '{"a":"b"}' })).toEqual({
      name: 'cache-c1', version: '1.0.0', description: null, root: 'orders', items: '{"a":"b"}',
    });
  });

  it('never sends the id or an audit field: exactly the update DTO keys', () => {
    const reads: Record<EntityKind, object> = {
      workflow: workflowDto(), step: stepDto('s1'), processor: processorDto('p1'), schema: schemaDto('sc1'), assignment: assignmentDto('a1'), cache: cacheDto('c1'),
    };
    for (const kind of Object.keys(reads) as EntityKind[]) {
      expect(Object.keys(updateDto(kind, reads[kind] as never, {}))).toEqual([...UPDATE_KEYS[kind]]);
    }
  });
});

describe('form helpers', () => {
  it('reads saved values as text', () => {
    expect(savedText(stepDto('s1', { description: null }), 'description')).toBe('');
    expect(savedText(stepDto('s1', { entryCondition: 3 }), 'entryCondition')).toBe('3');
    expect(shownText(stepDto('s1'), { name: 'typed' }, 'name')).toBe('typed');
    expect(shownText(stepDto('s1'), {}, 'name')).toBe('step-s1');
  });

  it('wants a name and a version (the only rule the browser checks)', () => {
    expect(missingRequired('step', stepDto('s1'), {})).toBe(false);
    expect(missingRequired('step', stepDto('s1'), { name: '  ' })).toBe(true);
    expect(missingRequired('cache', cacheDto('c1'), { version: '' })).toBe(true);
  });

  it('marks text that is not JSON', () => {
    expect(jsonProblem('{"a":1}')).toBeNull();
    expect(jsonProblem('[]')).toBeNull();
    expect(jsonProblem('{')).toBe('Not valid JSON');
    expect(jsonProblem('')).toBe('Not valid JSON');
  });

  it("puts a 400's messages under the fields the form edits, and the rest aside", () => {
    expect(splitErrors('cache', {
      Root: ["Root must not contain ':'."], Items: ['Items must be a JSON object.'], EntryStepIds: ['x'], '$.items': ['bad'],
    })).toEqual({ fields: { root: ["Root must not contain ':'."], items: ['Items must be a JSON object.'] }, other: ['x', 'bad'] });
  });

  it("prefills a new assignment from its step, and creates it from what the form shows", () => {
    const fresh = newAssignmentDto({ id: 's1', name: 'fetch' });
    expect(fresh).toMatchObject({ id: '', name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{}' });
    expect(createAssignmentDto(fresh, { payload: '{"a":1}', description: '' })).toEqual({
      name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{"a":1}',
    });
  });
});

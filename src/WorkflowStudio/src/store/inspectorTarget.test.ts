import { describe, expect, it } from 'vitest';
import { crumbLabel, currentTarget, entityKindOf, isTarget, rootTarget, targetKey, type InspectorTarget } from './inspectorTarget';

describe('inspector targets', () => {
  it('starts from the selection', () => {
    expect(rootTarget(null, 'wf1')).toBeNull();
    expect(rootTarget({ kind: 'workflow' }, 'wf1')).toEqual({ kind: 'workflow', id: 'wf1' });
    expect(rootTarget({ kind: 'step', stepId: 's1' }, 'wf1')).toEqual({ kind: 'step', id: 's1' });
    expect(rootTarget({ kind: 'processor', processorId: 'p1', stepId: 's1' }, 'wf1')).toEqual({ kind: 'processor', id: 'p1' });
    expect(rootTarget({ kind: 'cache', cacheId: 'c1' }, 'wf1')).toEqual({ kind: 'cache', id: 'c1' });
  });

  it('shows the last drill-down, else the selection', () => {
    const root: InspectorTarget = { kind: 'step', id: 's1' };
    const schema: InspectorTarget = { kind: 'schema', id: 'sc1', slot: 'config' };
    expect(currentTarget(root, [])).toBe(root);
    expect(currentTarget(root, [{ kind: 'processor', id: 'p1' }, schema])).toBe(schema);
  });

  it('keys, kinds and labels', () => {
    expect(targetKey(null)).toBe('none');
    expect(targetKey({ kind: 'schema', id: 'sc1', slot: 'input' })).toBe('schema:sc1');
    expect(targetKey({ kind: 'newAssignment', stepId: 's1', stepName: 'fetch' })).toBe('newAssignment:s1');
    expect(entityKindOf({ kind: 'newAssignment', stepId: 's1', stepName: 'fetch' })).toBe('assignment');
    expect(crumbLabel({ kind: 'schema', id: 'sc1', slot: 'config' })).toBe('Config schema');
    expect(crumbLabel({ kind: 'newAssignment', stepId: 's1', stepName: 'fetch' })).toBe('New assignment');
  });

  it('accepts only well-formed targets (a restored draft is checked with it)', () => {
    expect(isTarget({ kind: 'step', id: 's1' })).toBe(true);
    expect(isTarget({ kind: 'schema', id: 'sc1', slot: 'config' })).toBe(true);
    expect(isTarget({ kind: 'assignment', id: 'a1', stepId: 's1' })).toBe(true);
    expect(isTarget({ kind: 'newAssignment', stepId: 's1', stepName: '' })).toBe(true);
    expect(isTarget({ kind: 'schema', id: 'sc1', slot: 'other' })).toBe(false);
    expect(isTarget({ kind: 'assignment', id: 'a1' })).toBe(false);
    expect(isTarget({ kind: 'step', id: '' })).toBe(false);
    expect(isTarget({ kind: 'wire', id: 'w1' })).toBe(false);
    expect(isTarget('step')).toBe(false);
  });
});

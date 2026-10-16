import { describe, expect, it, vi } from 'vitest';
import type { ProjectData } from '../api/project';
import { atomKey, buildMolecule } from '../molecule/model';
import { createWorkspace } from './workspace';

const data: ProjectData = {
  workflows: [], steps: [], processors: [], assignments: [], caches: [],
  schemas: [{ id: 'c1', name: 'a', version: '1.0.0', description: null }],
};
const C = atomKey('schema', 'c1');

describe('workspace', () => {
  it('records an edit per field, and drops it when the stored text is typed again', () => {
    const ws = createWorkspace();
    ws.edit(C, 'name', 'b', 'a');
    ws.edit(C, 'version', '2.0.0', '1.0.0');
    expect(ws.get().edits).toEqual({ [C]: { name: 'b', version: '2.0.0' } });
    ws.edit(C, 'name', 'a', 'a');
    expect(ws.get().edits).toEqual({ [C]: { version: '2.0.0' } });
    ws.revert(C);
    expect(ws.get().edits).toEqual({});
  });

  it('tells its listeners, and not for a hover that changes nothing', () => {
    const ws = createWorkspace();
    const l = vi.fn();
    ws.subscribe(l);
    ws.hover(C); ws.hover(C);
    expect(l).toHaveBeenCalledTimes(1);
  });

  it('drops a restored pin or edit of a row the project no longer has', () => {
    const ws = createWorkspace({ pinned: 'schema:gone', edits: { 'schema:gone': { name: 'x' }, [C]: { name: 'b' } } });
    ws.loaded(data, buildMolecule(data));
    expect(ws.get().pinned).toBeNull();
    expect(ws.get().edits).toEqual({ [C]: { name: 'b' } });
  });
});

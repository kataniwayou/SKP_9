import type { Cache, Processor } from '../model/graph';
import { AUDIT } from '../model/fixtures';
import { bw } from '../board/fixtures';
import type { BoardWorkflow } from '../board/loadBoard';

/** Tests only: a processor named `name`. */
export function proc(id: string, name: string): Processor {
  return {
    id, name, version: '1.0.0', description: null, sourceHash: '', instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: null, audit: AUDIT,
  };
}
export function procs(): Map<string, Processor> {
  return new Map([['p1', proc('p1', 'Analyst')]]);
}

/** Tests only: workflow w1 'orders', steps a→b, an assignment on a and one linked cache c1. */
export function bwFull(over: { updatedAt?: string } = {}): BoardWorkflow {
  const base = bw('w1', ['a', 'b'], [{ id: 'a>b', from: 'a', to: 'b', condition: 4 }]);
  const cache: Cache = { id: 'c1', name: 'c1-name', version: '1.0.0', description: null, root: 'r', items: '{}', audit: AUDIT };
  for (const [id, s] of base.graph.steps) {
    base.graph.steps.set(id, { ...s, processorId: 'p1', updatedAt: '2026-01-01T00:00:00Z' });
  }
  base.graph.processors = procs();
  base.graph.workflow = {
    ...base.graph.workflow, name: 'orders', updatedAt: over.updatedAt ?? '2026-01-01T00:00:00Z',
    assignmentIds: ['as0'], cacheIds: ['c1'],
  };
  base.graph.assignments = [{
    id: 'as0', stepId: 'a', payload: '{}', updatedAt: '2026-01-01T00:00:00Z',
    name: 'a-name-assignment', version: '1.0.0', description: null,
  }];
  base.graph.caches = new Map([['c1', cache]]);
  return base;
}

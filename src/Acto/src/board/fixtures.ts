import type { Graph, Processor, Step } from '../model/graph';
import { AUDIT } from '../model/fixtures';
import { defaultStepPositions, frameSizeOf } from './placement';
import { stepRoles } from './roles';
import type { Wire } from './wires';
import type { BoardWorkflow } from './loadBoard';

/** Tests only: a BoardWorkflow named `id + '-name'` whose steps are named `stepId + '-name'`. */
export function bw(id: string, stepIds: string[], wires: Wire[] = [], at: { x: number; y: number } = { x: 0, y: 0 }): BoardWorkflow {
  const steps = new Map<string, Step>();
  const processors = new Map<string, Processor>();
  for (const s of stepIds) {
    steps.set(s, {
      id: s, name: `${s}-name`, version: '1.0.0', description: null, processorId: `p-${s}`,
      nextStepIds: wires.filter((w) => w.from === s).map((w) => w.to), entryCondition: 4, updatedAt: '', audit: AUDIT,
    });
    processors.set(`p-${s}`, {
      id: `p-${s}`, name: `${s}-proc`, version: '1.0.0', description: null, sourceHash: '', instanceId: null,
    } as unknown as Processor);
  }
  const graph = {
    workflow: {
      id, name: `${id}-name`, version: '1.0.0', description: null, cronExpression: null,
      entryStepIds: stepIds.slice(0, 1), assignmentIds: [], cacheIds: [], updatedAt: '', audit: AUDIT,
    },
    steps, processors, schemas: new Map(), assignments: [], caches: new Map(), layout: null, design: null,
  } as Graph;
  const stepAt = defaultStepPositions(graph.workflow.entryStepIds, steps, new Map());
  const size = frameSizeOf(stepAt);
  return {
    graph, stepIds, stepAt, frame: { ...at, ...size }, roles: stepRoles(stepIds, wires), wires,
    entryDiff: { stops: [], starts: [] },
  };
}

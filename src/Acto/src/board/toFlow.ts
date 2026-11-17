import { Position, type Edge, type Node } from '@xyflow/react';
import { CHIP_H, CHIP_W, cacheChipAt } from './cacheChips';
import { HEADER_H, STEP_H, STEP_W } from './geometry';
import type { BoardWorkflow } from './loadBoard';
import { landings } from './wires';

/** Declared up front so edges can be placed before the DOM is measured (and under jsdom, which measures nothing). */
const STEP_HANDLES: Node['handles'] = [
  { type: 'target', position: Position.Left, x: 0, y: STEP_H / 2, width: 1, height: 1 },
  { type: 'source', position: Position.Right, x: STEP_W, y: STEP_H / 2, width: 1, height: 1 },
];

export function toFlow(workflows: BoardWorkflow[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const w of workflows) {
    const wfId = w.graph.workflow.id;
    const parent = `wf:${wfId}`;
    nodes.push({
      id: parent, type: 'workflow', position: { x: w.frame.x, y: w.frame.y }, style: { width: w.frame.w, height: w.frame.h }, width: w.frame.w, height: w.frame.h,
      data: { workflowId: wfId }, draggable: false,
    });
    for (const stepId of w.stepIds) {
      const p = w.stepAt.get(stepId) ?? { x: 0, y: 0 };
      nodes.push({
        id: `st:${wfId}:${stepId}`, type: 'step', parentId: parent,
        // relative to the frame and clamped by the step's size: never into the header band
        extent: [[0, HEADER_H], [w.frame.w, w.frame.h]], position: { x: p.x, y: p.y + HEADER_H },
        style: { width: STEP_W, height: STEP_H }, width: STEP_W, height: STEP_H, draggable: false,
        handles: STEP_HANDLES,
        data: { workflowId: wfId, stepId, role: w.roles.get(stepId) ?? 'reached' },
      });
    }
    w.graph.workflow.cacheIds.forEach((cacheId, i) => {
      if (!w.graph.caches.has(cacheId)) return;
      const c = cacheChipAt(i, w.frame);
      nodes.push({
        id: `ca:${wfId}:${cacheId}`, type: 'cache', parentId: parent, extent: 'parent', position: { x: c.x, y: c.y + HEADER_H },
        style: { width: CHIP_W, height: CHIP_H }, width: CHIP_W, height: CHIP_H, draggable: false,
        data: { workflowId: wfId, cacheId },
      });
    });
    const boxOf = (id: string) => {
      const p = w.stepAt.get(id);
      return p ? { x: w.frame.x + p.x, y: w.frame.y + HEADER_H + p.y, w: STEP_W, h: STEP_H } : null;
    };
    const lands = landings(w.wires, boxOf);
    const seen = new Set<string>();
    for (const wire of w.wires) {
      const land = lands.get(wire.id);
      if (!land || seen.has(wire.id)) continue;
      seen.add(wire.id);
      edges.push({
        id: `wi:${wfId}:${wire.id}`, type: 'link', source: `st:${wfId}:${wire.from}`, target: `st:${wfId}:${wire.to}`,
        data: { condition: wire.condition, out: land.out, in: land.in, workflowId: wfId, wireId: wire.id },
      });
    }
  }
  return { nodes, edges };
}

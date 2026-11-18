import { Position, type Edge, type Node } from '@xyflow/react';
import type { LiveStatus } from '../api/liveStatus';
import { reachOf, type BoardState } from '../design/board';
import { assignmentOf } from '../design/payloads';
import type { Id } from '../model/graph';
import { payloadKeyCount } from '../model/assignments';
import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W, TRI_SHAPE_H, TRI_SHAPE_W } from './geometry';
import { nodeId } from './connect';
import type { Pick } from './selection';

/** What the board shows besides the rows: the selected triangle, the picks, and the live reading of each workflow. */
export interface BoardView {
  /** The selected triangle: lights what it reaches and links, dims the rest. */
  workflow: Id | null;
  /** Everything picked, in pick order. */
  picks: Pick[];
  live: (workflowId: Id) => LiveStatus;
  /** The problems the workflow's last dry run found (the triangle's badge); none without it. */
  problems?: (workflowId: Id) => number;
  /** Whether the last Save failed on this item (`workflow:<id>`, `step:<id>`, `cache:<id>`): its failure outline. */
  failed?: (key: string) => boolean;
}

export interface PickInfo { no: number; solo: boolean }
export interface StepFooter { text: string; accent: boolean }

export const edgeIdOf = {
  wire: (from: Id, to: Id) => `wire:${from}:${to}`,
  entry: (wf: Id, step: Id) => `entry:${wf}:${step}`,
  cacheLink: (wf: Id, cache: Id) => `cache:${wf}:${cache}`,
};

/** The React Flow node or edge id of a pick. */
export function flowIdOf(p: Pick): string {
  switch (p.kind) {
    case 'workflow': case 'step': case 'cache': return nodeId(p.kind, p.id);
    case 'wire': return edgeIdOf.wire(p.from, p.to);
    case 'entry': return edgeIdOf.entry(p.workflowId, p.stepId);
    case 'cacheLink': return edgeIdOf.cacheLink(p.workflowId, p.cacheId);
  }
}

/** Declared up front so edges can be placed before the DOM is measured (and under jsdom, which measures nothing). */
const handle = (type: 'source' | 'target', id: string, position: Position, x: number, y: number): NonNullable<Node['handles']>[number] =>
  ({ type, id, position, x, y, width: 1, height: 1 });
const TRIANGLE_HANDLES = [
  handle('source', 'tip', Position.Right, TRI_SHAPE_W, TRI_SHAPE_H / 2),
  handle('source', 'back', Position.Left, 0, TRI_SHAPE_H / 2),
];
const STEP_HANDLES = [handle('target', 'in', Position.Left, 0, STEP_H / 2), handle('source', 'out', Position.Right, STEP_W, STEP_H / 2)];
const CACHE_HANDLES = [handle('target', 'in', Position.Top, CACHE_W / 2, 0)];

const DIM = { className: 'dim' } as const;

/** The selected workflow's payload on a step, in a few words. */
function payloadSummary(b: BoardState, wf: Id, step: Id): string {
  const a = assignmentOf(b, wf, step);
  if (!a) return 'no payload';
  const n = payloadKeyCount(a.payload);
  return n === null ? 'payload' : `${n} key${n === 1 ? '' : 's'}`;
}

export function toFlow(b: BoardState, view: BoardView): { nodes: Node[]; edges: Edge[] } {
  const sel = view.workflow !== null && b.workflows[view.workflow] ? view.workflow : null;
  const selWf = sel ? b.workflows[sel]! : null;
  const reach = sel ? reachOf(b, sel) : new Set<Id>();
  const order = new Map(view.picks.map((p, i) => [flowIdOf(p), i + 1]));
  const failed = (key: string) => view.failed?.(key) ?? false;
  const pickOf = (id: string): PickInfo | undefined => { const no = order.get(id); return no === undefined ? undefined : { no, solo: view.picks.length === 1 }; };

  const nodes: Node[] = [];
  for (const w of Object.values(b.workflows)) {
    const id = nodeId('workflow', w.id);
    const pick = pickOf(id);
    nodes.push({
      id, type: 'workflow', position: { ...(w.at ?? { x: 0, y: 0 }) }, width: TRIANGLE_W, height: TRIANGLE_H, style: { width: TRIANGLE_W, height: TRIANGLE_H },
      handles: TRIANGLE_HANDLES, selected: pick !== undefined, ...(sel !== null && sel !== w.id ? DIM : {}),
      data: {
        workflowId: w.id, name: w.name, status: view.live(w.id), lit: sel === w.id, problems: view.problems?.(w.id) ?? 0,
        failed: failed(`workflow:${w.id}`), ...(pick ? { pick } : {}),
      },
    });
  }
  for (const s of Object.values(b.steps)) {
    const id = nodeId('step', s.id);
    const pick = pickOf(id);
    const lit = sel === null || reach.has(s.id);
    const footer: StepFooter = sel !== null && reach.has(s.id) ? { text: payloadSummary(b, sel, s.id), accent: true } : { text: s.version, accent: false };
    nodes.push({
      id, type: 'step', position: { ...(s.at ?? { x: 0, y: 0 }) }, width: STEP_W, height: STEP_H, style: { width: STEP_W, height: STEP_H },
      handles: STEP_HANDLES, selected: pick !== undefined, ...(lit ? {} : DIM),
      data: { stepId: s.id, name: s.name, processor: s.processorId ? b.processors[s.processorId]?.name ?? null : null, processorId: s.processorId, footer, failed: failed(`step:${s.id}`), ...(pick ? { pick } : {}) },
    });
  }
  for (const c of Object.values(b.caches)) {
    const id = nodeId('cache', c.id);
    const pick = pickOf(id);
    const lit = selWf === null || selWf.cacheIds.includes(c.id);
    nodes.push({
      id, type: 'cache', position: { ...(c.at ?? { x: 0, y: 0 }) }, width: CACHE_W, height: CACHE_H, style: { width: CACHE_W, height: CACHE_H },
      handles: CACHE_HANDLES, selected: pick !== undefined, ...(lit ? {} : DIM),
      data: { cacheId: c.id, name: c.name, failed: failed(`cache:${c.id}`), ...(pick ? { pick } : {}) },
    });
  }

  // a wire flows while any running workflow reaches the step it leaves
  const reaching = new Map<Id, Id[]>();
  for (const w of Object.values(b.workflows)) for (const sid of reachOf(b, w.id)) reaching.set(sid, [...(reaching.get(sid) ?? []), w.id]);

  const edges: Edge[] = [];
  for (const s of Object.values(b.steps)) {
    for (const to of new Set(s.nextStepIds)) {
      const t = b.steps[to];
      if (!t) continue;
      const id = edgeIdOf.wire(s.id, to);
      const pick = pickOf(id);
      edges.push({
        id, type: 'wire', source: nodeId('step', s.id), sourceHandle: 'out', target: nodeId('step', to), targetHandle: 'in',
        selected: pick !== undefined, ...(sel === null || reach.has(s.id) ? {} : DIM),
        data: { condition: t.entryCondition, from: s.id, to, running: (reaching.get(s.id) ?? []).some((w) => view.live(w) === 'running'), ...(pick ? { pick } : {}) },
      });
    }
  }
  for (const w of Object.values(b.workflows)) {
    const dimmed = sel !== null && sel !== w.id;
    for (const sid of new Set(w.entryStepIds)) {
      if (!b.steps[sid]) continue;
      const id = edgeIdOf.entry(w.id, sid);
      const pick = pickOf(id);
      edges.push({
        id, type: 'entry', source: nodeId('workflow', w.id), sourceHandle: 'tip', target: nodeId('step', sid), targetHandle: 'in',
        selected: pick !== undefined, ...(dimmed ? DIM : {}),
        data: { workflowId: w.id, stepId: sid, lit: sel === w.id, ...(pick ? { pick } : {}) },
      });
    }
  }
  for (const w of Object.values(b.workflows)) {
    const dimmed = sel !== null && sel !== w.id;
    for (const cid of new Set(w.cacheIds)) {
      if (!b.caches[cid]) continue;
      const id = edgeIdOf.cacheLink(w.id, cid);
      const pick = pickOf(id);
      edges.push({
        id, type: 'cacheLink', source: nodeId('workflow', w.id), sourceHandle: 'back', target: nodeId('cache', cid), targetHandle: 'in',
        selected: pick !== undefined, ...(dimmed ? DIM : {}),
        data: { workflowId: w.id, cacheId: cid, lit: sel === w.id, ...(pick ? { pick } : {}) },
      });
    }
  }
  return { nodes, edges };
}

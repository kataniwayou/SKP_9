import { Position, type Edge, type Node } from '@xyflow/react';
import type { LiveStatus } from '../api/liveStatus';
import { reachOf, type BoardState } from '../design/board';
import type { GhostItem } from '../design/ghosts';
import { assignmentOf } from '../design/payloads';
import type { Id } from '../model/graph';
import { payloadKeyCount } from '../model/assignments';
import { CACHE_H, CACHE_W, STEP_H, STEP_W, TRIANGLE_H, TRIANGLE_W, TRI_SHAPE_H, TRI_SHAPE_W } from './geometry';
import { nodeId } from './connect';
import { hueOf } from './hues';
import type { Pick } from './selection';

/** What the board shows besides the rows: the selected triangles, the picks, the live reading of each workflow and the ghosts. */
export interface BoardView {
  /** The selected triangles, in selection order: each carries its hue. Nothing dims. */
  workflows: Id[];
  /** Everything picked, in pick order. */
  picks: Pick[];
  live: (workflowId: Id) => LiveStatus;
  /** The problems the workflow's last dry run found (the triangle's badge); none without it. */
  problems?: (workflowId: Id) => number;
  /** Whether the last Save failed on this item (`workflow:<id>`, `step:<id>`, `cache:<id>`): its failure outline. */
  failed?: (key: string) => boolean;
  /** Whether the item (`workflow:<id>`, `step:<id>`, `cache:<id>`) has unsaved changes: its unsaved mark. */
  unsaved?: (key: string) => boolean;
  /** Deleted items seen earlier this session: drawn faded at their last place, not draggable. */
  ghosts?: GhostItem[];
}

export interface PickInfo { no: number; solo: boolean }
/** One selected workflow's payload on a step, in its hue. */
export interface StepChip { text: string; hue: string }

export const edgeIdOf = {
  wire: (from: Id, to: Id) => `wire:${from}:${to}`,
  entry: (wf: Id, step: Id) => `entry:${wf}:${step}`,
  cacheLink: (wf: Id, cache: Id) => `cache:${wf}:${cache}`,
};

/** The React Flow node or edge id of a ghost item key. */
const ghostId = (key: string) => `ghost:${key}`;

/** The React Flow node or edge id of a pick. */
export function flowIdOf(p: Pick): string {
  switch (p.kind) {
    case 'workflow': case 'step': case 'cache': return nodeId(p.kind, p.id);
    case 'wire': return edgeIdOf.wire(p.from, p.to);
    case 'entry': return edgeIdOf.entry(p.workflowId, p.stepId);
    case 'cacheLink': return edgeIdOf.cacheLink(p.workflowId, p.cacheId);
    case 'ghost': return ghostId(p.key);
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

const GHOST = { draggable: false, connectable: false, zIndex: -1, className: 'ghost' } as const;

/** A chip's text: a workflow's payload on a step in a few words. */
function chipText(payload: string, suffix: string): string {
  const n = payloadKeyCount(payload);
  return `◆ ${n === null ? 'payload' : `${n} key${n === 1 ? '' : 's'}`}${suffix}`;
}

export function toFlow(b: BoardState, view: BoardView): { nodes: Node[]; edges: Edge[] } {
  const selected = view.workflows.filter((w) => b.workflows[w]);
  const hue = (wf: Id) => hueOf({ workflows: view.workflows }, wf);
  const order = new Map(view.picks.map((p, i) => [flowIdOf(p), i + 1]));
  const failed = (key: string) => view.failed?.(key) ?? false;
  const unsaved = (key: string) => view.unsaved?.(key) ?? false;
  const pickOf = (id: string): PickInfo | undefined => { const no = order.get(id); return no === undefined ? undefined : { no, solo: view.picks.length === 1 }; };
  const running = (wf: Id) => view.live(wf) === 'running';

  // a step runs, and its wires flow, while any running workflow reaches it
  const reaching = new Map<Id, Id[]>();
  for (const w of Object.values(b.workflows)) for (const sid of reachOf(b, w.id)) reaching.set(sid, [...(reaching.get(sid) ?? []), w.id]);
  const stepRuns = (sid: Id) => (reaching.get(sid) ?? []).some(running);

  const nodes: Node[] = [];
  for (const w of Object.values(b.workflows)) {
    const id = nodeId('workflow', w.id);
    const pick = pickOf(id);
    nodes.push({
      id, type: 'workflow', position: { ...(w.at ?? { x: 0, y: 0 }) }, width: TRIANGLE_W, height: TRIANGLE_H, style: { width: TRIANGLE_W, height: TRIANGLE_H },
      handles: TRIANGLE_HANDLES, selected: pick !== undefined,
      data: {
        workflowId: w.id, name: w.name, status: view.live(w.id), hue: hue(w.id), problems: view.problems?.(w.id) ?? 0,
        failed: failed(`workflow:${w.id}`), unsaved: unsaved(`workflow:${w.id}`), ...(pick ? { pick } : {}),
      },
    });
  }
  for (const s of Object.values(b.steps)) {
    const id = nodeId('step', s.id);
    const pick = pickOf(id);
    const chips: StepChip[] = [];
    for (const w of selected) {
      const a = assignmentOf(b, w, s.id);
      if (!a) continue;
      // the full workflow name (R10): the card's width truncates it with an ellipsis, the chip's title holds it whole
      const suffix = selected.length > 1 ? ` · ${b.workflows[w]!.name}` : '';
      chips.push({ text: chipText(a.payload, suffix), hue: hue(w)! });
    }
    nodes.push({
      id, type: 'step', position: { ...(s.at ?? { x: 0, y: 0 }) }, width: STEP_W, height: STEP_H, style: { width: STEP_W, height: STEP_H },
      handles: STEP_HANDLES, selected: pick !== undefined,
      data: {
        stepId: s.id, name: s.name, processor: s.processorId ? b.processors[s.processorId]?.name ?? null : null, processorId: s.processorId,
        condition: s.entryCondition, running: stepRuns(s.id), chips, failed: failed(`step:${s.id}`), unsaved: unsaved(`step:${s.id}`), ...(pick ? { pick } : {}),
      },
    });
  }
  for (const c of Object.values(b.caches)) {
    const id = nodeId('cache', c.id);
    const pick = pickOf(id);
    nodes.push({
      id, type: 'cache', position: { ...(c.at ?? { x: 0, y: 0 }) }, width: CACHE_W, height: CACHE_H, style: { width: CACHE_W, height: CACHE_H },
      handles: CACHE_HANDLES, selected: pick !== undefined,
      data: { cacheId: c.id, name: c.name, failed: failed(`cache:${c.id}`), unsaved: unsaved(`cache:${c.id}`), ...(pick ? { pick } : {}) },
    });
  }

  const edges: Edge[] = [];
  for (const s of Object.values(b.steps)) {
    for (const to of new Set(s.nextStepIds)) {
      const t = b.steps[to];
      if (!t) continue;
      const id = edgeIdOf.wire(s.id, to);
      const pick = pickOf(id);
      edges.push({
        id, type: 'wire', source: nodeId('step', s.id), sourceHandle: 'out', target: nodeId('step', to), targetHandle: 'in',
        selected: pick !== undefined,
        // a wire into a Never step never fires, so it never moves [user, 2026-11-23 item 4]
        data: { condition: t.entryCondition, from: s.id, to, running: stepRuns(s.id) && t.entryCondition !== 5, ...(pick ? { pick } : {}) },
      });
    }
  }
  for (const w of Object.values(b.workflows)) {
    for (const sid of new Set(w.entryStepIds)) {
      if (!b.steps[sid]) continue;
      const id = edgeIdOf.entry(w.id, sid);
      const pick = pickOf(id);
      edges.push({
        id, type: 'entry', source: nodeId('workflow', w.id), sourceHandle: 'tip', target: nodeId('step', sid), targetHandle: 'in',
        selected: pick !== undefined,
        data: { workflowId: w.id, stepId: sid, hue: hue(w.id), running: running(w.id), ...(w.entryCrons?.[sid] ? { cron: w.entryCrons[sid] } : {}), ...(pick ? { pick } : {}) },
      });
    }
  }
  for (const w of Object.values(b.workflows)) {
    for (const cid of new Set(w.cacheIds)) {
      if (!b.caches[cid]) continue;
      const id = edgeIdOf.cacheLink(w.id, cid);
      const pick = pickOf(id);
      edges.push({
        id, type: 'cacheLink', source: nodeId('workflow', w.id), sourceHandle: 'back', target: nodeId('cache', cid), targetHandle: 'in',
        selected: pick !== undefined,
        data: { workflowId: w.id, cacheId: cid, hue: hue(w.id), ...(pick ? { pick } : {}) },
      });
    }
  }

  // ghosts: deleted items at their last place; a ghost edge is drawn only when both ends are on the board (real or ghost)
  const ghosts = (view.ghosts ?? []).filter((g) => {
    if (g.kind === 'step') return !b.steps[g.row.id];
    if (g.kind === 'cache') return !b.caches[g.row.id];
    if (g.kind === 'workflow') return !b.workflows[g.row.id];
    return true;
  });
  const ghostNodes = new Set(ghosts.filter((g) => g.kind === 'step' || g.kind === 'cache' || g.kind === 'workflow').map((g) => g.key));
  const endOf = (kind: 'step' | 'cache' | 'workflow', id: Id): string | null => {
    const real = kind === 'step' ? b.steps[id] : kind === 'cache' ? b.caches[id] : b.workflows[id];
    if (real) return nodeId(kind, id);
    return ghostNodes.has(`${kind}:${id}`) ? ghostId(`${kind}:${id}`) : null;
  };
  const ghostBase = (key: string) => ({ ...GHOST, selected: pickOf(ghostId(key)) !== undefined });
  for (const g of ghosts) {
    const id = ghostId(g.key);
    const pick = pickOf(id);
    const extra = { ghost: true, ghostKey: g.key, ...(pick ? { pick } : {}) };
    if (g.kind === 'step') {
      const s = g.row;
      nodes.push({
        id, type: 'step', position: { ...(s.at ?? { x: 0, y: 0 }) }, width: STEP_W, height: STEP_H, style: { width: STEP_W, height: STEP_H },
        handles: STEP_HANDLES, ...ghostBase(g.key),
        data: {
          stepId: s.id, name: s.name, processor: s.processorId ? b.processors[s.processorId]?.name ?? null : null, processorId: s.processorId,
          condition: s.entryCondition, running: false, chips: [], failed: false, unsaved: false, ...extra,
        },
      });
    } else if (g.kind === 'cache') {
      nodes.push({
        id, type: 'cache', position: { ...(g.row.at ?? { x: 0, y: 0 }) }, width: CACHE_W, height: CACHE_H, style: { width: CACHE_W, height: CACHE_H },
        handles: CACHE_HANDLES, ...ghostBase(g.key), data: { cacheId: g.row.id, name: g.row.name, failed: false, unsaved: false, ...extra },
      });
    } else if (g.kind === 'workflow') {
      nodes.push({
        id, type: 'workflow', position: { ...(g.row.at ?? { x: 0, y: 0 }) }, width: TRIANGLE_W, height: TRIANGLE_H, style: { width: TRIANGLE_W, height: TRIANGLE_H },
        handles: TRIANGLE_HANDLES, ...ghostBase(g.key),
        data: { workflowId: g.row.id, name: g.row.name, status: 'stopped', hue: null, problems: 0, failed: false, unsaved: false, ...extra },
      });
    }
  }
  for (const g of ghosts) {
    const id = ghostId(g.key);
    const pick = pickOf(id);
    const extra = { ghost: true, ghostKey: g.key, ...(pick ? { pick } : {}) };
    if (g.kind === 'wire') {
      const source = endOf('step', g.from), target = endOf('step', g.to);
      if (!source || !target) continue;
      edges.push({ id, type: 'wire', source, sourceHandle: 'out', target, targetHandle: 'in', ...ghostBase(g.key), data: { condition: g.condition, from: g.from, to: g.to, running: false, ...extra } });
    } else if (g.kind === 'entry') {
      const source = endOf('workflow', g.workflowId), target = endOf('step', g.stepId);
      if (!source || !target) continue;
      edges.push({ id, type: 'entry', source, sourceHandle: 'tip', target, targetHandle: 'in', ...ghostBase(g.key), data: { workflowId: g.workflowId, stepId: g.stepId, hue: null, running: false, ...(g.cron ? { cron: g.cron } : {}), ...extra } });
    } else if (g.kind === 'cacheLink') {
      const source = endOf('workflow', g.workflowId), target = endOf('cache', g.cacheId);
      if (!source || !target) continue;
      edges.push({ id, type: 'cacheLink', source, sourceHandle: 'back', target, targetHandle: 'in', ...ghostBase(g.key), data: { workflowId: g.workflowId, cacheId: g.cacheId, hue: null, ...extra } });
    }
  }
  return { nodes, edges };
}

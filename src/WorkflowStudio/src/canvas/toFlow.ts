import { Position, type NodeHandle } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { CACHE_H, CACHE_W, PMID, SPHERE_R, STEP_H, STEP_W } from '../layout/geometry';
import { tetherPoints } from '../layout/wires';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { assignmentByStep, payloadKeyCount } from '../model/assignments';
import { conditionInfo } from '../model/entryConditions';
import type { Graph, Id, Processor, Step } from '../model/graph';
import type { CableEdgeType } from './edges/CableEdge';
import type { TetherEdgeType } from './edges/TetherEdge';
import { FONT, type FittedText, type TextFitter } from './fitText';
import type { CacheNodeType } from './nodes/CacheNode';
import type { ProcessorView, StepNodeType } from './nodes/StepNode';
import type { WorkflowNodeType } from './nodes/WorkflowNode';

export type StudioNode = WorkflowNodeType | StepNodeType | CacheNodeType;
export type StudioEdge = CableEdgeType | TetherEdgeType;

export const SPHERE_NODE_ID = 'wf';
export const cacheNodeId = (id: Id) => `cache:${id}`;

const handle = (id: string, type: 'source' | 'target', position: Position, x: number, y: number): NodeHandle =>
  ({ id, type, position, x, y, width: 1, height: 1 });

/**
 * The opened document as React Flow nodes and edges. Pure: every label is fitted here (with the
 * injected fitter), and every node carries explicit width, height and handle geometry, so React
 * Flow draws edges without measuring the DOM. Edges carry their routed points; the handles exist
 * only so React Flow accepts the edge.
 */
export function toFlow(doc: StudioDocument, fitter: TextFitter): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const { graph, placement, wires } = doc;
  const parked = new Set(doc.parkedIds);
  const assignments = assignmentByStep(graph.assignments);

  const ins = new Map<Id, number[]>(), outs = new Map<Id, number[]>();
  for (const w of wires) {
    const last = w.points[w.points.length - 1]!, first = w.points[0]!;
    const target = placement.steps.get(w.target)!;
    ins.set(w.target, [...(ins.get(w.target) ?? []), last[1] - target.y]);
    if (w.source !== WORKFLOW_SOURCE) {
      const source = placement.steps.get(w.source)!;
      outs.set(w.source, [...(outs.get(w.source) ?? []), first[1] - source.y]);
    }
  }

  const nodes: StudioNode[] = [];
  const { cx, cy } = placement.sphere;
  nodes.push({
    id: SPHERE_NODE_ID, type: 'workflow', position: { x: cx - SPHERE_R, y: cy - SPHERE_R },
    width: 2 * SPHERE_R, height: 2 * SPHERE_R, draggable: false, selectable: false,
    handles: [handle('out', 'source', Position.Right, 2 * SPHERE_R, SPHERE_R), handle('down', 'source', Position.Bottom, SPHERE_R, 2 * SPHERE_R)],
    data: sphereLabel(graph.workflow.name, fitter),
  });

  for (const [id, position] of placement.steps) {
    const step = graph.steps.get(id);
    if (!step) continue;
    nodes.push({
      id, type: 'step', position, width: STEP_W, height: STEP_H, draggable: false, selectable: false,
      handles: [handle('in', 'target', Position.Left, 0, PMID), handle('out', 'source', Position.Right, STEP_W, PMID)],
      data: {
        ...stepLabels(step, parked.has(id), fitter),
        letter: conditionInfo(step.entryCondition).letter,
        colour: conditionInfo(step.entryCondition).colour,
        assignment: badge(assignments.get(id)?.payload),
        fanIn: ins.get(id)?.length ?? 0,
        ins: ins.get(id) ?? [],
        outs: outs.get(id) ?? [],
        processor: processorView(graph.processors.get(step.processorId), graph, fitter),
      },
    });
  }

  for (const [id, position] of placement.caches) {
    const cache = graph.caches.get(id);
    if (!cache) continue;
    const count = payloadKeyCount(cache.items);
    nodes.push({
      id: cacheNodeId(id), type: 'cache', position, width: CACHE_W, height: CACHE_H, draggable: false, selectable: false,
      handles: [handle('in', 'target', Position.Top, CACHE_W / 2, 0)],
      data: {
        name: fitter.fit(cache.name, CACHE_W - 12 - 52, FONT.cacheName),
        sub: fitter.fit(`root ${cache.root} · ${count ?? '?'} items`, CACHE_W - 12 - 52, FONT.cacheSub),
      },
    });
  }

  const edges: StudioEdge[] = wires.map((w) => ({
    id: w.id, type: 'cable', source: w.source === WORKFLOW_SOURCE ? SPHERE_NODE_ID : w.source, target: w.target,
    sourceHandle: 'out', targetHandle: 'in', selectable: false, focusable: false,
    data: { points: w.points, colour: conditionInfo(w.condition).colour, broken: w.broken },
  }));
  for (const [id, position] of placement.caches) {
    if (!graph.caches.has(id)) continue;
    edges.push({
      id: `tether:${id}`, type: 'tether', source: SPHERE_NODE_ID, target: cacheNodeId(id),
      sourceHandle: 'down', targetHandle: 'in', selectable: false, focusable: false,
      data: { points: tetherPoints(placement.sphere, position) },
    });
  }

  return { nodes, edges };
}

function badge(payload: string | undefined): string | null {
  if (payload === undefined) return null;
  const n = payloadKeyCount(payload);
  if (n === null) return '◆ ?';
  return n === 0 ? '◇ {}' : `◆ ${n} key${n > 1 ? 's' : ''}`;
}

function stepLabels(step: Step, parked: boolean, fitter: TextFitter): { name: FittedText; version: FittedText; parked: boolean } {
  const versionX = parked ? 60 : 44;
  return {
    name: fitter.fit(step.name, STEP_W - 12 - 34, FONT.stepName),
    version: fitter.fit(`v${step.version}`, STEP_W - versionX - 74, FONT.stepVersion),
    parked,
  };
}

const ROOM = 152 - 16; // the die's inner width

function processorView(p: Processor | undefined, graph: Graph, fitter: TextFitter): ProcessorView {
  const name = p?.name ?? '(missing processor)';
  const version = p?.version ?? '';
  const titleFont = FONT.processorTitle, rowFont = FONT.processorRow;
  const fitsWithVersion = version !== '' && fitter.width(`${name} ${version}`, titleFont) <= ROOM;
  const schemaLabel = (id: Id | null | undefined) => {
    if (!id) return null;
    const s = graph.schemas.get(id);
    return s ? s.name : id;
  };
  const row = (label: string, id: Id | null | undefined) => {
    const value = schemaLabel(id);
    return { label, value: value === null ? null : fitter.fit(value, ROOM - fitter.width(label, rowFont), rowFont) };
  };
  const tip = (label: string, id: Id | null | undefined) => {
    const s = id ? graph.schemas.get(id) : undefined;
    return `${label} ${id ? (s ? `${s.name} ${s.version}` : id) : '∅'}`;
  };

  return {
    title: fitsWithVersion ? { text: name, full: name, cut: false } : fitter.fit(name, ROOM, titleFont),
    version: fitsWithVersion ? version : null,
    rows: [row('in  ', p?.inputSchemaId), row('out ', p?.outputSchemaId), row('cfg ', p?.configSchemaId)],
    inputLit: !!p?.inputSchemaId,
    outputLit: !!p?.outputSchemaId,
    tooltip: [`${name} ${version}`.trim(), tip('in ', p?.inputSchemaId), tip('out', p?.outputSchemaId), tip('cfg', p?.configSchemaId)].join('\n'),
  };
}

/** Splits after `-`, `_` and `.` into at most three lines, each fitted to the sphere's chord. */
function sphereLabel(name: string, fitter: TextFitter): { lines: string[]; full: string; cut: boolean } {
  const font = FONT.sphere;
  const chord = (dy: number) => 2 * Math.sqrt(Math.max(0, (SPHERE_R - 16) ** 2 - dy * dy));
  const parts: string[] = [];
  let current = '';
  for (const segment of name.split(/(?<=[-_.])/)) {
    if (current && fitter.width(current + segment, font) > chord(16)) { parts.push(current); current = segment; }
    else current += segment;
  }
  parts.push(current);
  if (parts.length > 3) parts.splice(2, parts.length - 2, parts.slice(2).join(''));

  let cut = false;
  const lines = parts.map((line, k) => {
    const dy = (k - (parts.length - 1) / 2) * 16;
    const fitted = fitter.fit(line, chord(Math.abs(dy) + 8), font);
    cut = cut || fitted.cut;
    return fitted.text;
  });
  return { lines, full: name, cut };
}

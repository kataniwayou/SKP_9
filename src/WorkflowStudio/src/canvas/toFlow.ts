import { Position, type NodeHandle } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { CACHE_H, CACHE_W, PMID, SPHERE_R, STEP_H, STEP_W } from '../layout/geometry';
import { tetherPoints } from '../layout/wires';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { assignmentByStep, payloadKeyCount } from '../model/assignments';
import { conditionInfo } from '../model/entryConditions';
import { entityName } from '../model/entityNames';
import type { Cache, Graph, Id, Processor, Step } from '../model/graph';
import type { CableEdgeType } from './edges/CableEdge';
import type { TetherEdgeType } from './edges/TetherEdge';
import { createTextFitter, FONT, type FittedText, type TextFitter } from './fitText';
import type { CacheNodeData, CacheNodeType } from './nodes/CacheNode';
import type { ProcessorView, StepNodeType } from './nodes/StepNode';
import { PILL_STATE, PILL_W, type WorkflowNodeType } from './nodes/WorkflowNode';

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
    data: hubData(graph.workflow, fitter),
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
    nodes.push({
      id: cacheNodeId(id), type: 'cache', position, width: CACHE_W, height: CACHE_H, draggable: false, selectable: false,
      handles: [handle('in', 'target', Position.Top, CACHE_W / 2, 0)],
      data: cacheData(cache, fitter),
    });
  }

  const edges: StudioEdge[] = wires.map((w, i) => ({
    id: w.id, type: 'cable', source: w.source === WORKFLOW_SOURCE ? SPHERE_NODE_ID : w.source, target: w.target,
    sourceHandle: 'out', targetHandle: 'in', selectable: false, focusable: false,
    // the gallery staggers its pulses by 0.41 s a wire; `|| 0` keeps the first one at +0, not -0
    data: { points: w.points, colour: conditionInfo(w.condition).colour, broken: w.broken, delay: -Math.round(i * 41) / 100 || 0 },
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
  const versionX = parked ? 56 : 42;
  return {
    name: fitter.fit(step.name, STEP_W - 12 - 34, FONT.stepName),
    version: fitter.fit(`v${step.version}`, STEP_W - versionX - 74, FONT.stepVersion),
    parked,
  };
}

/** Room inside the cache frame (mockup v50 drawCacheTag): a name line (and the CACHE · v line), the root, and the plate. */
const CACHE_NAME_ROOM = 132, CACHE_ROOT_ROOM = 112, PLATE_MAX = 128;
/** The CACHE · v line's letter spacing (art.css `.nx-cl`: .2em of 8 px), added after every character. */
const CACHE_LABEL_SPACING = 0.2 * 8;

/** The cache's name split after `-`, `_` and `.` onto at most two lines, each fitted; the root fitted to its plate. */
function cacheData(cache: Cache, fitter: TextFitter): CacheNodeData {
  const font = FONT.cacheName;
  const parts: string[] = [];
  let current = '';
  for (const segment of cache.name.split(/(?<=[-_.])/)) {
    if (current && fitter.width(current + segment, font) > CACHE_NAME_ROOM) { parts.push(current); current = segment; }
    else current += segment;
  }
  parts.push(current);
  if (parts.length > 2) parts.splice(1, parts.length - 1, parts.slice(1).join(''));
  const root = fitter.fit(cache.root, CACHE_ROOT_ROOM, FONT.cacheRoot);
  // a canvas measurement leaves out CSS letter spacing, so add it for each character
  const spaced = createTextFitter((text, f) => fitter.width(text, f) + CACHE_LABEL_SPACING * Array.from(text).length);
  return {
    lines: parts.map((line) => fitter.fit(line, CACHE_NAME_ROOM, font).text),
    versionLine: spaced.fit(`CACHE · v${cache.version}`, CACHE_NAME_ROOM, FONT.cacheLabel),
    root,
    plateWidth: Math.min(PLATE_MAX, fitter.width(root.text, FONT.cacheRoot) + 22),
    tooltip: `${cache.name} ${cache.version}\nroot ${cache.root}`,
  };
}

/** Room on the processor panel (mockup v50 drawChip): the title line, and a slot's value after its label. */
const TITLE_ROOM = 92;
const VALUE_ROOM = 76;

function processorView(p: Processor | undefined, graph: Graph, fitter: TextFitter): ProcessorView {
  const name = p?.name ?? '(missing processor)';
  const version = p?.version ?? '';
  // the name is drawn in the title face and the version after it in 9 px mono (Chip .nx-pv), so each is measured in its own
  const fitsWithVersion = version !== ''
    && fitter.width(name, FONT.processorTitle) + fitter.width(` ${version}`, FONT.processorRow) <= TITLE_ROOM;
  const schemaLabel = (id: Id | null | undefined) => {
    if (!id) return null;
    const s = graph.schemas.get(id);
    return s ? s.name : id;
  };
  const row = (label: string, id: Id | null | undefined) => {
    const value = schemaLabel(id);
    return { label, value: value === null ? null : fitter.fit(value, VALUE_ROOM, FONT.processorRow) };
  };
  const tip = (label: string, id: Id | null | undefined) => {
    const s = id ? graph.schemas.get(id) : undefined;
    return `${label} ${id ? (s ? `${s.name} ${s.version}` : id) : '∅'}`;
  };

  return {
    processorId: p?.id ?? '',
    title: fitsWithVersion ? { text: name, full: name, cut: false } : fitter.fit(name, TITLE_ROOM, FONT.processorTitle),
    version: fitsWithVersion ? version : null,
    rows: [row('in', p?.inputSchemaId), row('out', p?.outputSchemaId), row('cfg', p?.configSchemaId)],
    inputLit: !!p?.inputSchemaId,
    outputLit: !!p?.outputSchemaId,
    tooltip: [`${name} ${version}`.trim(), tip('in ', p?.inputSchemaId), tip('out', p?.outputSchemaId), tip('cfg', p?.configSchemaId)].join('\n'),
  };
}

/** The hub's tooltip and its pill's cron, cut to the room the state text leaves (gallery wfPill). */
function hubData(workflow: Graph['workflow'], fitter: TextFitter): { tip: string; cron: FittedText } {
  const room = PILL_W - 24 - fitter.width(PILL_STATE, FONT.hubPill);
  return {
    tip: entityName(workflow.name, workflow.version, workflow.id),
    cron: fitter.fit(`⏱ ${workflow.cronExpression || 'not scheduled'}`, room, FONT.hubPill),
  };
}

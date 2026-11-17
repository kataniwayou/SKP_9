import { useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useStore, type EdgeChange, type EdgeTypes, type Node, type NodeChange, type NodeTypes, type Viewport } from '@xyflow/react';
import { HEADER_H, ZOOM_DETAIL } from './geometry';
import type { BoardWorkflow } from './loadBoard';
import { pickKey, type Pick } from './picks';
import { toFlow } from './toFlow';
import { LinkWire } from './edges/LinkWire';
import { CacheChip } from './nodes/CacheChip';
import { dropVerdictItem, stepAt, type DropItem } from './dropTarget';
import { StepCard } from './nodes/StepCard';
import { WorkflowFrame } from './nodes/WorkflowFrame';
import { useLive, useLiveStore } from '../live/LiveContext';
import { statusOf } from '../live/liveState';
import { STATE_COLOUR } from './live/StateBadge';
import { BoardContext, EditContext, ToolbarContext, type ToolbarActions } from './nodes/boardContext';
import './board.css';

const nodeTypes: NodeTypes = { workflow: WorkflowFrame, step: StepCard, cache: CacheChip };
const edgeTypes: EdgeTypes = { link: LinkWire };

/** Inside the flow: reports when the zoom crosses ZOOM_DETAIL (the selector is a boolean, so only then). */
function FarWatch({ onFar }: { onFar: (far: boolean) => void }) {
  const far = useStore((s) => s.transform[2] < ZOOM_DETAIL);
  useEffect(() => { onFar(far); }, [far, onFar]);
  return null;
}

export interface BoardEdit {
  moveStep(wf: string, step: string, at: { x: number; y: number }): void;
  moveFrame(wf: string, at: { x: number; y: number }): void;
  /** `at` is given when the resize also moved the frame's top-left corner (one history step for both). */
  resizeFrame(wf: string, size: { w: number; h: number }, at?: { x: number; y: number }): void;
  /** `to` is null when the wire was dropped on nothing (or on something that is not a step). */
  connect(fromWf: string, from: string, toWf: string | null, to: string | null): void;
}

interface NodeData { workflowId: string; stepId?: string; cacheId?: string }

export interface BoardProps {
  workflows: BoardWorkflow[];
  /** Everything picked, in pick order. */
  picks: Pick[];
  /** `additive` is true while Ctrl or Meta is held; null means a click on empty board. */
  onPick: (p: Pick | null, additive: boolean) => void;
  /** Tests and view restore: start at this zoom instead of fitting every frame. */
  initialZoom?: number;
  /** View restore: start here instead of fitting every frame. */
  initialView?: { x: number; y: number; zoom: number };
  /** The viewport after each pan or zoom, and when something is selected. */
  onViewChange?: (view: { x: number; y: number; zoom: number }) => void;
  /** Without it the board is read-only. */
  onEdit?: BoardEdit;
  /** Save, Delete and the unsaved/problems status; without it no toolbars show. */
  toolbar?: ToolbarActions;
  /** A toolbox item was dropped; `at` is in board coordinates. */
  onDropItem?: (item: DropItem, at: { x: number; y: number }) => void;
}

export function Board({ workflows, picks, onPick, initialZoom, initialView, onViewChange, onEdit, toolbar, onDropItem }: BoardProps) {
  const flow = useRef<{ getViewport: () => Viewport; screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number } } | null>(null);
  const select = (s: Pick | null, additive = false) => {
    if (flow.current) onViewChange?.(flow.current.getViewport());
    onPick(s, additive);
  };
  // React Flow's own selection is off: picks decide. Only a keyboard select (Enter/Space on a focused node) comes from it.
  const keySelect = useRef(false);
  const live = useLiveStore();
  useLive((st) => st.running); // re-render the minimap strokes when a workflow starts or stops
  useLive((st) => st.workflows);
  // Far out the step cards render nothing; their wrappers must not catch clicks meant for the frame.
  const [far, setFar] = useState(false);
  const byId = useMemo(() => new Map(workflows.map((w) => [w.graph.workflow.id, w])), [workflows]);
  const editable = onEdit !== undefined;
  const { nodes: derived, edges } = useMemo(() => {
    const flow = toFlow(workflows);
    const order = new Map(picks.map((p, i) => [pickKey(p), i + 1]));
    const pickOf = (id: string) => { const no = order.get(id); return no === undefined ? undefined : { no, solo: picks.length === 1 }; };
    return {
      nodes: flow.nodes.map((n) => ({
        ...n,
        data: { ...n.data, ...(pickOf(n.id) ? { pick: pickOf(n.id) } : {}), ...(editable && n.type === 'workflow' ? { editable: true } : {}) },
        ...(editable && n.type !== 'cache' ? { draggable: true } : {}),
        ...(far && n.type === 'step' ? { style: { ...n.style, pointerEvents: 'none' as const } } : {}),
        selected: order.has(n.id),
      })),
      // far out the step cards draw no handles: React Flow would warn for every wire it cannot place
      edges: flow.edges.map((e) => ({ ...e, hidden: far, selected: order.has(e.id), data: { ...e.data, ...(pickOf(e.id) ? { pick: pickOf(e.id) } : {}) } })),
    };
  }, [workflows, picks, far, editable]);

  // Editing: React Flow needs the nodes in state so a drag moves them before anything is committed.
  const [dragged, setDragged] = useState<Node[]>(derived);
  const derivedRef = useRef(derived);
  derivedRef.current = derived;
  useEffect(() => { setDragged(derived); }, [derived]);
  const nodes = editable ? dragged : derived;
  const nodePick = (n: { type?: string | undefined; data: unknown }): Pick => {
    const d = n.data as NodeData;
    return n.type === 'cache' && d.cacheId !== undefined ? { kind: 'cache', workflowId: d.workflowId, cacheId: d.cacheId }
      : n.type === 'step' && d.stepId !== undefined ? { kind: 'step', workflowId: d.workflowId, stepId: d.stepId }
      : { kind: 'workflow', workflowId: d.workflowId };
  };
  const onNodesChange = (changes: NodeChange[]) => {
    if (keySelect.current) {
      const id = changes.flatMap((c) => (c.type === 'select' && c.selected ? [c.id] : []))[0];
      const n = id === undefined ? undefined : nodes.find((x) => x.id === id);
      if (n) { keySelect.current = false; select(nodePick(n)); }
    }
    setDragged((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'select'), ns));
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!keySelect.current) return;
    const id = changes.flatMap((c) => (c.type === 'select' && c.selected ? [c.id] : []))[0];
    const e = id === undefined ? undefined : edges.find((x) => x.id === id);
    if (e) { keySelect.current = false; const d = e.data as { workflowId: string; wireId: string }; select({ kind: 'wire', workflowId: d.workflowId, wireId: d.wireId }); }
  };
  const dataOf = (n: Node) => n.data as unknown as NodeData;

  const dragStop = (n: Node, dragged?: Node[]) => {
    if (!onEdit) return;
    // React Flow drags every selected node together; commit each one that moved
    if (dragged && dragged.length > 1) { for (const m of dragged) commitMove(m); setDragged(derivedRef.current); return; }
    commitMove(n);
    setDragged(derivedRef.current); // a refused or unchanged drag snaps back
  };
  const commitMove = (n: Node) => {
    if (!onEdit) return;
    const d = dataOf(n);
    const w = byId.get(d.workflowId);
    if (w) {
      if (n.type === 'step' && d.stepId !== undefined) {
        const cur = w.stepAt.get(d.stepId);
        const at = { x: n.position.x, y: n.position.y - HEADER_H };
        if (!cur || cur.x !== at.x || cur.y !== at.y) onEdit.moveStep(d.workflowId, d.stepId, at);
      } else if (n.type === 'workflow') {
        if (w.frame.x !== n.position.x || w.frame.y !== n.position.y) onEdit.moveFrame(d.workflowId, { x: n.position.x, y: n.position.y });
      }
    }
  };
  const nodeById = (id: string) => nodes.find((x) => x.id === id);

  return (
    <BoardContext.Provider value={byId}>
      <EditContext.Provider value={onEdit ?? null}>
      <ToolbarContext.Provider value={editable ? toolbar ?? null : null}>
      <div className="board" onKeyDownCapture={(e) => { if (e.key === 'Enter' || e.key === ' ') { keySelect.current = true; queueMicrotask(() => { keySelect.current = false; }); } }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={editable}
          nodesConnectable={editable}
          {...(editable ? {
            onNodesChange,
            onNodeDragStop: (_: unknown, n: Node, all?: Node[]) => dragStop(n, all),
            onConnect: (c: { source: string; target: string }) => {
              if (!onEdit) return;
              const a = nodeById(c.source);
              const b = nodeById(c.target);
              if (!a || !b || a.type !== 'step' || b.type !== 'step') return;
              onEdit.connect(dataOf(a).workflowId, dataOf(a).stepId!, dataOf(b).workflowId, dataOf(b).stepId!);
            },
            onConnectEnd: (e: MouseEvent | TouchEvent, st: { isValid: boolean | null; fromNode: Node | null; toNode: Node | null }) => {
              if (!onEdit) return;
              if (st.isValid === true || !st.fromNode || st.fromNode.type !== 'step') return; // reported through onConnect
              const from = dataOf(st.fromNode);
              // React Flow only finds a step near one of its handles: a drop on the card's body is found here
              const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
              const hit = pt && flow.current ? stepAt(workflows, flow.current.screenToFlowPosition({ x: pt.clientX, y: pt.clientY })) : null;
              if (hit) { onEdit.connect(from.workflowId, from.stepId!, hit.workflowId, hit.stepId); return; }
              // dropped on a step's other handle: still that step
              if (st.toNode && st.toNode.type === 'step') {
                const to = dataOf(st.toNode);
                onEdit.connect(from.workflowId, from.stepId!, to.workflowId, to.stepId!);
                return;
              }
              onEdit.connect(from.workflowId, from.stepId!, null, null);
            },
          } : {})}
          elementsSelectable
          minZoom={0.05}
          maxZoom={2}
          {...(initialView !== undefined ? { defaultViewport: initialView }
            : initialZoom !== undefined ? { defaultViewport: { x: 0, y: 0, zoom: initialZoom } } : { fitView: true })}
          onDragOver={(e) => { if (editable && onDropItem) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
          onDrop={(e) => {
            if (!editable || !onDropItem || !flow.current) return;
            const item = dropVerdictItem(e.dataTransfer.getData('application/acto'));
            if (!item) return;
            e.preventDefault();
            onDropItem(item, flow.current.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
          onInit={(rf) => { flow.current = rf; }}
          onMoveEnd={(_, v) => onViewChange?.(v)}
          multiSelectionKeyCode={null}
          onEdgesChange={onEdgesChange}
          {...(!editable ? { onNodesChange } : {})}
          onNodeClick={(ev, n) => { keySelect.current = false; select(nodePick(n), ev.ctrlKey || ev.metaKey); }}
          onEdgeClick={(ev, e) => {
            keySelect.current = false;
            const d = e.data as { workflowId: string; wireId: string };
            select({ kind: 'wire', workflowId: d.workflowId, wireId: d.wireId }, ev.ctrlKey || ev.metaKey);
          }}
          onPaneClick={(ev) => select(null, ev.ctrlKey || ev.metaKey)}
          proOptions={{ hideAttribution: true }}
        >
          <FarWatch onFar={setFar} />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap pannable zoomable nodeStrokeColor={(n) => {
            if (n.type !== 'workflow') return 'transparent';
            return STATE_COLOUR[statusOf(live.getState(), (n.data as { workflowId: string }).workflowId)];
          }} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      </ToolbarContext.Provider>
      </EditContext.Provider>
    </BoardContext.Provider>
  );
}

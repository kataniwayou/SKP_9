import { useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useStore, type EdgeTypes, type Node, type NodeChange, type NodeTypes, type Viewport } from '@xyflow/react';
import { HEADER_H, ZOOM_DETAIL } from './geometry';
import type { BoardWorkflow } from './loadBoard';
import type { Selection } from './selection';
import { toFlow } from './toFlow';
import { LinkWire } from './edges/LinkWire';
import { StepCard } from './nodes/StepCard';
import { WorkflowFrame } from './nodes/WorkflowFrame';
import { useLive, useLiveStore } from '../live/LiveContext';
import { statusOf } from '../live/liveState';
import { STATE_COLOUR } from './live/StateBadge';
import { BoardContext, EditContext } from './nodes/boardContext';
import './board.css';

const nodeTypes: NodeTypes = { workflow: WorkflowFrame, step: StepCard };
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

interface NodeData { workflowId: string; stepId?: string }

export interface BoardProps {
  workflows: BoardWorkflow[];
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  /** Tests and view restore: start at this zoom instead of fitting every frame. */
  initialZoom?: number;
  /** View restore: start here instead of fitting every frame. */
  initialView?: { x: number; y: number; zoom: number };
  /** The viewport after each pan or zoom, and when something is selected. */
  onViewChange?: (view: { x: number; y: number; zoom: number }) => void;
  /** Without it the board is read-only. */
  onEdit?: BoardEdit;
}

export function Board({ workflows, selection, onSelect, initialZoom, initialView, onViewChange, onEdit }: BoardProps) {
  const flow = useRef<{ getViewport: () => Viewport } | null>(null);
  const select = (s: Selection | null) => {
    if (flow.current) onViewChange?.(flow.current.getViewport());
    onSelect(s);
  };
  const live = useLiveStore();
  useLive((st) => st.running); // re-render the minimap strokes when a workflow starts or stops
  useLive((st) => st.workflows);
  // Far out the step cards render nothing; their wrappers must not catch clicks meant for the frame.
  const [far, setFar] = useState(false);
  const byId = useMemo(() => new Map(workflows.map((w) => [w.graph.workflow.id, w])), [workflows]);
  const editable = onEdit !== undefined;
  const { nodes: derived, edges } = useMemo(() => {
    const flow = toFlow(workflows);
    const sel = selection;
    return {
      nodes: flow.nodes.map((n) => ({
        ...n,
        ...(editable ? { draggable: true } : {}),
        ...(editable && n.type === 'workflow' ? { data: { ...n.data, editable: true } } : {}),
        ...(far && n.type === 'step' ? { style: { ...n.style, pointerEvents: 'none' as const } } : {}),
        selected: sel !== null && (
          (sel.kind === 'workflow' && n.id === `wf:${sel.workflowId}`) ||
          (sel.kind === 'step' && n.id === `st:${sel.workflowId}:${sel.stepId}`)),
      })),
      edges: flow.edges.map((e) => ({ ...e, selected: sel?.kind === 'wire' && e.id === `wi:${sel.workflowId}:${sel.wireId}` })),
    };
  }, [workflows, selection, far, editable]);

  // Editing: React Flow needs the nodes in state so a drag moves them before anything is committed.
  const [dragged, setDragged] = useState<Node[]>(derived);
  const derivedRef = useRef(derived);
  derivedRef.current = derived;
  useEffect(() => { setDragged(derived); }, [derived]);
  const nodes = editable ? dragged : derived;
  const onNodesChange = (changes: NodeChange[]) => setDragged((ns) => applyNodeChanges(changes, ns));
  const dataOf = (n: Node) => n.data as unknown as NodeData;

  const dragStop = (n: Node) => {
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
    setDragged(derivedRef.current); // a refused or unchanged drag snaps back
  };
  const nodeById = (id: string) => nodes.find((x) => x.id === id);

  return (
    <BoardContext.Provider value={byId}>
      <EditContext.Provider value={onEdit ?? null}>
      <div className="board">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={editable}
          nodesConnectable={editable}
          {...(editable ? {
            onNodesChange,
            onNodeDragStop: (_: unknown, n: Node) => dragStop(n),
            onConnect: (c: { source: string; target: string }) => {
              if (!onEdit) return;
              const a = nodeById(c.source);
              const b = nodeById(c.target);
              if (!a || !b || a.type !== 'step' || b.type !== 'step') return;
              onEdit.connect(dataOf(a).workflowId, dataOf(a).stepId!, dataOf(b).workflowId, dataOf(b).stepId!);
            },
            onConnectEnd: (_: unknown, st: { isValid: boolean | null; fromNode: Node | null; toNode: Node | null }) => {
              if (!onEdit) return;
              if (st.isValid === true || !st.fromNode || st.fromNode.type !== 'step') return;
              if (st.toNode && st.toNode.type === 'step') return; // landed on a step; React Flow reports it through onConnect
              onEdit.connect(dataOf(st.fromNode).workflowId, dataOf(st.fromNode).stepId!, null, null);
            },
          } : {})}
          elementsSelectable
          minZoom={0.05}
          maxZoom={2}
          {...(initialView !== undefined ? { defaultViewport: initialView }
            : initialZoom !== undefined ? { defaultViewport: { x: 0, y: 0, zoom: initialZoom } } : { fitView: true })}
          onInit={(rf) => { flow.current = rf; }}
          onMoveEnd={(_, v) => onViewChange?.(v)}
          onNodeClick={(_, n) => {
            const d = n.data as { workflowId: string; stepId?: string };
            select(n.type === 'step' && d.stepId !== undefined
              ? { kind: 'step', workflowId: d.workflowId, stepId: d.stepId }
              : { kind: 'workflow', workflowId: d.workflowId });
          }}
          onEdgeClick={(_, e) => {
            const d = e.data as { workflowId: string; wireId: string };
            select({ kind: 'wire', workflowId: d.workflowId, wireId: d.wireId });
          }}
          onPaneClick={() => select(null)}
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
      </EditContext.Provider>
    </BoardContext.Provider>
  );
}

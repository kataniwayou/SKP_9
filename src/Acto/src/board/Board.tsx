import { useMemo, useRef } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type EdgeTypes, type NodeTypes, type Viewport } from '@xyflow/react';
import type { BoardWorkflow } from './loadBoard';
import type { Selection } from './selection';
import { toFlow } from './toFlow';
import { LinkWire } from './edges/LinkWire';
import { StepCard } from './nodes/StepCard';
import { WorkflowFrame } from './nodes/WorkflowFrame';
import { useLive, useLiveStore } from '../live/LiveContext';
import { statusOf } from '../live/liveState';
import { STATE_COLOUR } from './live/StateBadge';
import { BoardContext } from './nodes/boardContext';
import './board.css';

const nodeTypes: NodeTypes = { workflow: WorkflowFrame, step: StepCard };
const edgeTypes: EdgeTypes = { link: LinkWire };

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
}

export function Board({ workflows, selection, onSelect, initialZoom, initialView, onViewChange }: BoardProps) {
  const flow = useRef<{ getViewport: () => Viewport } | null>(null);
  const select = (s: Selection | null) => {
    if (flow.current) onViewChange?.(flow.current.getViewport());
    onSelect(s);
  };
  const live = useLiveStore();
  useLive((st) => st.running); // re-render the minimap strokes when a workflow starts or stops
  useLive((st) => st.workflows);
  const byId = useMemo(() => new Map(workflows.map((w) => [w.graph.workflow.id, w])), [workflows]);
  const { nodes, edges } = useMemo(() => {
    const flow = toFlow(workflows);
    const sel = selection;
    return {
      nodes: flow.nodes.map((n) => ({
        ...n,
        selected: sel !== null && (
          (sel.kind === 'workflow' && n.id === `wf:${sel.workflowId}`) ||
          (sel.kind === 'step' && n.id === `st:${sel.workflowId}:${sel.stepId}`)),
      })),
      edges: flow.edges.map((e) => ({ ...e, selected: sel?.kind === 'wire' && e.id === `wi:${sel.workflowId}:${sel.wireId}` })),
    };
  }, [workflows, selection]);

  return (
    <BoardContext.Provider value={byId}>
      <div className="board">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
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
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap pannable zoomable nodeStrokeColor={(n) => {
            if (n.type !== 'workflow') return 'transparent';
            return STATE_COLOUR[statusOf(live.getState(), (n.data as { workflowId: string }).workflowId)];
          }} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </BoardContext.Provider>
  );
}

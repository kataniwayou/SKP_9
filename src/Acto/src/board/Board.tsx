import { useMemo } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type EdgeTypes, type NodeTypes } from '@xyflow/react';
import type { BoardWorkflow } from './loadBoard';
import type { Selection } from './selection';
import { toFlow } from './toFlow';
import { LinkWire } from './edges/LinkWire';
import { StepCard } from './nodes/StepCard';
import { WorkflowFrame } from './nodes/WorkflowFrame';
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
}

export function Board({ workflows, selection, onSelect, initialZoom }: BoardProps) {
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
          {...(initialZoom === undefined ? { fitView: true } : { defaultViewport: { x: 0, y: 0, zoom: initialZoom } })}
          onNodeClick={(_, n) => {
            const d = n.data as { workflowId: string; stepId?: string };
            onSelect(n.type === 'step' && d.stepId !== undefined
              ? { kind: 'step', workflowId: d.workflowId, stepId: d.stepId }
              : { kind: 'workflow', workflowId: d.workflowId });
          }}
          onEdgeClick={(_, e) => {
            const d = e.data as { workflowId: string; wireId: string };
            onSelect({ kind: 'wire', workflowId: d.workflowId, wireId: d.wireId });
          }}
          onPaneClick={() => onSelect(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </BoardContext.Provider>
  );
}

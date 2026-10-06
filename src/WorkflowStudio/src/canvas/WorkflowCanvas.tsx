import { useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, type EdgeTypes, type NodeTypes } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { CableEdge } from './edges/CableEdge';
import { TetherEdge } from './edges/TetherEdge';
import type { TextFitter } from './fitText';
import { GridBackground } from './GridBackground';
import { Legend } from './Legend';
import { CacheNode } from './nodes/CacheNode';
import { StepNode } from './nodes/StepNode';
import { WorkflowNode } from './nodes/WorkflowNode';
import { toFlow } from './toFlow';

// Defined outside the component, as React Flow requires, so they are not re-created per render.
const nodeTypes: NodeTypes = { workflow: WorkflowNode, step: StepNode, cache: CacheNode };
const edgeTypes: EdgeTypes = { cable: CableEdge, tether: TetherEdge };

interface Props {
  doc: StudioDocument;
  fitter: TextFitter;
  /** Only for tests, where jsdom has no layout. */
  width?: number;
  height?: number;
}

/**
 * The read-only canvas (slice 2). Pan with Space+drag, the middle button or the wheel; Ctrl+wheel
 * zooms at the pointer (spec §5.4). Nothing can be dragged, connected or selected yet.
 */
export function WorkflowCanvas({ doc, fitter, width, height }: Props) {
  const { nodes, edges } = useMemo(() => toFlow(doc, fitter), [doc, fitter]);

  return (
    <ReactFlowProvider key={doc.graph.workflow.id}>
      <div className="studio-canvas" style={{ position: 'relative', width: width ?? '100%', height: height ?? '100%' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          width={width}
          height={height}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.1}
          maxZoom={4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          panOnScroll
          zoomOnScroll={false}
          zoomActivationKeyCode="Control"
          panOnDrag={[1]}
          panActivationKeyCode="Space"
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
        >
          <GridBackground />
        </ReactFlow>
        <Legend />
      </div>
    </ReactFlowProvider>
  );
}

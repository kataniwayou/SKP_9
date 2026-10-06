import { useMemo, useRef, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, type EdgeTypes, type NodeTypes } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import type { Selection } from '../store/selection';
import { CableEdge } from './edges/CableEdge';
import { TetherEdge } from './edges/TetherEdge';
import { FIT_VIEW_OPTIONS } from './fitOptions';
import { FollowFitContext, FollowSize } from './followSize';
import { LiveArtContext, NO_LIVE_ART, type LiveArt } from './liveArt';
import type { TextFitter } from './fitText';
import type { SavedView } from './savedView';
import { GridBackground } from './GridBackground';
import { Legend } from './Legend';
import { ScrollBars } from './ScrollBars';
import { CacheNode } from './nodes/CacheNode';
import { StepNode } from './nodes/StepNode';
import { WorkflowNode } from './nodes/WorkflowNode';
import { selectionFromClick, withSelection } from './selection';
import { toFlow } from './toFlow';

// Defined outside the component, as React Flow requires, so they are not re-created per render.
const nodeTypes: NodeTypes = { workflow: WorkflowNode, step: StepNode, cache: CacheNode };
const edgeTypes: EdgeTypes = { cable: CableEdge, tether: TetherEdge };

export { FIT_VIEW_OPTIONS };

interface Props {
  doc: StudioDocument;
  fitter: TextFitter;
  /** Only for tests, where jsdom has no layout. */
  width?: number;
  height?: number;
  /** The highlighted entity (slice 3a). Omitted: nothing is highlighted. */
  selection?: Selection | null;
  /** Called with what a click selects, or null for a click on empty canvas. Omitted: clicks do nothing. */
  onSelect?: (selection: Selection | null) => void;
  /** What the art shows of the running system; omitted, nothing is started and every processor is undetermined. */
  live?: LiveArt;
  /** Where the view was when the page was left (the session); null, omitted, or still following Fit: fit the workflow. */
  initialView?: SavedView | null;
  /** Called when the view settles after a zoom, pan, fit or resize, for the session. */
  onViewChange?: (view: SavedView) => void;
  /** Drawn over the canvas inside its React Flow provider: the document's toolbar and zoom controls. */
  children?: ReactNode;
}

/** React Flow's attribution badge is hidden (MIT licence): it would sit on the horizontal scroll bar. */
const PRO_OPTIONS = { hideAttribution: true } as const;

/**
 * The workflow canvas. Pan with Space+drag, the middle button or the wheel; Ctrl+wheel zooms at
 * the pointer (spec §5.4). Slice 3a makes it clickable (spec §6.1): a step, a processor die, a
 * cache or the sphere can be selected. Nothing can be dragged or connected, and React Flow's own
 * selection stays off: the selection lives in the store and is drawn with a class.
 */
export function WorkflowCanvas({ doc, fitter, width, height, selection = null, onSelect, live = NO_LIVE_ART, initialView, onViewChange, children }: Props) {
  const { nodes, edges } = useMemo(() => toFlow(doc, fitter), [doc, fitter]);
  const shown = useMemo(() => withSelection(nodes, selection), [nodes, selection]);
  // read once per workflow: the page hands back every view the canvas reports, and a later one must not
  // move the canvas or turn `fitView` on (React Flow queues a fit for the next node change when it does)
  const workflowId = doc.graph.workflow.id;
  const restored = useMemo(() => (initialView && !initialView.followFit ? initialView : null), [workflowId]);
  const followFit = useRef(restored === null);

  return (
    <ReactFlowProvider key={workflowId}>
      <FollowFitContext.Provider value={followFit}>
        <LiveArtContext.Provider value={live}>
          <div className="studio-canvas" style={{ position: 'relative', width: width ?? '100%', height: height ?? '100%' }}>
            <ReactFlow
              nodes={shown}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              width={width}
              height={height}
              colorMode="dark"
              fitView={restored === null}
              defaultViewport={restored ? { x: restored.x, y: restored.y, zoom: restored.zoom } : undefined}
              fitViewOptions={FIT_VIEW_OPTIONS}
              proOptions={PRO_OPTIONS}
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
              onNodeClick={onSelect ? (event, node) => onSelect(selectionFromClick(node, event.target as Element, doc.graph)) : undefined}
              onPaneClick={onSelect ? () => onSelect(null) : undefined}
              onMoveStart={(event) => { if (event) followFit.current = false; }}
              onMoveEnd={onViewChange ? (_event, v) => onViewChange({ x: v.x, y: v.y, zoom: v.zoom, followFit: followFit.current }) : undefined}
            >
              <GridBackground />
            </ReactFlow>
            <FollowSize />
            <ScrollBars />
            <Legend />
            {children}
          </div>
        </LiveArtContext.Provider>
      </FollowFitContext.Provider>
    </ReactFlowProvider>
  );
}

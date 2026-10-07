import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, type EdgeMouseHandler, type EdgeTypes, type NodeMouseHandler, type NodeTypes } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { applyDraft } from '../design/apply';
import { DesignContext } from '../design/DesignContext';
import { DesignOverlay } from '../design/DesignOverlay';
import type { DesignProps } from '../design/designProps';
import { resetRoute, type Draft } from '../design/draft';
import type { GuideLine } from '../design/guides';
import { useBlockDrag } from '../design/useBlockDrag';
import { useDesignKeys } from '../design/useDesignKeys';
import { useRubberBand } from '../design/useRubberBand';
import { useWireGestures } from '../design/useWireGestures';
import { Menu, anchorAt, type Anchor } from '../dock/Menu';
import { togglePick, type Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { GRID } from '../layout/geometry';
import { shapeFromPoints } from '../layout/shape';
import type { WireRoute } from '../layout/wires';
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
import { selectionForPicks, selectionFromClick, withPicks, withSelection } from './selection';
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
  /**
   * Called with what a click selects, or null for a click on empty canvas. Omitted: clicks do nothing.
   * Read-only, it gets that one argument; in design mode also the picks the click or rectangle made.
   */
  onSelect?: (selection: Selection | null, picks?: Pick[]) => void;
  /** What the art shows of the running system; omitted, nothing is started and every processor is undetermined. */
  live?: LiveArt;
  /** Where the view was when the page was left (the session); null, omitted, or still following Fit: fit the workflow. */
  initialView?: SavedView | null;
  /** Called when the view settles after a zoom, pan, fit or resize, for the session. */
  onViewChange?: (view: SavedView) => void;
  /** Drawn over the canvas inside its React Flow provider: the document's toolbar and zoom controls. */
  children?: ReactNode;
  /** Design mode (plan 4); omitted: read-only, as before. */
  design?: DesignProps;
}

/** React Flow's attribution badge is hidden (MIT licence): it would sit on the horizontal scroll bar. */
const PRO_OPTIONS = { hideAttribution: true } as const;

/** Every block's top-left corner lands on the 8 px grid while it is dragged (spec §3.4). */
const SNAP_GRID: [number, number] = [GRID, GRID];
/**
 * A press on a block that moves this many screen pixels or fewer is a click, more is a drag. Both are
 * set: React Flow's drag swallows the click after any movement beyond its click distance (0 by default).
 */
const DRAG_START = 2;

/** Design mode turns off React Flow's own selection keys and keyboard moves: picks live in the store. */
const DESIGN_KEYS = { multiSelectionKeyCode: null, selectionKeyCode: null, disableKeyboardA11y: true } as const;

/**
 * The workflow canvas. Pan with Space+drag, the middle button or the wheel; Ctrl+wheel zooms at
 * the pointer (spec §5.4). Slice 3a makes it clickable (spec §6.1): a step, a processor die, a
 * cache or the sphere can be selected. React Flow's own selection stays off: the selection lives in
 * the store and is drawn with a class. Without `design` nothing can be dragged or connected; with it
 * (plan 4) the canvas shows the draft over the document, and a click, a Ctrl+click or a rectangle on
 * empty canvas picks blocks and wires (spec §3).
 */
export function WorkflowCanvas(props: Props) {
  // a new provider per workflow, so React Flow mounts afresh and fits the new document
  return (
    <ReactFlowProvider key={props.doc.graph.workflow.id}>
      <CanvasBody {...props} />
    </ReactFlowProvider>
  );
}

/** Everything under the provider, so the designer's hooks can use React Flow. */
function CanvasBody({ doc, fitter, width, height, selection = null, onSelect, live = NO_LIVE_ART, initialView, onViewChange, children, design }: Props) {
  // read once per mount (one per workflow): the page hands back every view the canvas reports, and a later
  // one must not move the canvas or turn `fitView` on (React Flow queues a fit for the next node change when it does)
  const [restored] = useState(() => (initialView && !initialView.followFit ? initialView : null));
  const followFit = useRef(restored === null);

  // a gesture's draft while it runs; null: the committed draft is shown
  const [preview, setPreview] = useState<Draft | null>(null);
  const [guides, setGuides] = useState<GuideLine[]>([]);
  const shownDoc = useMemo(() => (design ? applyDraft(doc, preview ?? design.draft) : doc), [doc, design?.draft, preview]);
  const shownRef = useRef(shownDoc);
  shownRef.current = shownDoc;
  const flow = useMemo(() => toFlow(shownDoc, fitter), [shownDoc, fitter]);
  const marked = useMemo(() => (design ? withPicks(flow.nodes, flow.edges, design.picks) : flow), [flow, design?.picks]);
  const shown = useMemo(() => withSelection(marked.nodes, selection), [marked.nodes, selection]);
  const suppressPaneClick = useRef(false);
  const suppressNodeClick = useRef(false);
  const { band, banding, onPointerDownCapture } = useRubberBand(shownRef, design, onSelect, suppressPaneClick);
  const drag = useBlockDrag(doc, shownRef, design, setPreview, setGuides, onSelect, suppressNodeClick);
  const onKeyDown = useDesignKeys(doc, shownRef, design);
  const wiring = useWireGestures(shownRef, design, setPreview);
  // picks naming wires that are gone (after an undo) draw nothing
  const pickedWires = useMemo(
    () => (design ? shownDoc.wires.filter((w) => design.picks.some((p) => p.kind === 'wire' && p.id === w.id)) : []),
    [shownDoc, design?.picks],
  );
  const bendsOf = (w: WireRoute) => design?.draft.routes[w.id]?.bends ?? shapeFromPoints(w.points);
  // the wire's right-click menu (spec §4.3)
  const [menu, setMenu] = useState<{ anchor: Anchor; wireId: string } | null>(null);

  const onNodeClick: NodeMouseHandler = (event, node) => {
    if (!onSelect) return;
    if (suppressNodeClick.current) { suppressNodeClick.current = false; return; }
    const clicked = selectionFromClick(node, event.target as Element, shownDoc.graph);
    if (!design) { onSelect(clicked); return; }
    const pick: Pick = { kind: 'node', id: node.id };
    const picks = event.ctrlKey ? togglePick(design.picks, pick) : [pick];
    onSelect(selectionForPicks(picks, { id: node.id, selection: clicked }, shownDoc.graph), picks);
  };
  const onEdgeClick: EdgeMouseHandler = (event, edge) => {
    if (!design || !onSelect || edge.type !== 'cable') return;
    const pick: Pick = { kind: 'wire', id: edge.id };
    const picks = event.ctrlKey ? togglePick(design.picks, pick) : [pick];
    onSelect(selectionForPicks(picks, null, shownDoc.graph), picks);
  };
  const onEdgeContextMenu: EdgeMouseHandler = (event, edge) => {
    if (!design || edge.type !== 'cable') return;
    event.preventDefault();
    const picks: Pick[] = [{ kind: 'wire', id: edge.id }];
    onSelect?.(selectionForPicks(picks, null, shownDoc.graph), picks);
    setMenu({ anchor: anchorAt(event), wireId: edge.id });
  };
  const onPaneClick = () => {
    if (!onSelect) return;
    if (suppressPaneClick.current) { suppressPaneClick.current = false; return; }
    // read-only keeps slice 3a's single argument
    if (design) onSelect(null, []);
    else onSelect(null);
  };

  return (
    <FollowFitContext.Provider value={followFit}>
      <LiveArtContext.Provider value={live}>
        <div className={banding || wiring.active ? 'studio-canvas gesture' : 'studio-canvas'} style={{ position: 'relative', width: width ?? '100%', height: height ?? '100%' }}
          tabIndex={design ? 0 : undefined}
          onKeyDown={design ? onKeyDown : undefined}
          onPointerDownCapture={design ? (e) => { e.currentTarget.focus({ preventScroll: true }); drag.notePress(e.target as Element); onPointerDownCapture(e); } : undefined}>
          <DesignContext.Provider value={design ? wiring.gestures : null}>
            <ReactFlow
              nodes={shown}
              edges={marked.edges}
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
              nodesDraggable={design !== undefined}
              snapToGrid={design !== undefined}
              snapGrid={SNAP_GRID}
              nodeDragThreshold={DRAG_START}
              nodeClickDistance={DRAG_START}
              onNodeDragStart={drag.onNodeDragStart}
              onNodesChange={drag.onNodesChange}
              onNodeDragStop={drag.onNodeDragStop}
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
              {...(design ? DESIGN_KEYS : {})}
              onNodeClick={onSelect ? onNodeClick : undefined}
              onEdgeClick={design ? onEdgeClick : undefined}
              onEdgeContextMenu={design ? onEdgeContextMenu : undefined}
              onPaneClick={onSelect ? onPaneClick : undefined}
              onMoveStart={(event) => { if (event) followFit.current = false; }}
              onMoveEnd={onViewChange ? (_event, v) => onViewChange({ x: v.x, y: v.y, zoom: v.zoom, followFit: followFit.current }) : undefined}
            >
              <GridBackground />
              {design && <DesignOverlay band={band} guides={guides} wires={pickedWires} bendsOf={bendsOf} onSegment={wiring.startSegment} onEnd={() => { /* Task 8 */ }} />}
            </ReactFlow>
          </DesignContext.Provider>
          <FollowSize />
          <ScrollBars />
          <Legend />
          {children}
        </div>
        {/* outside the canvas, so the menu's keys and presses never reach the canvas's own (React bubbles through portals) */}
        {menu && design && (
          <Menu label="Wire" anchor={menu.anchor} onClose={() => setMenu(null)} entries={[{
            id: 'reset', label: 'Reset route',
            disabled: !design.draft.routes[menu.wireId],
            tip: design.draft.routes[menu.wireId] ? 'Let the router shape this wire again' : 'Only a wire shaped by hand has a route to reset',
            onSelect: () => design.onCommit(resetRoute(design.draft, menu.wireId)),
          }]} />
        )}
      </LiveArtContext.Provider>
    </FollowFitContext.Provider>
  );
}

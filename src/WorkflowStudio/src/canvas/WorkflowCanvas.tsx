import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, useReactFlow, useStore, useStoreApi, type EdgeMouseHandler, type EdgeTypes, type NodeMouseHandler, type NodeTypes, type Viewport } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { shapedByHand } from '../circuit/circuit';
import { applyDraft } from '../design/apply';
import { DesignContext } from '../design/DesignContext';
import { DesignOverlay } from '../design/DesignOverlay';
import type { DesignProps } from '../design/designProps';
import { circuitOf, EMPTY_DRAFT, resetShape, type Draft } from '../design/draft';
import { NO_GUIDES, type Guides } from '../design/guides';
import { arrowsOf, autoTarget } from '../design/autoConnect';
import { carried, copyNodes, useBlockDrag, type Held } from '../design/useBlockDrag';
import { isArrow, useDesignKeys } from '../design/useDesignKeys';
import { useRubberBand } from '../design/useRubberBand';
import { useWireGestures } from '../design/useWireGestures';
import { registerDropTarget, useToolDrag } from '../design/toolDrag';
import { landingBox, toolLabel, wireLanding } from '../design/toolDrop';
import { pointOfTarget } from '../design/drop';
import { nodeBox } from '../design/hit';
import { splitLabel, splitTone } from '../design/split';
import { nearestOn } from '../layout/junctions';
import { cacheNodeId, SPHERE_NODE_ID } from '../layout/nodeIds';
import { toneOf } from '../design/drop';
import { Menu, anchorAt, type Anchor } from '../dock/Menu';
import { togglePick, type Pick } from '../store/picks';
import type { Selection } from '../store/selection';
import { shapeFromPoints } from '../layout/shape';
import type { WireRoute } from '../layout/circuitRoute';
import { CableEdge, type CableEdgeData } from './edges/CableEdge';
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
import { selectionForPicks, selectionFromClick, withHint, withPicks, withSelection } from './selection';
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

/** Has the wire a shape of its own to reset: bends, or an end slid along a step's side (plan 9 decision 11)? */
const resettable = (doc: StudioDocument, draft: Draft, wireId: string): boolean => {
  const c = circuitOf(doc, draft);
  return Object.hasOwn(c, wireId) && shapedByHand(c[wireId]!);
};

/** React Flow's attribution badge is hidden (MIT licence): it would sit on the horizontal scroll bar. */
const PRO_OPTIONS = { hideAttribution: true } as const;

/** Every block's top-left corner lands on the 8 px grid while it is dragged (spec §3.4). */
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
  // every view the canvas takes is reported as it happens, not only when the move ends: React Flow calls
  // onMoveEnd 150 ms late (panOnScroll), and a refresh inside that time must still find the view in the session
  // with the canvas size it was taken at, so a restore keeps the view's centre against that size (FollowSize)
  const flowStore = useStoreApi();
  const report = (v: Viewport) => {
    const { width: w, height: h } = flowStore.getState();
    onViewChange?.({ x: v.x, y: v.y, zoom: v.zoom, followFit: followFit.current, ...(w > 0 && h > 0 ? { width: w, height: h } : {}) });
  };
  const [savedSize] = useState(() => (restored?.width && restored.height ? { width: restored.width, height: restored.height } : null));

  // a gesture's draft while it runs; null: the committed draft is shown
  const [preview, setPreview] = useState<Draft | null>(null);
  const [guides, setGuides] = useState<Guides>(NO_GUIDES);
  // a held block drag: the blocks stay put, their faded copies move (Visio, plan 10 phase 4)
  const [held, setHeld] = useState<Held | null>(null);
  const shownDoc = useMemo(() => (design ? applyDraft(doc, preview ?? design.draft) : doc), [doc, design?.draft, preview]);
  const shownRef = useRef(shownDoc);
  shownRef.current = shownDoc;
  const draftRef = useRef(design?.draft);
  draftRef.current = design?.draft;
  const flow = useMemo(() => toFlow(shownDoc, fitter), [shownDoc, fitter]);
  const marked = useMemo(() => (design ? withPicks(flow.nodes, flow.edges, design.picks) : flow), [flow, design?.picks]);
  const selected = useMemo(() => withSelection(marked.nodes, selection), [marked.nodes, selection]);
  const suppressPaneClick = useRef(false);
  const suppressNodeClick = useRef(false);
  const { band, banding, pressing, onPointerDownCapture } = useRubberBand(shownRef, design, onSelect, suppressPaneClick);
  const drag = useBlockDrag(doc, shownRef, design, setHeld, setGuides, onSelect, suppressNodeClick, () => flowStore.getState().transform[2]);
  const wiring = useWireGestures(doc, shownRef, design, setPreview, onSelect);
  // --inv (1 / zoom) lets canvas.css keep drop outlines and connection points one size on screen at any zoom
  const zoom = useStore((s) => s.transform[2]);
  // a key while a gesture runs would be overwritten by its drop: the canvas's keys wait for it (Escape is the gesture's)
  const onKeyDown = useDesignKeys(doc, shownRef, design, () => pressing() || wiring.running() || drag.dragging(), wiring.keys);
  // the block under a dragged wire end, outlined green or red (spec §4.4); a line gets a halo instead (plan 7); a wire
  // moved whole has one per end (rule B, 2026-10-09)
  // a Toolbox drag over this canvas (2026-10-11): where it lands, the step a processor goes to (or the cache already here)
  const container = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();
  const designing = design !== undefined;
  const workflowId = doc.graph.workflow.id;
  useEffect(() => {
    if (!designing || !container.current) return undefined;
    return registerDropTarget({
      workflowId, el: container.current, shown: () => shownRef.current, circuit: () => circuitOf(doc, draftRef.current ?? EMPTY_DRAFT),
      toFlow: (c) => screenToFlowPosition(c, { snapToGrid: false }),
    });
  }, [designing, workflowId, screenToFlowPosition, doc]);
  const toolDrag = useToolDrag();
  const toolOver = toolDrag?.over && toolDrag.over.target.el === container.current ? toolDrag.over : null;
  const tool = useMemo(() => {
    if (!toolDrag || !toolOver) return null;
    const v = toolOver.verdict;
    const label = toolLabel(v, toolOver.saving);
    const box = (v.kind === 'place' || v.kind === 'split') && !toolOver.saving ? landingBox(toolDrag.item, toolOver.flow) : null;
    const line = v.kind === 'place' && !toolOver.saving && toolDrag.item.kind === 'wire' ? wireLanding(toolOver.flow) : null;
    // a Wire tile over a contact (2026-10-20): the step or hub outlined, a line haloed, as for a dragged wire end
    const wire = v.kind === 'wire' ? v : null;
    const wireTone = wire && (toneOf(wire.why) === 'no' ? 'no' as const : 'ok' as const);
    const node = v.kind === 'assign' || v.kind === 'replace' ? { id: v.stepId, tone: 'ok' as const }
      : v.kind === 'linked' ? { id: cacheNodeId(v.cacheId), tone: 'no' as const }
        : wire && wireTone && wire.target.on !== 'wire' ? { id: wire.target.on === 'step' ? wire.target.step : SPHERE_NODE_ID, tone: wireTone } : null;
    const halo = wire && wireTone && wire.target.on === 'wire' ? { id: wire.target.host, tone: wireTone } : null;
    const path = wire && wireTone === 'ok' ? wire.points : null;
    // the Wire tile's landing point, drawn as Visio's square (plan 10)
    const contact = v.kind === 'wire' && !toolOver.saving ? pointOfTarget(toolOver.target.shown(), v.target) : null;
    return { box, line, path, node, halo, contact, label: label && { ...label, at: toolOver.flow } };
  }, [toolDrag, toolOver]);
  // Visio's AutoConnect (plan 10 phase 6): the arrows each block shows, and what a click on the hovered one would do (a
  // new step's landing box, or the step already there outlined, green or refused)
  const autoCircuit = useMemo(() => (design ? circuitOf(doc, preview ?? design.draft) : null), [doc, design?.draft, preview]);
  const auto = useMemo(() => {
    const h = wiring.autoHover;
    if (!h || !autoCircuit) return null;
    const t = autoTarget(shownDoc, autoCircuit, h.id, h.dir);
    return t.kind === 'new' ? { box: t.box, node: null }
      : t.kind === 'step' ? { box: null, node: { id: t.step, tone: t.ok ? 'ok' as const : 'no' as const } } : null;
  }, [wiring.autoHover, autoCircuit, shownDoc]);
  const shown = useMemo(() => {
    const marked = wiring.hints.filter((h) => !h.line).reduce(withHint, selected);
    const toolLit = tool?.node ? withHint(marked, tool.node) : marked;
    const lit = auto?.node ? withHint(toolLit, auto.node) : toolLit;
    const hinted = autoCircuit
      ? lit.map((n) => (n.type === 'step' || n.type === 'workflow' ? { ...n, data: { ...n.data, arrows: arrowsOf(shownDoc, autoCircuit, n.id) } } : n)) as typeof lit
      : lit;
    if (!held) return hinted;
    // Visio's held copy: the block's art, faded, in a light-blue dashed outline, where the release puts it; never pressed
    return [...hinted, ...copyNodes(flow.nodes, held, shownDoc)] as typeof hinted;
  }, [selected, wiring.hints, tool, held, flow.nodes, shownDoc, auto, autoCircuit]);
  // the picked wires the held blocks take along whole, where the release puts them
  const heldWires = useMemo(() => {
    if (!held) return [];
    const along = carried(circuitOf(doc, held.draft), held);
    return shownDoc.wires.filter((w) => along.includes(w.id)).map((w) => w.core.points.map(([x, y]) => [x + held.dx, y + held.dy] as [number, number]));
  }, [held, shownDoc, doc]);
  // an empty step held over a wire's run, from the Toolbox or on the canvas: the wire's ends marked, and on the canvas
  // the label by the point the step would be inserted at (Visio, plan 10 §4.6)
  const split = useMemo(() => {
    const v = toolOver && !toolOver.saving && toolOver.verdict.kind === 'split' ? toolOver.verdict : null;
    const s = held?.split ?? v;
    const route = s ? shownDoc.wires.find((w) => w.id === s.wire) : undefined;
    if (!s || !route || route.points.length < 2) return null;
    const [a, z] = [route.points[0]!, route.points[route.points.length - 1]!];
    const ends = [{ x: a[0], y: a[1] }, { x: z[0], y: z[1] }];
    const box = held?.split ? nodeBox(shownDoc, held.ids[0]!) : null;
    const at = box && held ? nearestOn([route.points], [box.x + held.dx + box.w / 2, box.y + held.dy + box.h / 2]).p : null;
    return { ends, tone: splitTone(s.why), label: at && { text: splitLabel(s.why), at: { x: at[0], y: at[1] } } };
  }, [held, toolOver, shownDoc]);
  // a wire whose end is dragged follows the pointer: the wire, its handles and its runs (spec §4.4)
  const dragged = wiring.ghost?.wire ? { id: wiring.ghost.wire, points: wiring.ghost.points, body: wiring.ghost.body === true, going: wiring.ghost.faded === true } : null;
  const edges = useMemo(() => marked.edges.map((e) => {
    if (e.type !== 'cable' || !e.data) return e;
    let data = e.data;
    // held, the wire stays as it is (Visio's; the user's rulings, 2026-10-22): an end drag's new route is the overlay's
    // dashed ghost, a body drag's the overlay's faded copy; only a wire a release would delete is drawn faded
    if (dragged?.going && e.id === dragged.id) data = { ...data, faded: true };
    // the line under a dragged end: green when the end may join it, red when refused (plan 7 §6.1, plan 9 §6)
    const line = wiring.hints.find((h) => h.line && h.id === e.id && h.tone !== 'move');
    if (line && line.tone !== 'move') data = { ...data, halo: line.tone };
    if (tool?.halo && tool.halo.id === e.id) data = { ...data, halo: tool.halo.tone };
    return data === e.data ? e : { ...e, data };
  }), [marked.edges, wiring.ghost, wiring.hints, tool]);
  // a wire moved whole: its own art (colour, ring, arrow, dashes) on the route where the release puts it, for the copy
  const bodyCopy = useMemo(() => {
    if (!dragged?.body) return null;
    const e = marked.edges.find((x) => x.id === dragged.id);
    return e?.type === 'cable' && e.data ? { ...(e.data as CableEdgeData), points: dragged.points, picked: false, halo: undefined, faded: false } : null;
  }, [dragged?.body, dragged?.id, dragged?.points, marked.edges]);
  // picks naming wires that are gone (after an undo) draw nothing; while an end square is dragged its wire's squares
  // stay where they were when the drag began: they are what it may be released on (the user's rule, 2026-10-09)
  const pickedWires = useMemo(
    () => (design ? shownDoc.wires.filter((w) => design.picks.some((p) => p.kind === 'wire' && p.id === w.id)) : []),
    [shownDoc, design?.picks],
  );
  // the run squares follow a run drag's preview, not only the committed draft
  const bendsOf = (w: WireRoute) => circuitOf(doc, preview ?? design?.draft ?? EMPTY_DRAFT)[w.id]?.bends ?? shapeFromPoints(w.core.points);
  // the wire's right-click menu (spec §4.3)
  const [menu, setMenu] = useState<{ anchor: Anchor; wireId: string } | null>(null);

  const onNodeClick: NodeMouseHandler = (event, node) => {
    if (!onSelect) return;
    if (suppressNodeClick.current) { suppressNodeClick.current = false; return; }
    const clicked = selectionFromClick(node, event.target as Element, shownDoc.graph);
    if (!design) { onSelect(clicked); return; }
    // a click on a step's processor picture picks the processor (2026-10-10: Delete then removes it from the step)
    const pick: Pick = clicked?.kind === 'processor' ? { kind: 'processor', id: node.id } : { kind: 'node', id: node.id };
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
    // every wire has the menu: Reset route clears its shape (plan 9 decision 11)
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
        <div ref={container} className={banding || wiring.active ? `studio-canvas gesture${wiring.resize ? ` gesture-${wiring.resize}` : ''}` : held ? 'studio-canvas block-drag' : 'studio-canvas'} style={{ position: 'relative', width: width ?? '100%', height: height ?? '100%', '--inv': String(1 / zoom) } as CSSProperties}
          tabIndex={design ? 0 : undefined}
          onKeyDown={design ? onKeyDown : undefined}
          // an arrow let go drops the wires it held (the closed hand's release); so does leaving the canvas or a press
          onKeyUp={design ? (e) => { if (isArrow(e.key)) wiring.keys.release(); } : undefined}
          onBlur={design ? () => wiring.keys.release() : undefined}
          onPointerDownCapture={design ? (e) => { wiring.keys.release(); e.currentTarget.focus({ preventScroll: true }); drag.notePress(e.target as Element, { x: e.clientX, y: e.clientY }); onPointerDownCapture(e); } : undefined}>
          <DesignContext.Provider value={design ? wiring.gestures : null}>
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
              nodesDraggable={design !== undefined}
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
              onMoveStart={(event, v) => { if (event) followFit.current = false; report(v); }}
              onMove={(_event, v) => report(v)}
              onMoveEnd={(_event, v) => report(v)}
            >
              <GridBackground />
              {design && <DesignOverlay band={band} guides={toolOver?.guides ?? guides} wires={pickedWires} bendsOf={bendsOf} onSegment={wiring.startSegment} onEnd={wiring.startEnd} ghost={dragged?.body ? null : wiring.ghost?.points ?? null} bodyCopy={bodyCopy} hints={wiring.hints} gone={wiring.ghost?.gone ?? null} runGuide={wiring.runGuide} shorts={wiring.ghost?.shorts} tool={tool ?? (auto?.box ? { box: auto.box, line: null, label: null } : null)} copies={heldWires} split={split} />}
            </ReactFlow>
          </DesignContext.Provider>
          <FollowSize initial={savedSize} />
          <ScrollBars />
          <Legend />
          {children}
        </div>
        {/* outside the canvas, so the menu's keys and presses never reach the canvas's own (React bubbles through portals) */}
        {menu && design && (
          <Menu label="Wire" anchor={menu.anchor} onClose={() => setMenu(null)} entries={[{
            id: 'reset', label: 'Reset route',
            disabled: !resettable(doc, design.draft, menu.wireId),
            tip: resettable(doc, design.draft, menu.wireId) ? 'Let the router shape this wire again' : 'Only a wire shaped by hand has a route to reset',
            onSelect: () => design.onCommit(resetShape(design.draft, doc, menu.wireId)),
          }]} />
        )}
      </LiveArtContext.Provider>
    </FollowFitContext.Provider>
  );
}

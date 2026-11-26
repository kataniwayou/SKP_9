import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  applyNodeChanges, Background, BackgroundVariant, ControlButton, Controls, getNodesBounds, Panel, ReactFlow, ViewportPortal,
  type Connection, type Edge, type EdgeChange, type EdgeTypes, type Node, type NodeChange, type NodeTypes, type Viewport,
} from '@xyflow/react';
import type { BoardState, ItemRef } from '../design/board';
import { escapeKey } from '../design/keys';
import type { Id } from '../model/graph';
import type { Point, Rect } from '../model/geometry';
import { boxPicks, rectOf } from './boxSelect';
import { BoardMiniMap } from './BoardMiniMap';
import { connectionKind, itemOfNode, type ConnectionKind } from './connect';
import { focusBounds, itemBounds } from './focus';
import { CLICK_SLOP } from './geometry';
import { covered, pushAside } from './overlap';
import type { Pick } from './selection';
import { flowIdOf, toFlow, type BoardView } from './toFlow';
import { CacheLinkEdge } from './edges/CacheLinkEdge';
import { EntryEdge } from './edges/EntryEdge';
import { LinkWire } from './edges/LinkWire';
import { SchemaRefEdge } from './edges/SchemaRefEdge';
import { ToolbarContext, type ToolbarActions } from './nodes/boardContext';
import { CacheNode } from './nodes/CacheNode';
import { ProcessorCard } from './nodes/ProcessorCard';
import { SchemaCard } from './nodes/SchemaCard';
import { StepCard } from './nodes/StepCard';
import { TriangleNode } from './nodes/TriangleNode';
import './board.css';

const nodeTypes: NodeTypes = { workflow: TriangleNode, step: StepCard, cache: CacheNode, schema: SchemaCard, processor: ProcessorCard };
const edgeTypes: EdgeTypes = { wire: LinkWire, entry: EntryEdge, cacheLink: CacheLinkEdge, schemaRef: SchemaRefEdge };

export interface BoardProps {
  state: BoardState;
  /** The selected triangle, the picks (in pick order) and the live reading of each workflow. */
  view: BoardView;
  /** `additive` is true while Ctrl or Meta is held; null means a click on empty board. */
  onPick: (p: Pick | null, additive: boolean) => void;
  /**
   * A right-button drag's box [user, 2026-11-22]: the triangles, steps and caches it touched, left to right then top to
   * bottom (empty: it touched none); `additive` while Ctrl or Meta is held at the release. Without it there is no box.
   */
  onBoxPick?: (picks: Pick[], additive: boolean) => void;
  /** One drag stop: everything the drag moved, to commit as one history step. Without onMove and onConnect the board is read-only. */
  onMove?: (moved: { ref: ItemRef; at: Point }[]) => void;
  /** The ghosts a drag stop moved (same drag as onMove's, kept apart: ghosts are not board rows and no undo step). */
  onMoveGhosts?: (moved: { key: string; at: Point }[]) => void;
  /**
   * A connection React Flow made: `wire` (a: from step, b: to step), `entry` (a: workflow, b: step) or `cacheLink`
   * (a: workflow, b: cache). The edit may refuse; that goes to Output, not here.
   */
  onConnect?: (kind: ConnectionKind, a: Id, b: Id) => void;
  /** What the toolbars hold; without it no toolbar shows. */
  toolbar?: ToolbarActions;
  /** Tests and view restore: start at this zoom instead of fitting everything. */
  initialZoom?: number;
  /** View restore: start here instead of fitting everything. */
  initialView?: { x: number; y: number; zoom: number };
  /** The viewport after each pan or zoom, and when something is selected. */
  onViewChange?: (view: { x: number; y: number; zoom: number }) => void;
  /** Something was dropped on the board (the `application/acto` payload as text); `at` is in board coordinates. */
  onDropData?: (raw: string, at: Point) => void;
  /** Pinned top-centre of the board (the selection bar). */
  bar?: ReactNode;
  /** False while the board is still arriving: the first fit waits until it turns true. */
  settled?: boolean;
  /** Filled by the board with its pan: centres the view on a workflow (or, given, its steps) at the current zoom. */
  focusRef?: MutableRefObject<BoardFocus | null>;
  /** Set by the board: centre an item (the Inspector's chip links). */
  centerRef?: MutableRefObject<BoardCenter | null>;
  /**
   * The board as it is now, for `focusRef` (App: the store's): a tool pans right after its store edit, before React has
   * drawn it. Without it, the last render's.
   */
  stateNow?: () => BoardState;
}

/** Pans the board to a workflow (and, given, steps); a workflow not on the board is ignored. */
export type BoardFocus = (workflowId: string, stepIds?: string[]) => void;
/** Pans (zoom kept) so the item is in the middle of the board. */
export type BoardCenter = (ref: ItemRef) => void;

const refOf = (n: Node): ItemRef | null => { const i = itemOfNode(n.id); return i ? { kind: i.kind, id: i.id } : null; };

/** What a node or edge of the flow stands for. */
const GHOST_PREFIX = 'ghost:';
function pickOfNode(n: Node): Pick | null {
  if (n.id.startsWith(GHOST_PREFIX)) return { kind: 'ghost', key: n.id.slice(GHOST_PREFIX.length) };
  const i = itemOfNode(n.id);
  return i ? { kind: i.kind, id: i.id } : null;
}
function pickOfEdge(e: Edge): Pick | null {
  if (e.id.startsWith(GHOST_PREFIX)) return { kind: 'ghost', key: e.id.slice(GHOST_PREFIX.length) };
  const d = e.data as Record<string, string> | undefined;
  if (!d) return null;
  if (e.type === 'wire') return { kind: 'wire', from: d.from!, to: d.to! };
  if (e.type === 'entry') return { kind: 'entry', workflowId: d.workflowId!, stepId: d.stepId! };
  if (e.type === 'cacheLink') return { kind: 'cacheLink', workflowId: d.workflowId!, cacheId: d.cacheId! };
  return null;
}

const isGhost = (n: Node) => (n.className ?? '').split(' ').includes('ghost');

/** A node's box on the board, measured once React Flow has drawn it (else its declared size). */
const boxOf = (n: Node) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 0, h: n.measured?.height ?? n.height ?? 0 });
/** Above every other node, picked ones (React Flow adds 1000 for those) included, while it is dragged. */
const LIFTED_Z = 3000;
/** How long a drop slides to its free place (board.css .settling). */
const SETTLE_MS = 280;

/** Whether a click landed on a node's handle: a connection, not a pick. */
export const onHandle = (t: EventTarget | null): boolean => t instanceof Element && t.closest('.react-flow__handle') !== null;

export function Board({ state, view, onPick, onBoxPick, onMove, onMoveGhosts, onConnect, toolbar, initialZoom, initialView, onViewChange, onDropData, bar, settled = true, focusRef, centerRef, stateNow }: BoardProps) {
  const fitAtMount = useRef(settled);
  const flow = useRef<{
    getViewport: () => Viewport; fitBounds: (b: { x: number; y: number; width: number; height: number }, o?: { padding?: number }) => unknown; screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
    setCenter: (x: number, y: number, o?: { zoom?: number; duration?: number }) => unknown;
    getNodes: () => Node[];
  } | null>(null);
  // the right-button box: where it started (screen), whether it has left the click slop, and the box as drawn (in the board's own pixels)
  const wrap = useRef<HTMLDivElement>(null);
  const boxDrag = useRef<{ pointer: number; start: Point; moved: boolean } | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const endBox = () => { boxDrag.current = null; setBox(null); };
  const stateRef = useRef(state);
  stateRef.current = state;
  const lookup = useRef(stateNow);
  lookup.current = stateNow;
  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = (workflowId, stepIds) => {
      const rf = flow.current;
      const b = focusBounds(lookup.current ? lookup.current() : stateRef.current, workflowId, stepIds);
      if (!b || !rf) return;
      void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: rf.getViewport().zoom, duration: 300 });
    };
    return () => { focusRef.current = null; };
  }, [focusRef]);
  useEffect(() => {
    if (!centerRef) return;
    centerRef.current = (ref) => {
      const rf = flow.current;
      const b = itemBounds(lookup.current ? lookup.current() : stateRef.current, ref);
      if (!b || !rf) return;
      void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: rf.getViewport().zoom, duration: 300 });
    };
    return () => { centerRef.current = null; };
  }, [centerRef]);
  // the first fit waited for the last row: fit once it is in (a saved view or a given zoom is never fitted over)
  useEffect(() => {
    if (!settled || fitAtMount.current) return;
    if (initialView !== undefined || initialZoom !== undefined) { fitAtMount.current = true; return; }
    // let React Flow measure the nodes that just arrived first
    const raf = requestAnimationFrame(() => { fitAtMount.current = true; fitAll(); });
    return () => cancelAnimationFrame(raf);
  }, [settled, initialView, initialZoom]);
  const select = (s: Pick | null, additive = false) => {
    if (flow.current) onViewChange?.(flow.current.getViewport());
    onPick(s, additive);
  };
  // React Flow's own selection is off: picks decide. Only a keyboard select (Enter/Space on a focused node) comes from it.
  const keySelect = useRef(false);
  const picked = useMemo(() => new Set(view.picks.map(flowIdOf)), [view.picks]);
  const editable = onMove !== undefined || onConnect !== undefined;
  // the schema card under the pointer: its reference wires thicken [spec rule 4]
  const [hotSchema, setHotSchema] = useState<Id | null>(null);
  const { nodes: derived, edges } = useMemo(() => toFlow(state, hotSchema === null ? view : { ...view, hotSchema }), [state, view, hotSchema]);

  // Editing: React Flow needs the nodes in state so a drag moves them before anything is committed.
  const [dragged, setDragged] = useState<Node[]>(derived);
  // the fit looks at real items only: a ghost is not framed
  const fitViewOptions = useMemo(() => {
    const real = derived.filter((n) => !isGhost(n)).map((n) => ({ id: n.id }));
    return real.length > 0 ? { nodes: real } : undefined;
  }, [derived]);
  const derivedRef = useRef(derived);
  derivedRef.current = derived;
  /**
   * Fits the real items now. React Flow 12's fitView only runs on the next node-internals update, which a controlled
   * board whose nodes did not change never sends, so the fit would wait for some later change; fitBounds acts at once.
   */
  const fitAll = () => {
    const real = derivedRef.current.filter((n) => !isGhost(n));
    if (real.length === 0 || !flow.current) return;
    void flow.current.fitBounds(getNodesBounds(real), { padding: 0.1 });
  };
  /*
   * A board derived anew mid-drag (a hover, a live status) must not end the drag: the dragged nodes keep where the pointer
   * has them and their `dragging`, or the card drops its lift for a frame and flashes [user, 2026-11-26].
   */
  useEffect(() => {
    const d = drag.current;
    if (!d) { setDragged(derived); return; }
    setDragged((prev) => {
      const held = new Map(prev.filter((n) => d.start.has(n.id)).map((n) => [n.id, n]));
      return derived.map((n) => { const h = held.get(n.id); return h ? { ...n, position: h.position, dragging: h.dragging } : n; });
    });
  }, [derived]);
  /*
   * React Flow selects a clicked node itself before onNodeClick, writing `selected` straight onto its internal nodes (its
   * own "hack" for drags). A click that picks re-derives the nodes from the picks, which puts that right; a click that
   * picks nothing (on a handle) does not, so it bumps `resync` to hand React Flow fresh node objects with the picks'
   * own `selected` again.
   */
  const [resync, setResync] = useState(0);
  const shown = editable ? dragged : derived;
  // a drop sliding to its free place: those nodes animate there [user, 2026-11-25, option B]
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo(() => {
    const lift = shown.some((n) => n.dragging) || settling.size > 0;
    if (!lift) return resync === 0 ? shown : shown.map((n) => ({ ...n }));
    // the dragged nodes rise above everything (ghosts too), so what is dragged is always what is seen
    return shown.map((n) => {
      const up = n.dragging === true;
      const slide = settling.has(n.id);
      if (!up && !slide) return resync === 0 ? n : { ...n };
      return { ...n, zIndex: LIFTED_Z, className: [n.className, up ? 'lifted' : '', slide ? 'settling' : ''].filter(Boolean).join(' ') };
    });
  }, [shown, resync, settling]);
  // what the dragged nodes lie over, outlined above everything with its name so nothing seems to vanish
  const under = useMemo(() => {
    const moving = shown.filter((n) => n.dragging);
    if (moving.length === 0) return [];
    const rest = shown.filter((n) => !n.dragging).map((n) => ({ id: n.id, box: boxOf(n), name: String((n.data as { name?: unknown }).name ?? '') }));
    return covered(moving.map(boxOf), rest);
  }, [shown]);

  // A drag in progress: where each dragged node began, and whether Esc has cancelled it.
  const drag = useRef<{ start: Map<string, Point>; cancelled: boolean } | null>(null);
  const onNodesChange = (changes: NodeChange[]) => {
    if (keySelect.current) {
      const id = changes.flatMap((c) => (c.type === 'select' && c.selected ? [c.id] : []))[0];
      const n = id === undefined ? undefined : nodes.find((x) => x.id === id);
      const p = n ? pickOfNode(n) : null;
      if (p) { keySelect.current = false; select(p); }
    }
    // after Esc the pointer may still be down: its moves must not drag the nodes away again
    const cancelled = drag.current?.cancelled === true;
    // nodes leave the board only through the store: a 'remove' from React Flow would hide what is still there
    setDragged((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'select' && c.type !== 'remove' && !(cancelled && c.type === 'position')), ns));
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!keySelect.current) return;
    const id = changes.flatMap((c) => (c.type === 'select' && c.selected ? [c.id] : []))[0];
    const e = id === undefined ? undefined : edges.find((x) => x.id === id);
    const p = e ? pickOfEdge(e) : null;
    if (p) { keySelect.current = false; select(p); }
  };
  const dragStart = (n: Node, all?: Node[]) => {
    drag.current = { start: new Map((all && all.length > 0 ? all : [n]).map((m) => [m.id, { ...m.position }])), cancelled: false };
    // a dragged schema is the one under the pointer the whole drag: its wires stay thick (hovers are not followed mid-drag)
    if (n.type === 'schema' && !isGhost(n)) setHotSchema(itemOfNode(n.id)?.id ?? null);
  };
  const pickNow = useRef({ onPick, any: view.picks.length > 0 });
  pickNow.current = { onPick, any: view.picks.length > 0 };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = drag.current;
      const act = escapeKey(e, d !== null);
      if (act === 'clear-picks') { if (pickNow.current.any) pickNow.current.onPick(null, false); return; }
      if (act !== 'cancel-drag' || !d || d.cancelled) return;
      d.cancelled = true;
      setDragged((ns) => ns.map((n) => { const p = d.start.get(n.id); return p ? { ...n, position: { ...p } } : n; }));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /**
   * One commit for everything a drag moved (React Flow drags every picked node together). A drop on another item, a
   * ghost included, slides the whole group to the nearest free place first [user, 2026-11-25, option B], so the board never
   * ends with one item hiding another.
   */
  const dragStop = (n: Node, all?: Node[]) => {
    const cancelled = drag.current?.cancelled === true;
    drag.current = null;
    if (!onMove) return;
    if (cancelled) { setDragged(derivedRef.current); return; }
    const group = all && all.length > 0 ? all : [n];
    const ids = new Set(group.map((m) => m.id));
    // sizes as drawn: the board's own copies carry React Flow's measurements
    const sized = new Map(dragged.map((x) => [x.id, x]));
    const box = (m: Node) => {
      const own = sized.get(m.id);
      return boxOf({ ...m, measured: m.measured ?? own?.measured, width: m.width ?? own?.width, height: m.height ?? own?.height });
    };
    const others = dragged.filter((x) => !ids.has(x.id)).map(box);
    // a drag that ends where it began moved nothing: an overlap it already had (an older board) is not pushed
    const still = group.every((m) => { const p = derivedRef.current.find((x) => x.id === m.id)?.position; return !!p && p.x === m.position.x && p.y === m.position.y; });
    const off = still ? { x: 0, y: 0 } : pushAside(group.map(box), others);
    const landed = group.map((m) => ({ ...m, position: { x: m.position.x + off.x, y: m.position.y + off.y } }));
    const moved: { ref: ItemRef; at: Point }[] = [];
    const movedGhosts: { key: string; at: Point }[] = [];
    for (const m of landed) {
      const cur0 = derivedRef.current.find((x) => x.id === m.id)?.position;
      if (isGhost(m)) {
        if (m.id.startsWith(GHOST_PREFIX) && (!cur0 || cur0.x !== m.position.x || cur0.y !== m.position.y)) movedGhosts.push({ key: m.id.slice(GHOST_PREFIX.length), at: { x: m.position.x, y: m.position.y } });
        continue;
      }
      const ref = refOf(m);
      const cur = derivedRef.current.find((x) => x.id === m.id)?.position;
      if (ref && (!cur || cur.x !== m.position.x || cur.y !== m.position.y)) moved.push({ ref, at: { x: m.position.x, y: m.position.y } });
    }
    if (moved.length > 0) onMove(moved);
    if (movedGhosts.length > 0) onMoveGhosts?.(movedGhosts);
    if (off.x === 0 && off.y === 0) { setDragged(derivedRef.current); return; } // a refused or unchanged drag snaps back
    // slide from where it was let go to its free place, then take the committed board (a refused move snaps back from there)
    const at = new Map(landed.map((m) => [m.id, m.position]));
    setSettling(ids);
    setDragged((ns) => ns.map((x) => { const p = at.get(x.id); return p ? { ...x, position: p, dragging: false } : x; }));
    window.setTimeout(() => { setSettling(new Set()); setDragged(derivedRef.current); }, SETTLE_MS);
  };

  const connect = (c: Connection) => {
    if (!onConnect) return;
    const kind = connectionKind(c, stateRef.current);
    const a = itemOfNode(c.source);
    const b = itemOfNode(c.target);
    if (kind && a && b) onConnect(kind, a.id, b.id);
  };

  return (
    <ToolbarContext.Provider value={editable ? toolbar ?? null : null}>
      <div className="board" ref={wrap}
        onContextMenu={(e) => { if (onBoxPick) e.preventDefault(); }}
        onPointerDown={(e) => {
          if (e.button !== 2 || !onBoxPick || !flow.current) return;
          // not from the bars, the controls or the minimap: those are not the board
          if (e.target instanceof Element && e.target.closest('.toolbar, .selbar, .react-flow__controls, .react-flow__minimap')) return;
          boxDrag.current = { pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, moved: false };
          e.currentTarget.setPointerCapture?.(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => {
          const d = boxDrag.current;
          if (!d || d.pointer !== e.pointerId || !wrap.current) return;
          if (!d.moved && Math.hypot(e.clientX - d.start.x, e.clientY - d.start.y) < CLICK_SLOP) return;
          d.moved = true;
          const r = wrap.current.getBoundingClientRect();
          setBox(rectOf({ x: d.start.x - r.left, y: d.start.y - r.top }, { x: e.clientX - r.left, y: e.clientY - r.top }));
        }}
        onPointerUp={(e) => {
          const d = boxDrag.current;
          if (!d || d.pointer !== e.pointerId) return;
          endBox();
          const rf = flow.current;
          // a right-click that did not drag does nothing
          if (!d.moved || !rf || !onBoxPick) return;
          const area = rectOf(rf.screenToFlowPosition(d.start), rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          const placed = rf.getNodes().map((n) => ({
            pick: pickOfNode(n),
            box: { x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 0, h: n.measured?.height ?? n.height ?? 0 },
          }));
          onViewChange?.(rf.getViewport());
          onBoxPick(boxPicks(placed, area), e.ctrlKey || e.metaKey);
        }}
        onPointerCancel={endBox}
        onKeyDownCapture={(e) => {
        // arrows nudge picks (App): React Flow's own keyboard move of a focused node must not add to it
        if (e.key.startsWith('Arrow') && !(e.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable))) e.stopPropagation();
        keySelect.current = e.key === 'Enter' || e.key === ' ';
      }} onKeyDown={() => { keySelect.current = false; }} onKeyUp={() => { keySelect.current = false; }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={editable}
          nodesConnectable={editable}
          isValidConnection={(c) => connectionKind(c as Connection, state) !== null}
          // a click whose pointer wobbles a few pixels is still a click: it picks and moves nothing
          nodeDragThreshold={CLICK_SLOP}
          nodeClickDistance={CLICK_SLOP}
          {...(editable ? {
            onNodesChange,
            onNodeDragStart: (_: unknown, n: Node, all?: Node[]) => dragStart(n, all),
            onNodeDragStop: (_: unknown, n: Node, all?: Node[]) => dragStop(n, all),
            onConnect: connect,
          } : {})}
          elementsSelectable
          {...(fitViewOptions ? { fitViewOptions } : {})}
          minZoom={0.05}
          maxZoom={2}
          {...(initialView !== undefined ? { defaultViewport: initialView }
            : initialZoom !== undefined ? { defaultViewport: { x: 0, y: 0, zoom: initialZoom } } : { fitView: fitAtMount.current })}
          onDragOver={(e) => { if (editable && onDropData) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
          onDrop={(e) => {
            if (!editable || !onDropData || !flow.current) return;
            const raw = e.dataTransfer.getData('application/acto');
            if (!raw) return;
            e.preventDefault();
            onDropData(raw, flow.current.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
          onInit={(rf) => { flow.current = rf; }}
          onMoveEnd={(_, v) => onViewChange?.(v)}
          multiSelectionKeyCode={null}
          selectionKeyCode={null}
          deleteKeyCode={null}
          onEdgesChange={onEdgesChange}
          {...(!editable ? { onNodesChange } : {})}
          onNodeClick={(ev, n) => {
            keySelect.current = false;
            // a press on a handle (or a connection drag let go on its own node) is a connection, never a pick or an unpick
            if (onHandle(ev.target)) { setResync((r) => r + 1); return; }
            const p = pickOfNode(n);
            if (p) select(p, ev.ctrlKey || ev.metaKey);
          }}
          onEdgeClick={(ev, e) => { keySelect.current = false; const p = pickOfEdge(e); if (p) select(p, ev.ctrlKey || ev.metaKey); }}
          onPaneClick={(ev) => select(null, ev.ctrlKey || ev.metaKey)}
          // not while a drag runs: the pointer slips off and back onto the card it drags (React Flow moves a node a frame after
          // the pointer) and over other cards, and each change of the hot schema derives the board anew, which hands React Flow
          // fresh nodes without `dragging`: the card dropped its lift and flashed [user, 2026-11-26]. What was hot at the press stays hot.
          onNodeMouseEnter={(_, n) => { if (!drag.current && n.type === 'schema' && !isGhost(n)) setHotSchema(itemOfNode(n.id)?.id ?? null); }}
          onNodeMouseLeave={(_, n) => { if (!drag.current && n.type === 'schema') setHotSchema(null); }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--dot)" />
          {under.length > 0 && (
            <ViewportPortal>
              {under.map((u) => (
                <div key={u.id} className="under-mark" data-testid="under-mark" data-under={u.id}
                  style={{ left: u.box.x - 4, top: u.box.y - 4, width: u.box.w + 8, height: u.box.h + 8 }}>
                  <span>{u.name ? `under: ${u.name}` : 'under'}</span>
                </div>
              ))}
            </ViewportPortal>
          )}
          {box && <div className="box-select" data-testid="box-select" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
          {bar && <Panel position="top-center" className="selbar-panel">{bar}</Panel>}
          <BoardMiniMap nodes={nodes} picked={picked} />
          <Controls showInteractive={false} showFitView={false} orientation="vertical">
            <ControlButton className="react-flow__controls-fitview" onClick={fitAll} title="Fit View" aria-label="Fit View">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30" aria-hidden="true"><path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" /></svg>
            </ControlButton>
          </Controls>
        </ReactFlow>
      </div>
    </ToolbarContext.Provider>
  );
}

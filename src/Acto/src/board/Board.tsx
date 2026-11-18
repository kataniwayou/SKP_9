import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  applyNodeChanges, Background, BackgroundVariant, Controls, Panel, ReactFlow,
  type Connection, type Edge, type EdgeChange, type EdgeTypes, type Node, type NodeChange, type NodeTypes, type Viewport,
} from '@xyflow/react';
import type { BoardState, ItemRef } from '../design/board';
import { escapeKey } from '../design/keys';
import type { Id } from '../model/graph';
import type { Point } from '../model/geometry';
import { BoardMiniMap } from './BoardMiniMap';
import { connectionKind, itemOfNode, type ConnectionKind } from './connect';
import { focusBounds } from './focus';
import { CLICK_SLOP } from './geometry';
import type { Pick } from './selection';
import { flowIdOf, toFlow, type BoardView } from './toFlow';
import { CacheLinkEdge } from './edges/CacheLinkEdge';
import { EntryEdge } from './edges/EntryEdge';
import { LinkWire } from './edges/LinkWire';
import { ToolbarContext, type ToolbarActions } from './nodes/boardContext';
import { CacheNode } from './nodes/CacheNode';
import { StepCard } from './nodes/StepCard';
import { TriangleNode } from './nodes/TriangleNode';
import './board.css';

const nodeTypes: NodeTypes = { workflow: TriangleNode, step: StepCard, cache: CacheNode };
const edgeTypes: EdgeTypes = { wire: LinkWire, entry: EntryEdge, cacheLink: CacheLinkEdge };

export interface BoardProps {
  state: BoardState;
  /** The selected triangle, the picks (in pick order) and the live reading of each workflow. */
  view: BoardView;
  /** `additive` is true while Ctrl or Meta is held; null means a click on empty board. */
  onPick: (p: Pick | null, additive: boolean) => void;
  /** One drag stop: everything the drag moved, to commit as one history step. Without onMove and onConnect the board is read-only. */
  onMove?: (moved: { ref: ItemRef; at: Point }[]) => void;
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
  /**
   * The board as it is now, for `focusRef` (App: the store's): a tool pans right after its store edit, before React has
   * drawn it. Without it, the last render's.
   */
  stateNow?: () => BoardState;
}

/** Pans the board to a workflow (and, given, steps); a workflow not on the board is ignored. */
export type BoardFocus = (workflowId: string, stepIds?: string[]) => void;

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

export function Board({ state, view, onPick, onMove, onConnect, toolbar, initialZoom, initialView, onViewChange, onDropData, bar, settled = true, focusRef, stateNow }: BoardProps) {
  const fitAtMount = useRef(settled);
  const flow = useRef<{
    getViewport: () => Viewport; fitView: (o?: { nodes: { id: string }[] }) => unknown; screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
    setCenter: (x: number, y: number, o?: { zoom?: number; duration?: number }) => unknown;
  } | null>(null);
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
  // the first fit waited for the last row: fit once it is in (a saved view or a given zoom is never fitted over)
  useEffect(() => {
    if (!settled || fitAtMount.current) return;
    if (initialView !== undefined || initialZoom !== undefined) { fitAtMount.current = true; return; }
    // let React Flow measure the nodes that just arrived first
    const raf = requestAnimationFrame(() => { fitAtMount.current = true; void flow.current?.fitView(fitOptions()); });
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
  const { nodes: derived, edges } = useMemo(() => toFlow(state, view), [state, view]);

  // Editing: React Flow needs the nodes in state so a drag moves them before anything is committed.
  const [dragged, setDragged] = useState<Node[]>(derived);
  // the fit looks at real items only: a ghost is not framed
  const fitViewOptions = useMemo(() => {
    const real = derived.filter((n) => !(n.className ?? '').split(' ').includes('ghost')).map((n) => ({ id: n.id }));
    return real.length > 0 ? { nodes: real } : undefined;
  }, [derived]);
  const fitOptions = () => fitViewOptions;
  const derivedRef = useRef(derived);
  derivedRef.current = derived;
  useEffect(() => { setDragged(derived); }, [derived]);
  const nodes = editable ? dragged : derived;

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

  /** One commit for everything a drag moved (React Flow drags every picked node together). */
  const dragStop = (n: Node, all?: Node[]) => {
    const cancelled = drag.current?.cancelled === true;
    drag.current = null;
    if (!onMove) return;
    if (cancelled) { setDragged(derivedRef.current); return; }
    const moved: { ref: ItemRef; at: Point }[] = [];
    for (const m of all && all.length > 0 ? all : [n]) {
      const ref = refOf(m);
      const cur = derivedRef.current.find((x) => x.id === m.id)?.position;
      if (ref && (!cur || cur.x !== m.position.x || cur.y !== m.position.y)) moved.push({ ref, at: { x: m.position.x, y: m.position.y } });
    }
    if (moved.length > 0) onMove(moved);
    setDragged(derivedRef.current); // a refused or unchanged drag snaps back
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
      <div className="board" onKeyDownCapture={(e) => {
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
          onNodeClick={(ev, n) => { keySelect.current = false; const p = pickOfNode(n); if (p) select(p, ev.ctrlKey || ev.metaKey); }}
          onEdgeClick={(ev, e) => { keySelect.current = false; const p = pickOfEdge(e); if (p) select(p, ev.ctrlKey || ev.metaKey); }}
          onPaneClick={(ev) => select(null, ev.ctrlKey || ev.metaKey)}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--dot)" />
          {bar && <Panel position="top-center" className="selbar-panel">{bar}</Panel>}
          <BoardMiniMap nodes={nodes} picked={picked} />
          <Controls showInteractive={false} orientation="vertical" />
        </ReactFlow>
      </div>
    </ToolbarContext.Provider>
  );
}

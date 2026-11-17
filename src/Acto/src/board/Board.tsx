import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { applyNodeChanges, Background, BackgroundVariant, Controls, Panel, ReactFlow, useStore, type EdgeChange, type EdgeTypes, type Node, type NodeChange, type NodeTypes, type Viewport } from '@xyflow/react';
import { HEADER_H, ZOOM_DETAIL } from './geometry';
import type { BoardWorkflow } from './loadBoard';
import { pickKey, type Pick } from './picks';
import { toFlow } from './toFlow';
import { LinkWire } from './edges/LinkWire';
import { CacheChip } from './nodes/CacheChip';
import { dropVerdictItem, stepAt, type DropItem } from './dropTarget';
import { focusBounds } from './focus';
import { StepCard } from './nodes/StepCard';
import { WorkflowFrame } from './nodes/WorkflowFrame';
import { BoardMiniMap } from './BoardMiniMap';
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
  /** Everything one drag moved inside `wf`: step positions (frame-local) and/or the frame, as one history step. */
  moveMany(wf: string, moved: { steps: { id: string; at: { x: number; y: number } }[]; frame?: { x: number; y: number } }): void;
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
  /** Pinned top-centre of the board (the selection bar). */
  bar?: ReactNode;
  /** False while workflows are still arriving: the first fit of every frame waits until it turns true. */
  settled?: boolean;
  /**
   * Filled by the board with its pan: centres the view on a workflow's frame (or, given, its steps) at the current zoom.
   * The chat's `focus` command calls it; it changes nothing else.
   */
  focusRef?: MutableRefObject<BoardFocus | null>;
  /**
   * The workflow as it is now, for `focusRef` (App: the board store's): a tool pans right after its store edit, before
   * React has drawn it, so the `workflows` of the last render may not hold it yet. Without it, the last render's.
   */
  workflowNow?: (workflowId: string) => BoardWorkflow | undefined;
}

/** Pans the board to a workflow (and, given, steps in it); a workflow not on the board is ignored. */
export type BoardFocus = (workflowId: string, stepIds?: string[]) => void;

export function Board({ workflows, picks, onPick, initialZoom, initialView, onViewChange, onEdit, toolbar, onDropItem, bar, settled = true, focusRef, workflowNow }: BoardProps) {
  const fitAtMount = useRef(settled);
  const flow = useRef<{
    getViewport: () => Viewport; fitView: () => unknown; screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number };
    setCenter: (x: number, y: number, o?: { zoom?: number; duration?: number }) => unknown;
  } | null>(null);
  const workflowsNow = useRef(workflows);
  workflowsNow.current = workflows;
  const lookup = useRef(workflowNow);
  lookup.current = workflowNow;
  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = (workflowId, stepIds) => {
      const w = lookup.current ? lookup.current(workflowId) : workflowsNow.current.find((x) => x.graph.workflow.id === workflowId);
      const rf = flow.current;
      if (!w || !rf) return;
      const b = focusBounds(w.frame, w.stepAt, stepIds);
      void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: rf.getViewport().zoom, duration: 300 });
    };
    return () => { focusRef.current = null; };
  }, [focusRef]);
  // the first fit waited for the last workflow: fit once it is in (a saved view or a given zoom is never fitted over)
  useEffect(() => {
    if (!settled || fitAtMount.current) return;
    if (initialView !== undefined || initialZoom !== undefined) { fitAtMount.current = true; return; }
    // let React Flow measure the frames that just arrived first
    const raf = requestAnimationFrame(() => { fitAtMount.current = true; void flow.current?.fitView(); });
    return () => cancelAnimationFrame(raf);
  }, [settled, initialView, initialZoom]);
  const select = (s: Pick | null, additive = false) => {
    if (flow.current) onViewChange?.(flow.current.getViewport());
    onPick(s, additive);
  };
  // React Flow's own selection is off: picks decide. Only a keyboard select (Enter/Space on a focused node) comes from it.
  const keySelect = useRef(false);
  const picked = useMemo(() => new Set(picks.map(pickKey)), [picks]);
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
    // after Esc the pointer may still be down: its moves must not drag the nodes away again
    const cancelled = drag.current?.cancelled === true;
    // nodes leave the board only through the store: a 'remove' from React Flow would hide what is still there
    setDragged((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'select' && c.type !== 'remove' && !(cancelled && c.type === 'position')), ns));
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!keySelect.current) return;
    const id = changes.flatMap((c) => (c.type === 'select' && c.selected ? [c.id] : []))[0];
    const e = id === undefined ? undefined : edges.find((x) => x.id === id);
    if (e) { keySelect.current = false; const d = e.data as { workflowId: string; wireId: string }; select({ kind: 'wire', workflowId: d.workflowId, wireId: d.wireId }); }
  };
  const dataOf = (n: Node) => n.data as unknown as NodeData;

  // A drag in progress: where each dragged node began, and whether Esc has cancelled it.
  const drag = useRef<{ start: Map<string, { x: number; y: number }>; cancelled: boolean } | null>(null);
  const dragStart = (n: Node, all?: Node[]) => {
    drag.current = { start: new Map((all && all.length > 0 ? all : [n]).map((m) => [m.id, { ...m.position }])), cancelled: false };
  };
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const d = drag.current;
      if (e.key !== 'Escape' || !d || d.cancelled) return;
      d.cancelled = true;
      setDragged((ns) => ns.map((n) => { const p = d.start.get(n.id); return p ? { ...n, position: { ...p } } : n; }));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editable]);

  /** One edit per workflow, however many nodes React Flow dragged together. */
  const dragStop = (n: Node, all?: Node[]) => {
    const cancelled = drag.current?.cancelled === true;
    drag.current = null;
    if (!onEdit) return;
    if (cancelled) { setDragged(derivedRef.current); return; }
    const moved = new Map<string, { steps: { id: string; at: { x: number; y: number } }[]; frame?: { x: number; y: number } }>();
    for (const m of all && all.length > 1 ? all : [n]) {
      const d = dataOf(m);
      const w = byId.get(d.workflowId);
      if (!w) continue;
      const entry = () => { let e = moved.get(d.workflowId); if (!e) { e = { steps: [] }; moved.set(d.workflowId, e); } return e; };
      if (m.type === 'step' && d.stepId !== undefined) {
        const cur = w.stepAt.get(d.stepId);
        const at = { x: m.position.x, y: m.position.y - HEADER_H };
        if (!cur || cur.x !== at.x || cur.y !== at.y) entry().steps.push({ id: d.stepId, at });
      } else if (m.type === 'workflow') {
        if (w.frame.x !== m.position.x || w.frame.y !== m.position.y) entry().frame = { x: m.position.x, y: m.position.y };
      }
    }
    for (const [wf, e] of moved) onEdit.moveMany(wf, e);
    setDragged(derivedRef.current); // a refused or unchanged drag snaps back
  };
  const nodeById = (id: string) => nodes.find((x) => x.id === id);

  return (
    <BoardContext.Provider value={byId}>
      <EditContext.Provider value={onEdit ?? null}>
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
          {...(editable ? {
            onNodesChange,
            onNodeDragStart: (_: unknown, n: Node, all?: Node[]) => dragStart(n, all),
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
            : initialZoom !== undefined ? { defaultViewport: { x: 0, y: 0, zoom: initialZoom } } : { fitView: fitAtMount.current })}
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
          selectionKeyCode={null}
          deleteKeyCode={null}
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
          {bar && <Panel position="top-center">{bar}</Panel>}
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <BoardMiniMap picked={picked} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      </ToolbarContext.Provider>
      </EditContext.Provider>
    </BoardContext.Provider>
  );
}

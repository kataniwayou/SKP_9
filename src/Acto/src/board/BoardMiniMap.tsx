import { createContext, useContext, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { MiniMap, useReactFlow, useStore, useStoreApi, type MiniMapNodeProps } from '@xyflow/react';
import { BoardContext, useBoardWorkflow } from './nodes/boardContext';
import { STATE_COLOUR } from './live/StateBadge';
import { useWorkflowStatus } from '../live/LiveContext';
import { minimapLabel, minimapScale } from './minimapScale';
import { processorColour } from './nodes/StepCard';
import { HEADER_H } from './geometry';

/** The mock's minimap: 210 × 130. */
const SIZE = { w: 210, h: 130 };

interface Rect { x: number; y: number; w: number; h: number }
/** `top`: the minimap's upper edge in board units (React Flow pads its content by 5 minimap units). */
interface MiniInfo { picked: ReadonlySet<string>; scale: number; frames: ReadonlyMap<string, Rect>; top: number }
const MiniContext = createContext<MiniInfo>({ picked: new Set(), scale: 1, frames: new Map(), top: -Infinity });

/** The free gap over a frame: up to the lowest frame above it that it overlaps sideways, or the minimap's edge. */
function gapAbove(id: string, f: Rect, frames: ReadonlyMap<string, Rect>, top: number): number {
  let limit = top;
  for (const [k, g] of frames) {
    if (k !== id && g.x < f.x + f.w && g.x + g.w > f.x && g.y + g.h <= f.y) limit = Math.max(limit, g.y + g.h);
  }
  return f.y - limit;
}

function FrameMini({ id, x, y, width, height, onClick }: MiniMapNodeProps) {
  const workflowId = id.slice(3);
  const { picked, scale, frames, top } = useContext(MiniContext);
  const w = useBoardWorkflow(workflowId);
  const status = useWorkflowStatus(workflowId);
  if (!w) return null;
  const on = picked.has(id);
  const name = w.graph.workflow.name;
  // the name's room: the band from the frame's top to its first step, and the gap over the frame
  const tops = [...w.stepAt.values()].map((p) => HEADER_H + p.y);
  const inside = tops.length > 0 ? Math.min(...tops) : height;
  const l = minimapLabel(width, { inside, above: gapAbove(id, { x, y, w: width, h: height }, frames, top) }, scale, name);
  return (
    <g data-mini-frame={workflowId} style={{ cursor: 'pointer' }} onClick={onClick ? (e: ReactMouseEvent<SVGGElement>) => onClick(e, id) : undefined}>
      <title>{name}</title>
      <rect x={x} y={y} width={width} height={height} rx={l.stroke * 3}
        style={{ fill: on ? 'rgba(255,0,114,.18)' : 'var(--mini-frame)', stroke: on ? 'var(--accent)' : STATE_COLOUR[status] }} strokeWidth={l.stroke} />
      {l.text && (
        <text x={x + l.fontSize * 0.5} y={y + l.y} fontSize={l.fontSize} fontWeight={600} strokeWidth={l.stroke * 1.5} strokeLinejoin="round"
          style={{ pointerEvents: 'none', fill: 'var(--mini-ink)', stroke: 'var(--mini-frame)', paintOrder: 'stroke' }}>
          {l.text}
        </text>
      )}
    </g>
  );
}

/** A step as the mock draws it: a block in its processor's colour. */
function StepMini({ id, x, y, width, height }: MiniMapNodeProps) {
  const byId = useContext(BoardContext);
  const [, wf, stepId] = id.split(':');
  const w = byId.get(wf ?? '');
  const step = w?.graph.steps.get(stepId ?? '');
  const proc = step?.processorId ? w?.graph.processors.get(step.processorId)?.name : undefined;
  return <rect data-mini-step="" x={x} y={y} width={width} height={height} rx={Math.min(14, height / 6)} fill={processorColour(proc ?? '')} opacity={0.75} style={{ pointerEvents: 'none' }} />;
}

/** Caches mount this too: they must cost nothing, so no hook runs before the id check. */
function MiniNode(p: MiniMapNodeProps) {
  return p.id.startsWith('wf:') ? <FrameMini {...p} /> : p.id.startsWith('st:') ? <StepMini {...p} /> : null;
}

/** Inside the flow: the minimap with frame names, accent outlines for picks, and click-to-jump at the current zoom. */
export function BoardMiniMap({ picked }: { picked: ReadonlySet<string> }) {
  const { setCenter } = useReactFlow();
  const api = useStoreApi();
  const byId = useContext(BoardContext);
  const rects = useMemo(() => new Map([...byId.values()].map((w) => [`wf:${w.graph.workflow.id}`, { x: w.frame.x, y: w.frame.y, w: w.frame.w, h: w.frame.h }])), [byId]);
  const frames = useMemo(() => [...rects.values()], [rects]);
  const scale = useStore((s) => {
    const z = s.transform[2];
    return minimapScale(frames, { x: -s.transform[0] / z, y: -s.transform[1] / z, w: s.width / z, h: s.height / z }, SIZE);
  });
  const viewTop = useStore((s) => -s.transform[1] / s.transform[2]);
  const top = Math.min(viewTop, ...frames.map((f) => f.y)) - 5 * scale;
  const info = useMemo(() => ({ picked, scale, frames: rects, top }), [picked, scale, rects, top]);
  return (
    <MiniContext.Provider value={info}>
      <MiniMap pannable zoomable nodeComponent={MiniNode} style={{ width: SIZE.w, height: SIZE.h }} maskStrokeWidth={1.5}
        onNodeClick={(_, n) => {
          if (n.type !== 'workflow') return;
          const w = n.measured?.width ?? n.width ?? 0;
          const h = n.measured?.height ?? n.height ?? 0;
          void setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: api.getState().transform[2] });
        }} />
    </MiniContext.Provider>
  );
}

import { createContext, useContext, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { MiniMap, useReactFlow, useStoreApi, type Node, type MiniMapNodeProps } from '@xyflow/react';
import type { LiveStatus } from '../api/liveStatus';
import { STATE_COLOUR } from './live/StateBadge';
import { processorColour } from './nodes/StepCard';
import { TRI_SHAPE_H, TRI_SHAPE_W } from './geometry';

/** The mock's minimap: 210 × 130. */
const SIZE = { w: 210, h: 130 };

interface Mark { kind: 'workflow' | 'step' | 'cache'; colour: string; dim: boolean }
interface MiniInfo { marks: ReadonlyMap<string, Mark>; picked: ReadonlySet<string> }
const MiniContext = createContext<MiniInfo>({ marks: new Map(), picked: new Set() });

/** Triangles by run state (green running, red stopped, amber unknown), steps by processor tone, caches grey. */
export function markOf(n: Node): Mark {
  const dim = (n.className ?? '').split(' ').includes('dim');
  const d = n.data as { status?: LiveStatus; processor?: string | null };
  if (n.type === 'workflow') return { kind: 'workflow', colour: STATE_COLOUR[d.status ?? 'unknown'], dim };
  if (n.type === 'cache') return { kind: 'cache', colour: 'var(--idle)', dim };
  return { kind: 'step', colour: processorColour(d.processor ?? ''), dim };
}

/** One small mark: a triangle, a step block or a cache block. */
function MiniNode({ id, x, y, width, height, onClick }: MiniMapNodeProps) {
  const { marks, picked } = useContext(MiniContext);
  const m = marks.get(id);
  if (!m) return null;
  const on = picked.has(id);
  const click = onClick ? (e: ReactMouseEvent<SVGElement>) => onClick(e, id) : undefined;
  const style = { cursor: 'pointer', fill: m.colour, stroke: on ? 'var(--accent)' : 'none', strokeWidth: on ? 6 : 0, opacity: m.dim ? 0.3 : 0.85 } as const;
  return m.kind === 'workflow'
    ? <polygon data-mini-triangle={id.slice(3)} points={`${x},${y} ${x + (width * TRI_SHAPE_W) / 120},${y + (TRI_SHAPE_H / 2) * (height / 104)} ${x},${y + TRI_SHAPE_H * (height / 104)}`} style={style} onClick={click} />
    : <rect data-mini-step={m.kind === 'step' ? '' : undefined} data-mini-cache={m.kind === 'cache' ? '' : undefined} x={x} y={y} width={width} height={height}
      rx={Math.min(14, height / 6)} style={style} onClick={click} />;
}

/** Inside the flow: the minimap with a mark per node, accent outlines for picks, and click-to-jump at the current zoom. */
export function BoardMiniMap({ nodes, picked }: { nodes: readonly Node[]; picked: ReadonlySet<string> }) {
  const { setCenter } = useReactFlow();
  const api = useStoreApi();
  const marks = useMemo(() => new Map(nodes.map((n) => [n.id, markOf(n)])), [nodes]);
  const info = useMemo(() => ({ marks, picked }), [marks, picked]);
  return (
    <MiniContext.Provider value={info}>
      <MiniMap pannable zoomable nodeComponent={MiniNode} style={{ width: SIZE.w, height: SIZE.h }} maskStrokeWidth={1.5}
        onNodeClick={(_, n) => {
          const w = n.measured?.width ?? n.width ?? 0;
          const h = n.measured?.height ?? n.height ?? 0;
          void setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: api.getState().transform[2] });
        }} />
    </MiniContext.Provider>
  );
}

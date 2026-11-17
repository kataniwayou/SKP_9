import { createContext, useContext, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { MiniMap, useReactFlow, useStore, useStoreApi, type MiniMapNodeProps } from '@xyflow/react';
import { BoardContext, useBoardWorkflow } from './nodes/boardContext';
import { STATE_COLOUR } from './live/StateBadge';
import { useWorkflowStatus } from '../live/LiveContext';
import { minimapLabel, minimapScale } from './minimapScale';

const ACCENT = '#FF0072';

interface MiniInfo { picked: ReadonlySet<string>; scale: number }
const MiniContext = createContext<MiniInfo>({ picked: new Set(), scale: 1 });

function FrameMini({ id, x, y, width, height, onClick }: MiniMapNodeProps) {
  const workflowId = id.slice(3);
  const { picked, scale } = useContext(MiniContext);
  const w = useBoardWorkflow(workflowId);
  const status = useWorkflowStatus(workflowId);
  if (!w) return null;
  const on = picked.has(id);
  const name = w.graph.workflow.name;
  const l = minimapLabel(width, scale, name);
  return (
    <g data-mini-frame={workflowId} style={{ cursor: 'pointer' }} onClick={onClick ? (e: ReactMouseEvent<SVGGElement>) => onClick(e, id) : undefined}>
      <title>{name}</title>
      <rect x={x} y={y} width={width} height={height} rx={l.stroke * 2} fill={on ? 'rgba(255,0,114,.08)' : 'rgba(255,255,255,.7)'}
        stroke={on ? ACCENT : STATE_COLOUR[status]} strokeWidth={l.stroke} />
      {l.text && (
        <text x={x + l.fontSize * 0.4} y={y + l.fontSize * 1.3} fontSize={l.fontSize} fontWeight={600} fill="#1f2433" style={{ pointerEvents: 'none' }}>
          {l.text}
        </text>
      )}
    </g>
  );
}

/** Steps and caches mount this too: they must cost nothing, so no hook runs before the id check. */
function MiniNode(p: MiniMapNodeProps) {
  return p.id.startsWith('wf:') ? <FrameMini {...p} /> : null;
}

/** Inside the flow: the minimap with frame names, accent outlines for picks, and click-to-jump at the current zoom. */
export function BoardMiniMap({ picked }: { picked: ReadonlySet<string> }) {
  const { setCenter } = useReactFlow();
  const api = useStoreApi();
  const byId = useContext(BoardContext);
  const frames = useMemo(() => [...byId.values()].map((w) => ({ x: w.frame.x, y: w.frame.y, w: w.frame.w, h: w.frame.h })), [byId]);
  const scale = useStore((s) => {
    const z = s.transform[2];
    return minimapScale(frames, { x: -s.transform[0] / z, y: -s.transform[1] / z, w: s.width / z, h: s.height / z });
  });
  const info = useMemo(() => ({ picked, scale }), [picked, scale]);
  return (
    <MiniContext.Provider value={info}>
      <MiniMap pannable zoomable nodeComponent={MiniNode}
        onNodeClick={(_, n) => {
          if (n.type !== 'workflow') return;
          const w = n.measured?.width ?? n.width ?? 0;
          const h = n.measured?.height ?? n.height ?? 0;
          void setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: api.getState().transform[2] });
        }} />
    </MiniContext.Provider>
  );
}

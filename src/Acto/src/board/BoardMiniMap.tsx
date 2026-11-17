import { useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { MiniMap, useReactFlow, useStoreApi, type MiniMapNodeProps } from '@xyflow/react';
import { useBoardWorkflow } from './nodes/boardContext';
import { STATE_COLOUR } from './live/StateBadge';
import { useWorkflowStatus } from '../live/LiveContext';

const ACCENT = '#FF0072';

/** Fits `name` to `room` board units at font size `size` (about 0.6 em per character). */
function fit(name: string, room: number, size: number): string {
  const max = Math.max(1, Math.floor(room / (size * 0.6)));
  return name.length <= max ? name : `${name.slice(0, Math.max(1, max - 1))}…`;
}

/** One frame on the minimap: an outline stroked by state (accent when picked) and its name. Steps and caches draw nothing. */
function frameOf(picked: ReadonlySet<string>) {
  return function MiniFrame({ id, x, y, width, height, onClick }: MiniMapNodeProps) {
    const workflowId = id.startsWith('wf:') ? id.slice(3) : '';
    const w = useBoardWorkflow(workflowId);
    const status = useWorkflowStatus(workflowId);
    if (!workflowId || !w) return null;
    const on = picked.has(id);
    // sized from the frame, not the screen: the minimap scales everything together, so the name stays in proportion
    const size = Math.max(16, height * 0.2);
    const stroke = Math.max(6, width * 0.012);
    return (
      <g data-mini-frame={workflowId} style={{ cursor: 'pointer' }} onClick={onClick ? (e: ReactMouseEvent<SVGGElement>) => onClick(e, id) : undefined}>
        <rect x={x} y={y} width={width} height={height} rx={8} fill={on ? 'rgba(255,0,114,.08)' : 'rgba(255,255,255,.7)'}
          stroke={on ? ACCENT : STATE_COLOUR[status]} strokeWidth={on ? stroke * 1.6 : stroke} />
        <text x={x + size * 0.5} y={y + size * 1.3} fontSize={size} fontWeight={600} fill="#1f2433" style={{ pointerEvents: 'none' }}>
          {fit(w.graph.workflow.name, width - size, size)}
        </text>
      </g>
    );
  };
}

/** Inside the flow: the minimap with frame names, accent outlines for picks, and click-to-jump at the current zoom. */
export function BoardMiniMap({ picked }: { picked: ReadonlySet<string> }) {
  const { setCenter } = useReactFlow();
  const api = useStoreApi();
  const nodeComponent = useMemo(() => frameOf(picked), [picked]);
  return (
    <MiniMap pannable zoomable nodeComponent={nodeComponent}
      onNodeClick={(_, n) => {
        const w = n.measured?.width ?? n.width ?? 0;
        const h = n.measured?.height ?? n.height ?? 0;
        if (n.type !== 'workflow') return;
        void setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: api.getState().transform[2] });
      }} />
  );
}

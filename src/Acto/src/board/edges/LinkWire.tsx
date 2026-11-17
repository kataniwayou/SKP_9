import { useStore, type EdgeProps } from '@xyflow/react';
import { useWorkflowStatus } from '../../live/LiveContext';
import { conditionStyle } from '../wires';
import type { Point } from '../../model/geometry';
import { ZOOM_DETAIL } from '../geometry';

export function LinkWire({ id, data, selected }: EdgeProps) {
  const workflowId = (data as { workflowId?: string } | undefined)?.workflowId ?? '';
  const running = useWorkflowStatus(workflowId) === 'running';
  const far = useStore((s) => s.transform[2] < ZOOM_DETAIL);
  if (far) return null;
  const { condition, out, in: inn } = data as { condition: number; out: Point; in: Point };
  const style = conditionStyle(condition);
  const tx = inn.x - 9;
  const dx = Math.max(40, Math.abs(tx - out.x) / 2);
  const d = `M ${out.x} ${out.y} C ${out.x + dx} ${out.y}, ${tx - dx} ${inn.y}, ${tx} ${inn.y}`;
  // the letter pill sits about 24 px before the target, on the curve
  const t = 1 - 24 / Math.max(48, Math.hypot(tx - out.x, inn.y - out.y));
  const u = 1 - t;
  const px = u ** 3 * out.x + 3 * u * u * t * (out.x + dx) + 3 * u * t * t * (tx - dx) + t ** 3 * tx;
  const py = u ** 3 * out.y + 3 * u * u * t * out.y + 3 * u * t * t * inn.y + t ** 3 * inn.y;
  const marker = `arrow-${id}`;
  return (
    <g className={`link-wire${selected ? ' sel' : ''}`} data-condition={style.name}>
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={style.colour} />
        </marker>
      </defs>
      <path className="wire-hit" d={d} />
      <path className={`wire${selected ? ' sel' : ''}${running ? ' running' : ''}`} d={d} stroke={style.colour} strokeWidth={selected ? 3.6 : 2.2} fill="none" markerEnd={`url(#${marker})`} />
      <circle cx={px} cy={py} r={8} fill={style.colour} />
      <text className="pilltx" x={px} y={py} textAnchor="middle" dominantBaseline="central">{style.letter}</text>
    </g>
  );
}

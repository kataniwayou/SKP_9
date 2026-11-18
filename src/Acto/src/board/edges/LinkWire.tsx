import type { EdgeProps } from '@xyflow/react';
import { conditionStyle } from '../wires';
import { wirePath } from '../wirePath';
import type { PickInfo } from '../toFlow';
import { EdgeExtras } from './EdgeExtras';

/** One wire (edge type `wire`): a 2.2 px curve in the target's entry colour, its arrowhead, the letter pill just before it. Dashes move while it runs. */
export function LinkWire({ id, data, selected, sourceX, sourceY, targetX, targetY }: EdgeProps) {
  const { condition, from, to, running, pick } = data as { condition: number; from: string; to: string; running: boolean; pick?: PickInfo };
  const style = conditionStyle(condition);
  const { d, pill } = wirePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  // the curve's middle (its control points are symmetric): where a wire's pick number and toolbar sit
  const mx = (sourceX + targetX - 9) / 2;
  const my = (sourceY + targetY) / 2;
  const marker = `arrow-${id}`;
  return (
    <g className={`link-wire${selected ? ' sel' : ''}`} data-condition={style.name}>
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="1" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={style.colour} />
        </marker>
      </defs>
      <path className="wire-hit" d={d} />
      <path className={`wire${selected ? ' sel' : ''}${running ? ' running' : ''}`} d={d} stroke={style.colour} fill="none" markerEnd={`url(#${marker})`} />
      <circle className="pill" cx={pill.x} cy={pill.y} r={8} fill={style.colour} />
      <text className="pilltx" x={pill.x} y={pill.y + 3.5} textAnchor="middle">{style.letter}</text>
      <EdgeExtras id={id} pick={pick} self={{ kind: 'wire', from, to }} selected={selected} x={mx} y={my - 4} />
    </g>
  );
}

import type { EdgeProps } from '@xyflow/react';
import { conditionStyle } from '../wires';
import { wirePath } from '../wirePath';
import type { PickInfo } from '../toFlow';
import { EdgeExtras } from './EdgeExtras';

/** The `Never` entry condition. */
const NEVER = 5;

/**
 * One wire (edge type `wire`): a 2.2 px ink curve and its arrowhead. Dashes move while it runs. It carries no condition of its
 * own [user, 2026-11-25]: the entry condition belongs to the step it leads into, whose pill already shows it, so the wire
 * draws no colour or letter for it. The one exception is Never: a wire into a Never step never fires, so it is faded with a
 * hollow head, as a frozen entry arrow is. `data-condition` still names the target's condition, for tests and tools.
 */
export function LinkWire({ id, data, selected, sourceX, sourceY, targetX, targetY }: EdgeProps) {
  const { condition, from, to, running, ghost = false, ghostKey, pick } = data as { condition: number; from: string; to: string; running: boolean; ghost?: boolean; ghostKey?: string; pick?: PickInfo };
  const style = conditionStyle(condition);
  const never = condition === NEVER;
  const { d } = wirePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  // the curve's middle (its control points are symmetric): where a wire's pick number and toolbar sit
  const mx = (sourceX + targetX - 9) / 2;
  const my = (sourceY + targetY) / 2;
  const marker = `arrow-${id}`;
  return (
    <g className={`link-wire${selected ? ' sel' : ''}${never ? ' never' : ''}${ghost ? ' ghost' : ''}`} data-condition={style.name}>
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="1" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
          {/* the hollow head is inset a unit so its outline is not clipped by the marker box */}
          <path className={`wire-head${never ? ' hollow' : ''}`} d={never ? 'M 1 1 L 9 5 L 1 9 z' : 'M 0 0 L 10 5 L 0 10 z'} />
        </marker>
      </defs>
      <path className="wire-hit" d={d} />
      <path className={`wire${selected ? ' sel' : ''}${running ? ' running' : ''}`} d={d} fill="none" markerEnd={`url(#${marker})`} />
      <EdgeExtras id={id} pick={pick} self={ghostKey ? { kind: 'ghost', key: ghostKey } : { kind: 'wire', from, to }} selected={selected} x={mx} y={my - 4} />
    </g>
  );
}

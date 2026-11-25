import type { CSSProperties } from 'react';
import { getBezierPath, type EdgeProps } from '@xyflow/react';
import type { EntryIdle, PickInfo } from '../toFlow';
import { EdgeExtras } from './EdgeExtras';

/**
 * An entry arrow (edge type `entry`): solid ink from a triangle's tip to an entry step; accent while its workflow is selected or it is picked.
 * An arrow that never fires [user, 2026-11-25] is faded with a hollow head and says why where its cron would be: `⏱ not scheduled` (no
 * cron) or the step card's pink N square and `frozen` (the step is Never). It never moves, whatever its workflow does.
 */
export function EntryEdge({ id, data, selected, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) {
  const { workflowId, stepId, hue, cron, running = false, idle = null, ghost = false, ghostKey, pick } = data as {
    workflowId: string; stepId: string; hue: string | null; cron?: string; running?: boolean; idle?: EntryIdle; ghost?: boolean; ghostKey?: string; pick?: PickInfo;
  };
  const [d, mx, my] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX: targetX - 2, targetY, targetPosition });
  const marker = `arrow-${id}`;
  const label = idle === 'frozen' ? 'frozen' : idle === 'unscheduled' ? '⏱ not scheduled' : cron ? `⏱ ${cron.trim()}` : null;
  // beside the midpoint, on the side the curve leaves empty (below-left of a descending arrow, below-right of a rising one)
  const descending = targetY >= sourceY;
  const lx = descending ? mx - 10 : mx + 10;
  const ly = my + 16;
  // frozen: the step card's N square [user, 2026-11-25] (18 px, Never's pink, the letter in white), then "frozen". The label is mono,
  // so its width is known without measuring: 6 characters at 0.6 em of 10 px.
  const SQ = 18, GAP = 4, FROZEN_W = 36;
  const sqX = descending ? lx - FROZEN_W - GAP - SQ : lx;
  return (
    <g className={`entry-edge${selected || hue !== null ? ' on' : ''}${idle ? ` idle ${idle}` : ''}${ghost ? ' ghost' : ''}`} data-idle={idle ?? undefined}
      style={hue !== null ? ({ '--hue': hue } as CSSProperties) : undefined}>
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
          {/* the hollow head is inset a unit so its outline is not clipped by the marker box */}
          <path className={`entry-head${idle ? ' hollow' : ''}`} d={idle ? 'M 1 1 L 9 5 L 1 9 z' : 'M 0 0 L 10 5 L 0 10 z'} />
        </marker>
      </defs>
      <path className="edge-hit" d={d} />
      <path className={`entry-line${running ? ' running' : ''}`} d={d} fill="none" markerEnd={`url(#${marker})`} />
      {/* below the picked-state toolbar and multi-pick badge */}
      {idle === 'frozen' && (
        <g className="entry-never-sq">
          <rect x={sqX} y={ly - 12.5} width={SQ} height={SQ} rx={4} />
          <text x={sqX + SQ / 2} y={ly} textAnchor="middle">N</text>
        </g>
      )}
      {label && (
        <text className={`entry-cron${idle ? ` idle ${idle}` : ''}`} x={idle === 'frozen' && !descending ? lx + SQ + GAP : lx} y={ly} textAnchor={descending ? 'end' : 'start'}>
          {label}
        </text>
      )}
      <EdgeExtras id={id} pick={pick} self={ghostKey ? { kind: 'ghost', key: ghostKey } : { kind: 'entry', workflowId, stepId }} selected={selected} x={mx} y={my - 4} />
    </g>
  );
}

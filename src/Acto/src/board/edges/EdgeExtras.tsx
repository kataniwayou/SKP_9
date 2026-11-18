import { EdgeLabelRenderer, EdgeToolbar } from '@xyflow/react';
import { ItemToolbar, useHasToolbar } from '../ItemToolbar';
import { PickBadge } from '../nodes/PickBadge';
import type { PickInfo } from '../toFlow';
import type { Pick } from '../selection';

/** What every edge adds over its line: the pick number (several picks) or the toolbar (one pick), at (x, y). */
export function EdgeExtras({ id, pick, self, selected, x, y }: { id: string; pick: PickInfo | undefined; self: Pick; selected: boolean | undefined; x: number; y: number }) {
  const toolbar = useHasToolbar(self);
  return (
    <>
      {pick && !pick.solo && (
        <EdgeLabelRenderer>
          <div className="pick-wire" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, pointerEvents: 'none' }}>
            <PickBadge pick={pick} className="inline" />
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && pick?.solo && toolbar && (
        <EdgeToolbar edgeId={id} x={x} y={y} isVisible alignX="center" alignY="bottom"><ItemToolbar pick={self} /></EdgeToolbar>
      )}
    </>
  );
}

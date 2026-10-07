import { ViewportPortal } from '@xyflow/react';
import type { GuideLine } from './guides';
import type { FlowRect } from './hit';

export interface DesignOverlayProps {
  band: FlowRect | null;
  /** Alignment guides while blocks are dragged (spec §3.4). */
  guides: GuideLine[];
}

/** Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), the alignment guides (§3.4), and from later tasks the ghost wire and a picked wire's handles. */
export function DesignOverlay({ band, guides }: DesignOverlayProps) {
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} />}
        {guides.map((l, i) => <line key={i} className="design-guide" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />)}
      </svg>
    </ViewportPortal>
  );
}

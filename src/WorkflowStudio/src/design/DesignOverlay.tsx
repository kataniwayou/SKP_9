import { ViewportPortal } from '@xyflow/react';
import type { FlowRect } from './hit';

export interface DesignOverlayProps {
  band: FlowRect | null;
}

/** Drawn above the blocks in flow coordinates: the rubber band (spec §3.2), and from later tasks the guides, the ghost wire and a picked wire's handles. */
export function DesignOverlay({ band }: DesignOverlayProps) {
  return (
    <ViewportPortal>
      <svg className="design-overlay" width={1} height={1}>
        {band && <rect className="design-band" x={band.x0} y={band.y0} width={band.x1 - band.x0} height={band.y1 - band.y0} />}
      </svg>
    </ViewportPortal>
  );
}

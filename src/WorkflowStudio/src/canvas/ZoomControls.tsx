import { useReactFlow, useStore } from '@xyflow/react';
import { FIT_VIEW_OPTIONS } from './fitOptions';
import { useFollowFit } from './followSize';

/**
 * Zoom and Fit for one document (spec §6.1). It must be rendered inside that document's
 * WorkflowCanvas (its `children`), so it drives that canvas's own React Flow instance and no other.
 */
export function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const follow = useFollowFit();
  return (
    <div className="zoom">
      <button type="button" aria-label="Zoom out" data-tip="Zoom out" onClick={() => { follow(false); void zoomOut(); }}>−</button>
      <output aria-label="Zoom level">{`${Math.round(zoom * 100)}%`}</output>
      <button type="button" aria-label="Zoom in" data-tip="Zoom in" onClick={() => { follow(false); void zoomIn(); }}>+</button>
      <button type="button" className="fit" aria-label="Fit" data-tip="Fit this workflow" onClick={() => { follow(true); void fitView(FIT_VIEW_OPTIONS); }}>Fit</button>
    </div>
  );
}

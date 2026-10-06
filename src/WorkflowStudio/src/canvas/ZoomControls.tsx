import { useReactFlow, useStore } from '@xyflow/react';
import { FIT_VIEW_OPTIONS } from './WorkflowCanvas';

/**
 * Zoom and Fit for one document (spec §6.1). It must be rendered inside that document's
 * WorkflowCanvas (its `children`), so it drives that canvas's own React Flow instance and no other.
 */
export function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  return (
    <div className="zoom">
      <button type="button" aria-label="Zoom out" data-tip="Zoom out" onClick={() => void zoomOut()}>−</button>
      <span aria-label="Zoom level">{`${Math.round(zoom * 100)}%`}</span>
      <button type="button" aria-label="Zoom in" data-tip="Zoom in" onClick={() => void zoomIn()}>+</button>
      <button type="button" className="fit" aria-label="Fit" data-tip="Fit this workflow" onClick={() => void fitView(FIT_VIEW_OPTIONS)}>Fit</button>
    </div>
  );
}

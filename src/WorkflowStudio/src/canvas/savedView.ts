/**
 * Where a document's view was (the session, spec §6.1): React Flow's viewport, and whether it still
 * followed Fit. A view that follows Fit is fitted again on restore, since the window may have changed.
 */
export interface SavedView {
  x: number;
  y: number;
  zoom: number;
  followFit: boolean;
  /**
   * The canvas size the view was taken at. A restored view keeps its centre against it, so a canvas that lays
   * out at another size first and then settles comes back where it was. Absent in sessions written before it.
   */
  width?: number;
  height?: number;
}

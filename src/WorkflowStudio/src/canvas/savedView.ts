/**
 * Where a document's view was (the session, spec §6.1): React Flow's viewport, and whether it still
 * followed Fit. A view that follows Fit is fitted again on restore, since the window may have changed.
 */
export interface SavedView {
  x: number;
  y: number;
  zoom: number;
  followFit: boolean;
}

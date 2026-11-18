/** The unsaved mark (spec §7): a small dot in the unsaved colours on an item with changes the board has not saved. */
export function UnsavedMark({ on }: { on: boolean | undefined }) {
  return on ? <span className="unsaved-mark" title="unsaved" aria-label="unsaved" role="img" /> : null;
}

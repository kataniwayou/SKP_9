import { isDocPanelId } from './ids';

/** Where dockview is about to show a drop overlay (its `DockviewGroupDropLocation`). */
export type DropKind = 'tab' | 'header_space' | 'content' | 'edge';

/**
 * Documents can only be dropped into or beside the document area (spec §6.2.4): onto a group that
 * already holds a document, never onto a tool pane's group and never onto the outer edge of the
 * whole layout. Tool panes may go anywhere, in among the documents included.
 *
 * `dragged` are the panel ids being dragged (one tab, or every panel of a dragged group);
 * `target` are the panel ids of the group under the pointer, or null when there is none;
 * `targetIsDocumentArea` is true for the document area while it is empty.
 */
export function canDrop(dragged: readonly string[], kind: DropKind, target: readonly string[] | null, targetIsDocumentArea = false): boolean {
  if (!dragged.some(isDocPanelId)) return true;
  if (kind === 'edge' || target === null) return false;
  return targetIsDocumentArea || target.some(isDocPanelId);
}

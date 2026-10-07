import type { EntityReadDto } from '../api/entities';
import type { InspectorTarget } from './inspectorTarget';

/** What a refresh keeps of a document's Inspector (spec §6.1): where it was drilled to, and what was typed. */
export interface InspectorDraft {
  /** The drill-downs below the selection, in order; empty: the selection itself is shown. */
  trail: InspectorTarget[];
  /** Typed text by field key, for the entity shown. A field typed back to its saved value is dropped. */
  edits: Record<string, string>;
}

/** Why the last save, create or remove did not happen: messages under their fields, a banner for the rest. */
export interface SaveFailure {
  fields: Record<string, string[]>;
  banner: string | null;
}

export interface InspectorState extends InspectorDraft {
  /** The shown entity's last GET and the target key it belongs to; null until it arrives. Not kept in the session. */
  saved: { key: string; dto: EntityReadDto } | null;
  /** Why the shown entity could not be read. */
  readError: string | null;
  /** A save, create or remove is in flight. */
  busy: boolean;
  /**
   * The token of the last write started here; a write's results apply only while it is still this one.
   * Navigation resets it to null, so a result that lands after the user moved on changes nothing.
   */
  write: number | null;
  failure: SaveFailure | null;
}

export const EMPTY_INSPECTOR: InspectorState = { trail: [], edits: {}, saved: null, readError: null, busy: false, write: null, failure: null };

export function hasEdits(draft: InspectorDraft): boolean {
  return Object.keys(draft.edits).length > 0;
}

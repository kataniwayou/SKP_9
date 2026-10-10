import type { EntityReadDto } from '../api/entities';
import type { InspectorTarget } from './inspectorTarget';

/** What a refresh keeps of a document's Inspector (spec §6.1): where it was drilled to. Typed text lives in the design (plan 8). */
export interface InspectorDraft {
  /** The drill-downs below the selection, in order; empty: the selection itself is shown. */
  trail: InspectorTarget[];
}

export interface InspectorState extends InspectorDraft {
  /**
   * The shown entity's base (its GET, or made up for what the database does not hold yet), the target key it belongs to,
   * and the document generation it was read in (`OpenDocument.generation`): read in an older one, it is shown until the
   * read in the current one lands (no blank form), then replaced.
   */
  saved: { key: string; dto: EntityReadDto; gen?: number } | null;
  /** Why the shown entity could not be read. */
  readError: string | null;
}

export const EMPTY_INSPECTOR: InspectorState = { trail: [], saved: null, readError: null };

/** The Save button's words: `Save` with nothing changed, `Save · N` with N changed rows, `Saving…` while it runs. */
export function saveLabel(unsaved: number, saving: boolean): string {
  if (saving) return 'Saving…';
  return unsaved === 0 ? 'Save' : `Save · ${unsaved}`;
}

/** The one board-wide Save (spec §8), in the top bar: disabled when nothing changed, while saving, or while blocked (outcome unknown). */
export function SaveButton({ unsaved, saving, blocked = false, onSave }: { unsaved: number; saving: boolean; blocked?: boolean; onSave: () => void }) {
  const off = unsaved === 0 || saving || blocked;
  return (
    <button type="button" className={`pbtn save-board${!off ? ' primary' : ''}`} disabled={off} onClick={onSave}
      title={blocked ? 'Save outcome unknown — reload before saving again' : undefined}>
      {saveLabel(unsaved, saving)}
    </button>
  );
}

/**
 * Discard [user, 2026-11-25], left of Save: drops every unsaved change at once, so Save's count resets and both go disabled.
 * Disabled exactly when there is nothing to discard or a Save is running. One undo step: Ctrl+Z brings the changes back.
 */
export function DiscardButton({ unsaved, saving, onDiscard }: { unsaved: number; saving: boolean; onDiscard: () => void }) {
  return (
    <button type="button" className="pbtn discard-board" disabled={unsaved === 0 || saving} onClick={onDiscard}
      title={unsaved === 0 ? undefined : `Discard ${unsaved === 1 ? 'the unsaved change' : `all ${unsaved} unsaved changes`} (Ctrl+Z brings ${unsaved === 1 ? 'it' : 'them'} back)`}>
      Discard
    </button>
  );
}

/** Shown only after Save was refused on rows changed elsewhere or gone: takes BaseAPI's version of exactly those rows. */
export function TakeStoredButton({ count, saving, onTake }: { count: number; saving: boolean; onTake: () => void }) {
  if (count === 0) return null;
  return (
    <button type="button" className="pbtn take-stored" disabled={saving} onClick={onTake}
      title="Drop your changes to the rows changed elsewhere and take the stored version">
      {`Take stored · ${count}`}
    </button>
  );
}

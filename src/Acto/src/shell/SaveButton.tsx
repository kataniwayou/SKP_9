/** The Save button's words: `Save` with nothing changed, `Save · N` with N changed rows, `Saving…` while it runs. */
export function saveLabel(unsaved: number, saving: boolean): string {
  if (saving) return 'Saving…';
  return unsaved === 0 ? 'Save' : `Save · ${unsaved}`;
}

/** The one board-wide Save (spec §8), in the top bar: disabled when nothing changed or while saving. */
export function SaveButton({ unsaved, saving, onSave }: { unsaved: number; saving: boolean; onSave: () => void }) {
  return (
    <button type="button" className={`pbtn save-board${unsaved > 0 && !saving ? ' primary' : ''}`} disabled={unsaved === 0 || saving} onClick={onSave}>
      {saveLabel(unsaved, saving)}
    </button>
  );
}

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

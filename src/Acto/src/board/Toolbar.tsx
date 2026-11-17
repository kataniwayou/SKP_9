export interface ToolbarSelection { kind: 'workflow' | 'step' | 'wire' | 'cache' }
export interface ToolbarButtons { onSave?: () => void; onDelete?: () => void }

/** The dark bar with its little arrow. Position it with NodeToolbar or EdgeLabelRenderer. */
export function Toolbar({ selection, actions, unsaved = false, saving = false }:
  { selection: ToolbarSelection; actions: ToolbarButtons; unsaved?: boolean; saving?: boolean }) {
  return (
    <div className="toolbar nodrag nopan" role="toolbar" onClick={(e) => e.stopPropagation()} aria-label={`${selection.kind} actions`}>
      {selection.kind === 'workflow'
        ? <button type="button" className={unsaved ? 'primary' : undefined} disabled={saving} onClick={actions.onSave}>{saving ? 'Saving…' : 'Save'}</button>
        : <button type="button" className="danger" onClick={actions.onDelete}>Delete</button>}
      <span className="toolbar-arrow" />
    </div>
  );
}

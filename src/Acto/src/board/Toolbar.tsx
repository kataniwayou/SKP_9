import type { RunOp } from '../operate/runWorkflow';

export interface ToolbarSelection { kind: 'workflow' | 'step' | 'wire' | 'cache' }
export interface ToolbarButtons { onSave?: () => void; onDelete?: () => void }
export interface ToolbarConfirm { text: string; onConfirm: () => void; onCancel: () => void }
export interface ToolbarRun { op: RunOp; enabled: boolean; onRun: () => void }

/** The dark bar with its little arrow. Position it with NodeToolbar or EdgeLabelRenderer. */
export function Toolbar({ selection, actions, unsaved = false, saving = false, run, confirm }:
  { selection: ToolbarSelection; actions: ToolbarButtons; unsaved?: boolean; saving?: boolean; run?: ToolbarRun; confirm?: ToolbarConfirm }) {
  return (
    <div className="toolbar nodrag nopan" role="toolbar" onClick={(e) => e.stopPropagation()} aria-label={`${selection.kind} actions`}>
      {selection.kind === 'workflow' && confirm
        ? <>
          <span className="confirm-text">{confirm.text}</span>
          <button type="button" className="danger" onClick={confirm.onConfirm}>Delete</button>
          <button type="button" onClick={confirm.onCancel}>Cancel</button>
        </>
        : selection.kind === 'workflow'
        ? <>
          {run && <button type="button" className={run.op === 'start' ? 'go' : 'stop'} disabled={!run.enabled} onClick={run.onRun}>{run.op === 'start' ? '▶ Start' : '■ Stop'}</button>}
          <button type="button" className={unsaved ? 'primary' : undefined} disabled={saving} onClick={actions.onSave}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="danger" onClick={actions.onDelete}>Delete</button>
        </>
        : <button type="button" className="danger" onClick={actions.onDelete}>Delete</button>}
      <span className="toolbar-arrow" />
    </div>
  );
}

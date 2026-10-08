import type { LiveStatus } from '../api/liveStatus';
import { ZoomControls } from '../canvas/ZoomControls';
import { entityName } from '../model/entityNames';
import type { Workflow } from '../model/graph';

const NOT_YET = 'Not available yet';

function StatusPill({ status }: { status: LiveStatus }) {
  switch (status) {
    case 'running': return <span className="run-chip">▶ running</span>;
    case 'stopped': return <span className="stopped">■ stopped</span>;
    case 'unknown': return <span className="unknown" data-tip="BaseApi could not say whether it runs">status unknown</span>;
    case 'checking': return <span className="unknown">checking…</span>;
  }
}

/**
 * A document's capsule toolbar (spec §6.1, mockup v49 .docbar): its name, cron, run status, Save,
 * Start and Stop, and its own zoom and Fit. Save stores the design (plan 8 §4.1); Start and Stop are
 * still disabled. It must be rendered inside the document's WorkflowCanvas, for ZoomControls.
 */
export function CapsuleToolbar({ workflow, status, save, design }: {
  workflow: Workflow; status: LiveStatus;
  /** The design's Save (plan 8 §4.1): enabled when the design differs from the base; read-only while it runs. */
  save?: { enabled: boolean; saving: boolean; onSave: () => void };
  /** The design draft (plan 4): its mark, Undo, Redo and Discard. */
  design?: { dirty: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onDiscard: () => void };
}) {
  return (
    <div className="docbar" role="toolbar" aria-label="Workflow">
      <div className="cap-b crumb" data-tip={entityName(workflow.name, workflow.version, workflow.id)}>
        <b>{workflow.name}</b><span className="ver">_{workflow.version}</span>
      </div>
      <span className="cap-b chip">⏱ {workflow.cronExpression || 'not scheduled'}</span>
      <div className="cap-b stat" aria-label="Status"><StatusPill status={status} /></div>
      {design?.dirty && <span className="cap-b dirtyl">● design draft</span>}
      <span className="spacer" />
      <div className="docact">
        {design && (
          <>
            <button type="button" className="qb" disabled={!design.canUndo} onClick={design.onUndo} data-tip="Undo (Ctrl+Z)">↶ Undo</button>
            <button type="button" className="qb" disabled={!design.canRedo} onClick={design.onRedo} data-tip="Redo (Ctrl+Y)">↷ Redo</button>
            <button type="button" className="qb" disabled={!design.dirty} onClick={design.onDiscard} data-tip="Drop every design change in this workflow">Discard design</button>
            <span className="qsep" />
          </>
        )}
        {save && (save.enabled || save.saving)
          ? <button type="button" className="qb" disabled={save.saving} onClick={save.onSave} data-tip="Store the design; BaseApi applies it when it finds no errors">{save.saving ? '⤓ Saving…' : '⤓ Save'}</button>
          : <span data-tip="Nothing to save yet"><button type="button" className="qb" disabled>⤓ Save</button></span>}
        <span className="qsep" />
        <span data-tip={NOT_YET}><button type="button" className="qb run" disabled>▶ Start</button></span>
        <span data-tip={NOT_YET}><button type="button" className="qb stop" disabled>■ Stop</button></span>
      </div>
      <ZoomControls />
    </div>
  );
}

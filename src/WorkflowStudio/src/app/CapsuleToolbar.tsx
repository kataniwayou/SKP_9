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
 * Start and Stop, and its own zoom and Fit. Save saves the Inspector's edits (slice 3b); Start and Stop are
 * still disabled. It must be rendered inside the document's WorkflowCanvas, for ZoomControls.
 */
export function CapsuleToolbar({ workflow, status, dirty, busy, blocked, onSave, design }: {
  workflow: Workflow; status: LiveStatus; dirty?: boolean; busy?: boolean;
  /** The edits would save a required field blank, as the Inspector's own Save says. */
  blocked?: boolean;
  onSave?: () => void;
  /** The design draft (plan 4): its mark, Undo, Redo and Discard. Never saved: Save above is the Inspector's only. */
  design?: { dirty: boolean; canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onDiscard: () => void };
}) {
  return (
    <div className="docbar" role="toolbar" aria-label="Workflow">
      <div className="cap-b crumb" data-tip={entityName(workflow.name, workflow.version, workflow.id)}>
        <b>{workflow.name}</b><span className="ver">_{workflow.version}</span>
      </div>
      <span className="cap-b chip">⏱ {workflow.cronExpression || 'not scheduled'}</span>
      <div className="cap-b stat" aria-label="Status"><StatusPill status={status} /></div>
      {dirty && <span className="cap-b dirtyl">● unsaved changes</span>}
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
        {dirty && onSave
          ? <button type="button" className="qb" disabled={busy || blocked} onClick={onSave} data-tip="Save the Inspector's changes">⤓ Save</button>
          : <span data-tip="Nothing to save yet"><button type="button" className="qb" disabled>⤓ Save</button></span>}
        <span className="qsep" />
        <span data-tip={NOT_YET}><button type="button" className="qb run" disabled>▶ Start</button></span>
        <span data-tip={NOT_YET}><button type="button" className="qb stop" disabled>■ Stop</button></span>
      </div>
      <ZoomControls />
    </div>
  );
}

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
export function CapsuleToolbar({ workflow, status, dirty, busy, blocked, onSave }: {
  workflow: Workflow; status: LiveStatus; dirty?: boolean; busy?: boolean;
  /** The edits would save a required field blank, as the Inspector's own Save says. */
  blocked?: boolean;
  onSave?: () => void;
}) {
  return (
    <div className="docbar" role="toolbar" aria-label="Workflow">
      <div className="cap-b crumb" data-tip={entityName(workflow.name, workflow.version, workflow.id)}>
        <b>{workflow.name}</b><span className="ver">_{workflow.version}</span>
      </div>
      <span className="cap-b chip">⏱ {workflow.cronExpression || 'not scheduled'}</span>
      <div className="cap-b stat" aria-label="Status"><StatusPill status={status} /></div>
      {dirty && <span className="cap-b dirtyl">● unsaved changes</span>}
      <span className="spacer" />
      <div className="docact">
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

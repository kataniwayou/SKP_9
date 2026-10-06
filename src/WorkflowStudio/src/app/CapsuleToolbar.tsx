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
 * Start and Stop, and its own zoom and Fit. Slice 3a writes nothing: Save, Start and Stop are
 * disabled. It must be rendered inside the document's WorkflowCanvas, for ZoomControls.
 */
export function CapsuleToolbar({ workflow, status }: { workflow: Workflow; status: LiveStatus }) {
  return (
    <div className="docbar" role="toolbar" aria-label="Workflow">
      <div className="cap-b crumb" data-tip={entityName(workflow.name, workflow.version, workflow.id)}>
        <b>{workflow.name}</b><span className="ver">_{workflow.version}</span>
      </div>
      <span className="cap-b chip">⏱ {workflow.cronExpression || 'not scheduled'}</span>
      <div className="cap-b stat" aria-label="Status"><StatusPill status={status} /></div>
      <span className="spacer" />
      <div className="docact">
        <span data-tip="Nothing to save yet"><button type="button" className="qb" disabled>⤓ Save</button></span>
        <span className="qsep" />
        <span data-tip={NOT_YET}><button type="button" className="qb run" disabled>▶ Start</button></span>
        <span data-tip={NOT_YET}><button type="button" className="qb stop" disabled>■ Stop</button></span>
      </div>
      <ZoomControls />
    </div>
  );
}

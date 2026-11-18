import { newId } from '../../design/ids';
import { assignmentOf, removeAssignment, setPayload } from '../../design/payloads';
import type { Id } from '../../model/graph';
import { TextField } from '../fields';
import { JsonField } from '../JsonField';
import { MetaToggle } from '../MetaToggle';
import { EntityHead, metaOfRow, PayloadCheckNote, stepName, type Ctx } from './shared';

/**
 * The workflow's assignment on the picked step: its fields (read-only here), its payload (pretty JSON) and the
 * config-schema check. No assignment yet: an empty payload that makes one on the first typing.
 */
export function AssignmentTab({ state, edit, stepId, workflowId }: Ctx & { stepId: Id; workflowId: Id }) {
  const wf = state.workflows[workflowId];
  if (!wf) return null;
  const assignment = assignmentOf(state, workflowId, stepId);
  const payload = assignment?.payload ?? '';
  const ro = () => undefined;
  return (
    <>
      <EntityHead name={`${stepName(state, stepId)} · ${wf.name}`} kind={`assignment · belongs to ${wf.name}`} />
      {assignment ? (
        <>
          <TextField key={`${assignment.id}:name`} label="Name" value={assignment.name} onChange={ro} disabled />
          <TextField key={`${assignment.id}:version`} label="Version" value={assignment.version} onChange={ro} disabled />
          <MetaToggle meta={metaOfRow(assignment)} />
          <TextField key={`${assignment.id}:description`} label="Description" value={assignment.description} onChange={ro} disabled />
        </>
      ) : <p className="none">{`No assignment yet: typing a payload makes one for ${wf.name}.`}</p>}
      <JsonField key={`${workflowId}:${stepId}:payload`} label="Payload" value={payload}
        onChange={(v) => { if (v === '' && !assignment) return; edit((b) => setPayload(b, workflowId, stepId, v, newId), `field:${workflowId}:${stepId}:payload`); }} />
      {assignment && <PayloadCheckNote state={state} stepId={stepId} payload={payload} />}
      {assignment && <button type="button" className="pbtn in-act" onClick={() => edit((b) => removeAssignment(b, workflowId, assignment.id))}>Remove assignment</button>}
    </>
  );
}

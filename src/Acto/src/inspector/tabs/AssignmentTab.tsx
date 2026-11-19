import type { BoardState } from '../../design/board';
import { newId } from '../../design/ids';
import { payloadSkeleton } from '../../model/assignments';
import { assignmentOf, removeAssignment, setAssignmentField, setPayload } from '../../design/payloads';
import type { Id } from '../../model/graph';
import { JsonField } from '../JsonField';
import { EntityBase, EntityHead, metaOfRow, PayloadCheckNote, stepName, type Ctx } from './shared';

/** The step's processor's config schema definition (null: no processor, no config schema, or not read). */
function configDefinition(b: BoardState, stepId: Id): string | null {
  const pid = b.steps[stepId]?.processorId;
  const sid = pid ? b.processors[pid]?.configSchemaId : null;
  return sid ? b.schemas[sid]?.definition ?? null : null;
}

/**
 * The workflow's assignment on the picked step: its fields, its payload (pretty JSON) and the config-schema check.
 * An assignment another workflow also links is copied for this one on its first edit (copy-on-write). No assignment
 * yet: Studio's "＋ Create" [user, 2026-11-19: "populate the payload with the json placeholders same as studio"] makes one
 * whose payload is laid out from the processor's config schema (`payloadSkeleton`: required keys as "<type>" markers the
 * check below names, optional ones as their default or empty value); typing into the empty payload still makes one too.
 */
export function AssignmentTab({ state, base, edit, stepId, workflowId }: Ctx & { stepId: Id; workflowId: Id }) {
  const wf = state.workflows[workflowId];
  if (!wf) return null;
  const assignment = assignmentOf(state, workflowId, stepId);
  const payload = assignment?.payload ?? '';
  const k = `${workflowId}:${stepId}`;
  const set = (key: 'name' | 'version' | 'description', v: string | null) =>
    edit((b) => {
      // by the row the workflow links now: a copy made by an earlier keystroke takes the original's place
      const cur = assignmentOf(b, workflowId, stepId);
      return cur ? setAssignmentField(b, workflowId, cur.id, key, v, newId) : b;
    }, `field:${k}:${key}`);
  return (
    <>
      {assignment ? (
        <EntityBase head={`${assignment.name} ${assignment.version}`} kind={`assignment · belongs to ${wf.name}`} k={k} row={assignment}
          meta={metaOfRow(assignment)} set={set} />
      ) : (
        <>
          <EntityHead name={`${stepName(state, stepId)} · ${wf.name}`} kind={`assignment · belongs to ${wf.name}`} />
          <p className="none">{`No assignment yet for ${wf.name}: ＋ Create lays out the payload from the config schema, or type one.`}</p>
          <button type="button" className="link in-create" onClick={() => edit((b) => setPayload(b, workflowId, stepId, payloadSkeleton(configDefinition(b, stepId)), newId))}>＋ Create</button>
        </>
      )}
      <JsonField key={`${k}:payload`} label="Payload" value={payload} saved={assignmentOf(base, workflowId, stepId)?.payload}
        onChange={(v) => { if (v === '' && !assignment) return; edit((b) => setPayload(b, workflowId, stepId, v, newId), `field:${k}:payload`); }} />
      {assignment && <PayloadCheckNote state={state} stepId={stepId} payload={payload} />}
      {assignment && <button type="button" className="pbtn in-act" onClick={() => edit((b) => removeAssignment(b, workflowId, assignment.id))}>Remove assignment</button>}
    </>
  );
}

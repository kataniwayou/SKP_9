import { reachOf } from '../../design/board';
import { setStepField } from '../../design/edits';
import type { Id } from '../../model/graph';
import { ConditionPicker } from '../ConditionPicker';
import { Field, Ro, Row, Sec } from '../fields';
import { EntityBase, locationText, metaOfRow, type Ctx } from './shared';

/** A step's own fields (shared by every workflow whose stream holds it), then who uses it. */
export function StepTab({ state, edit, id }: Ctx & { id: Id }) {
  const step = state.steps[id];
  if (!step) return null;
  const set = (key: 'name' | 'version' | 'description' | 'entryCondition', v: string | number | null) =>
    edit((b) => setStepField(b, id, key, v as never), `field:${id}:${key}`);
  const users = Object.values(state.workflows).filter((x) => reachOf(state, x.id).has(id)).map((x) => x.name);
  return (
    <>
      <EntityBase head={`${step.name} ${step.version}`} kind={users.length > 0 ? `step · shared by ${users.join(', ')}` : 'step'}
        k={id} row={step} meta={metaOfRow(step)} set={set} />
      <Field label="Entry condition">
        <ConditionPicker key={`${id}:entryCondition`} id={`ec-${id}`} label="Entry condition" value={String(step.entryCondition)}
          onChange={(v) => set('entryCondition', Number(v))} />
      </Field>
      <p className="in-note sub">Colours every wire into this step.</p>
      <Sec>Related</Sec>
      <Ro>
        <Row k="Used by">{users.length > 0 ? users.join(', ') : 'no workflow'}</Row>
        <Row k="Location">{locationText(step.at)}</Row>
      </Ro>
    </>
  );
}

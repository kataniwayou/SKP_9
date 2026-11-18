import { reachOf } from '../../design/board';
import { setStepField } from '../../design/edits';
import type { Id } from '../../model/graph';
import { CONDITIONS } from '../../model/entryConditions';
import { Ro, Row, SelectField, TextField } from '../fields';
import { MetaToggle } from '../MetaToggle';
import { EntityHead, metaOfRow, orNull, type Ctx } from './shared';

/** A step's own fields (shared by every workflow whose stream holds it) and who uses it. */
export function StepTab({ state, edit, id }: Ctx & { id: Id }) {
  const step = state.steps[id];
  if (!step) return null;
  const set = (key: 'name' | 'version' | 'description' | 'entryCondition', v: string | number | null) =>
    edit((b) => setStepField(b, id, key, v as never), `field:${id}:${key}`);
  const users = Object.values(state.workflows).filter((x) => reachOf(state, x.id).has(id)).map((x) => x.name);
  return (
    <>
      <EntityHead name={`${step.name} ${step.version}`} kind={users.length > 0 ? `step · shared by ${users.join(', ')}` : 'step'} />
      <TextField key={`${id}:name`} label="Name" value={step.name} onChange={(v) => set('name', v)} />
      <TextField key={`${id}:version`} label="Version" value={step.version} onChange={(v) => set('version', v)} />
      <MetaToggle meta={metaOfRow(step)} />
      <TextField key={`${id}:description`} label="Description" value={step.description} onChange={(v) => set('description', orNull(v))} />
      {/* Task 7 puts Studio's condition picker here */}
      <SelectField key={`${id}:entryCondition`} label="Entry condition" value={step.entryCondition}
        options={CONDITIONS.map((c) => ({ value: c.value, label: `${c.letter} · ${c.name}` }))} onChange={(v) => set('entryCondition', v)} />
      <p className="in-note sub">Colours every wire into this step.</p>
      <Ro><Row k="Used by">{users.length > 0 ? users.join(', ') : 'no workflow'}</Row></Ro>
    </>
  );
}

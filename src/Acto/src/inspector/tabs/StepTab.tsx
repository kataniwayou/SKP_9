import { conditionStyle } from '../../board/wires';
import { reachOf } from '../../design/board';
import { removeWires, setStepField } from '../../design/edits';
import type { Id } from '../../model/graph';
import { ConditionPicker } from '../ConditionPicker';
import { Field, Ro, Row, Sec } from '../fields';
import { selectPick, type SelectionState } from '../../board/selection';
import { EntityBase, LinkChip, locationText, metaOfRow, stepName, type Ctx } from './shared';

/** A step's own fields (shared by every workflow whose stream holds it), who uses it, and its wires out as chips (its name opens that step as a
 * plain click on it would, ✕ removes the wire) [user, 2026-11-19]. */
export function StepTab({ state, edit, id, go, sel }: Ctx & { id: Id; sel?: SelectionState }) {
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
      <Sec>Next steps</Sec>
      <div className="chips">
        {step.nextStepIds.length === 0 && <span className="none">none</span>}
        {step.nextStepIds.map((to) => (
          <LinkChip key={to} dot={conditionStyle(state.steps[to]?.entryCondition ?? 0).colour} name={stepName(state, to)}
            openLabel={`Open step ${stepName(state, to)}`}
            {...(go && sel ? { onOpen: () => go(selectPick(sel, { kind: 'step', id: to }, false).picks) } : {})}
            removeLabel={`Remove wire to ${stepName(state, to)}`} onRemove={() => edit((b) => removeWires(b, [[id, to]]))} />
        ))}
      </div>
      <p className="in-note">Drag from the step&apos;s right handle to another step to wire it; ✕ removes the wire.</p>
    </>
  );
}

import type { SchemaRow, Slot } from '../../design/board';
import { SLOT_FIELD } from '../../design/board';
import { setSlotSchema } from '../../design/edits';
import { newId } from '../../design/ids';
import type { Id } from '../../model/graph';
import { Ro, Row } from '../fields';
import { JsonField } from '../JsonField';
import type { Meta } from '../MetaToggle';
import { EntityBase, EntityHead, type Ctx } from './shared';

/** A schema copy made on the board has no audit of its own yet. */
export const schemaMeta = (s: SchemaRow): Meta => (s.updatedAt === null
  ? { id: s.id, createdAt: null, createdBy: null, updatedAt: null, updatedBy: null }
  : { id: s.id, createdAt: s.audit.createdAt, createdBy: s.audit.createdBy, updatedAt: s.audit.updatedAt, updatedBy: s.audit.updatedBy });

/**
 * The schema in one slot of the picked step's processor [user, 2026-11-18]: its fields and its Definition (pretty JSON).
 * Name, Version and Description edits go to the processor's own copy of the schema (setSlotSchema), never to the shared
 * row. `readOnly` (a processor card's slots, no step) disables every field. The Definition is read-only [user, 2026-11-19: "if you change any schema you will need to restart the processor"].
 */
export function SchemaTab({ state, edit, stepId, slot, processorId: given, readOnly }: Ctx & { stepId: Id | null; slot: Slot; processorId?: Id; readOnly?: boolean }) {
  const processorId = given ?? (stepId === null ? null : state.steps[stepId]?.processorId ?? null);
  const processor = processorId === null ? undefined : state.processors[processorId];
  if (processorId === null || !processor) return null;
  const schemaId = processor[SLOT_FIELD[slot]];
  if (schemaId === null) return null;
  const kind = `schema · ${slot} of ${processor.name}`;
  const schema = state.schemas[schemaId];
  if (!schema) return <><EntityHead name={schemaId} kind={kind} /><Ro><Row k="Schema">not loaded</Row></Ro></>;
  const set = (key: 'name' | 'version' | 'description', v: string | null) =>
    edit((b) => {
      const cur = b.schemas[b.processors[processorId]?.[SLOT_FIELD[slot]] ?? ''];
      if (!cur || cur.definition === null || cur.definition === undefined) return b;
      const copy = { id: cur.id, name: cur.name, version: cur.version, description: cur.description, definition: cur.definition ?? '', [key]: v };
      return setSlotSchema(b, processorId, slot, copy as typeof copy & { definition: string }, newId);
    }, `field:slot:${processorId}:${slot}:${key}`);
  const k = `schema:${processorId}:${slot}`;
  // a copy needs the definition: without it (not read yet) the schema is shown, not edited
  const definition = schema.definition ?? null;
  const unread = definition === null;
  return (
    <>
      <EntityBase head={`${schema.name} ${schema.version}`} kind={kind} k={k} row={schema} meta={schemaMeta(schema)} set={set} disabled={unread || readOnly === true} />
      {definition === null
        ? <Ro><Row k="Definition">not loaded</Row></Ro>
        : <JsonField key={`${k}:definition`} label="Definition" value={definition} onChange={() => {}} disabled />}
      <p className="in-note sub in-readonly">The definition is read-only: a change needs the processor restarted.</p>
    </>
  );
}

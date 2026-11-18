import type { BoardState, SchemaRow } from '../../design/board';
import { SLOT_FIELD, type Slot } from '../../design/board';
import { setProcessorField, setSlotSchema } from '../../design/edits';
import { newId } from '../../design/ids';
import { useProcessorLive } from '../../live/LiveContext';
import { livenessText } from '../../live/liveState';
import type { Id } from '../../model/graph';
import { Ro, Row, Sec, TextField } from '../fields';
import { JsonField } from '../JsonField';
import { MetaToggle, type Meta } from '../MetaToggle';
import { EntityHead, orNull, type Ctx, type Edit } from './shared';

const SLOTS: readonly Slot[] = ['input', 'output', 'config'];
const SLOT_LABEL: Readonly<Record<Slot, string>> = { input: 'Input schema', output: 'Output schema', config: 'Config schema' };

/** A schema copy made on the board has no audit of its own yet. */
const schemaMeta = (s: SchemaRow): Meta => (s.updatedAt === null
  ? { id: s.id, createdAt: null, createdBy: null, updatedAt: null, updatedBy: null }
  : { id: s.id, createdAt: s.audit.createdAt, createdBy: s.audit.createdBy, updatedAt: s.audit.updatedAt, updatedBy: s.audit.updatedBy });

/** One slot: its heading, show all, name/version/description and definition (pretty JSON). Edits go to the processor's own copy. */
function SlotEditor({ state, edit, processorId, slot }: { state: BoardState; edit: Edit; processorId: Id; slot: Slot }) {
  const label = SLOT_LABEL[slot];
  const processor = state.processors[processorId];
  if (!processor) return null;
  const schemaId = processor[SLOT_FIELD[slot]];
  const k = `${processorId}:${slot}`;
  if (schemaId === null) return <><Sec>{label}</Sec><p className="none">none</p></>;
  const schema = state.schemas[schemaId];
  if (!schema) return <><Sec>{label}</Sec><p className="none">{`${schemaId} · not loaded`}</p></>;
  const heading = <Sec>{`${label} · ${schema.name} ${schema.version}`}</Sec>;
  if (schema.definition === null || schema.definition === undefined) {
    return <>{heading}<MetaToggle meta={schemaMeta(schema)} /><p className="none">definition not loaded</p></>;
  }
  const set = (key: 'name' | 'version' | 'description' | 'definition', v: string | null) =>
    edit((b) => {
      const cur = b.schemas[schemaId];
      if (!cur) return b;
      const copy = { id: cur.id, name: cur.name, version: cur.version, description: cur.description, definition: cur.definition ?? '', [key]: v };
      return setSlotSchema(b, processorId, slot, copy as typeof copy & { definition: string }, newId);
    }, `field:slot:${processorId}:${slot}:${key}`);
  return (
    <>
      {heading}
      <TextField key={`${k}:name`} label={`${label} name`} value={schema.name} onChange={(v) => set('name', v)} />
      <TextField key={`${k}:version`} label={`${label} version`} value={schema.version} onChange={(v) => set('version', v)} />
      <MetaToggle meta={schemaMeta(schema)} />
      <TextField key={`${k}:description`} label={`${label} description`} value={schema.description} onChange={(v) => set('description', orNull(v))} />
      <JsonField key={`${k}:definition`} label={`${label} definition`} value={schema.definition} onChange={(v) => set('definition', v)} />
    </>
  );
}

function Liveness({ processorId }: { processorId: Id }) {
  const { known, processor } = useProcessorLive(processorId);
  return <Ro><Row k="Liveness">{livenessText(known, processor)}</Row></Ro>;
}

/** The picked step's processor (shared by every step that uses it) and its three schemas, one under another. */
export function ProcessorTab({ state, edit, stepId }: Ctx & { stepId: Id }) {
  const processorId = state.steps[stepId]?.processorId ?? null;
  if (processorId === null) return <Ro><Row k="Processor">none</Row></Ro>;
  const processor = state.processors[processorId];
  if (!processor) return <Ro><Row k="Processor">{processorId}</Row></Ro>;
  const set = (key: 'name' | 'version' | 'description', v: string | null) =>
    edit((b) => setProcessorField(b, processorId, key, v), `field:processor:${processorId}:${key}`);
  const users = Object.values(state.steps).filter((s) => s.processorId === processorId).length;
  const { audit } = processor;
  return (
    <>
      <EntityHead name={`${processor.name} ${processor.version}`} kind={`processor · used by ${users} step${users === 1 ? '' : 's'}`} />
      <TextField key={`${processorId}:pname`} label="Name" value={processor.name} onChange={(v) => set('name', v)} />
      <TextField key={`${processorId}:pversion`} label="Version" value={processor.version} onChange={(v) => set('version', v)} />
      <MetaToggle meta={{ id: processor.id, createdAt: audit.createdAt, createdBy: audit.createdBy, updatedAt: audit.updatedAt, updatedBy: audit.updatedBy }} />
      <TextField key={`${processorId}:pdescription`} label="Description" value={processor.description} onChange={(v) => set('description', orNull(v))} />
      <Liveness processorId={processorId} />
      {SLOTS.map((slot) => <SlotEditor key={slot} state={state} edit={edit} processorId={processorId} slot={slot} />)}
    </>
  );
}

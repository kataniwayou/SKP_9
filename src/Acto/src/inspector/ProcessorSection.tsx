import type { BoardState } from '../design/board';
import { SLOT_FIELD, type Slot } from '../design/board';
import { clearSlot, setProcessorField, setSlotSchema } from '../design/edits';
import { newId } from '../design/ids';
import { AreaField, Ro, Row, TextField } from './fields';

const orNull = (v: string) => (v === '' ? null : v);
const SLOTS: readonly Slot[] = ['input', 'output', 'config'];
const SLOT_LABEL: Readonly<Record<Slot, string>> = { input: 'In', output: 'Out', config: 'Config' };

type Edit = (fn: (b: BoardState) => BoardState, merge?: string) => void;

function SlotEditor({ state, edit, processorId, slot }: { state: BoardState; edit: Edit; processorId: string; slot: Slot }) {
  const label = SLOT_LABEL[slot];
  const processor = state.processors[processorId];
  const schemaId = processor ? processor[SLOT_FIELD[slot]] : null;
  const k = `${processorId}:${slot}`;
  if (!processor) return null;
  if (schemaId === null) return <Ro><Row k={`${label} schema`}>none</Row></Ro>;
  const schema = state.schemas[schemaId];
  if (!schema || schema.definition === null || schema.definition === undefined) {
    return <Ro><Row k={`${label} schema`}>{schema ? `${schema.name} ${schema.version} · definition not loaded` : 'definition not loaded'}</Row></Ro>;
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
      <TextField key={`${k}:name`} label={`${label} schema name`} value={schema.name} onChange={(v) => set('name', v)} />
      <TextField key={`${k}:version`} label={`${label} schema version`} value={schema.version} onChange={(v) => set('version', v)} />
      <TextField key={`${k}:description`} label={`${label} schema description`} value={schema.description} onChange={(v) => set('description', orNull(v))} />
      <AreaField key={`${k}:definition`} label={`${label} schema definition`} value={schema.definition} onChange={(v) => set('definition', v)} />
      <button type="button" className="pbtn in-act" onClick={() => edit((b) => clearSlot(b, processorId, slot))}>{`Clear ${label}`}</button>
    </>
  );
}

/** A step's processor: its own fields and its three schema slots. Shared by every step that uses the processor. */
export function ProcessorSection({ state, edit, processorId }: { state: BoardState; edit: Edit; processorId: string }) {
  const processor = state.processors[processorId];
  if (!processor) return <Ro><Row k="Processor">{processorId}</Row></Ro>;
  const set = (key: 'name' | 'version' | 'description', v: string | null) =>
    edit((b) => setProcessorField(b, processorId, key, v), `field:processor:${processorId}:${key}`);
  return (
    <>
      <TextField key={`${processorId}:pname`} label="Processor name" value={processor.name} onChange={(v) => set('name', v)} />
      <TextField key={`${processorId}:pversion`} label="Processor version" value={processor.version} onChange={(v) => set('version', v)} />
      <TextField key={`${processorId}:pdescription`} label="Processor description" value={processor.description} onChange={(v) => set('description', orNull(v))} />
      {SLOTS.map((slot) => <SlotEditor key={slot} state={state} edit={edit} processorId={processorId} slot={slot} />)}
    </>
  );
}

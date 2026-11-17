import type { BoardWorkflow } from '../board/loadBoard';
import type { BoardStore } from '../design/boardStore';
import { newId } from '../design/ids';
import { clearSlot, setProcessorField, setSlotField, SLOT_FIELD, SLOTS, type Slot } from '../design/state';
import { AreaField, LockNote, lockerName, TextField } from './fields';

const orNull = (v: string) => (v === '' ? null : v);
const SLOT_LABEL: Readonly<Record<Slot, string>> = { input: 'In', output: 'Out', config: 'Config' };

function SlotEditor({ w, store, processorId, slot, locked }: { w: BoardWorkflow; store: BoardStore; processorId: string; slot: Slot; locked: boolean }) {
  const wf = w.graph.workflow.id;
  const label = SLOT_LABEL[slot];
  const base = store.processor(processorId, wf);
  const shown = w.graph.processors.get(processorId);
  const schemaId = shown ? shown[SLOT_FIELD[slot]] : null;
  const k = `${processorId}:${slot}`;
  if (!base) return null;
  if (schemaId === null) return <div className="in-row"><span className="in-k">{`${label} schema`}</span><span className="in-v">none</span></div>;
  const schema = w.graph.schemas.get(schemaId);
  if (!schema || schema.definition === null || schema.definition === undefined) {
    return (
      <div className="in-row">
        <span className="in-k">{`${label} schema`}</span>
        <span className="in-v">{schema ? `${schema.name} ${schema.version} · definition not loaded` : 'definition not loaded'}</span>
      </div>
    );
  }
  const originalId = base[SLOT_FIELD[slot]];
  const original = originalId ? store.schema(originalId, wf) : null;
  const set = (key: 'name' | 'version' | 'description' | 'definition', v: string | null) =>
    store.edit(wf, (s) => setSlotField(s, base, slot, original, key, v, newId), `field:slot:${processorId}:${slot}:${key}`);
  return (
    <>
      <TextField key={`${k}:name`} label={`${label} schema name`} disabled={locked} value={schema.name} onChange={(v) => set('name', v)} />
      <TextField key={`${k}:version`} label={`${label} schema version`} disabled={locked} value={schema.version} onChange={(v) => set('version', v)} />
      <TextField key={`${k}:description`} label={`${label} schema description`} disabled={locked} value={schema.description} onChange={(v) => set('description', orNull(v))} />
      <AreaField key={`${k}:definition`} label={`${label} schema definition`} disabled={locked} value={schema.definition} onChange={(v) => set('definition', v)} />
      <button type="button" className="in-act" disabled={locked} onClick={() => store.edit(wf, (s) => clearSlot(s, base, slot))}>{`Clear ${label}`}</button>
    </>
  );
}

/** A step's processor: its own fields and its three schema slots. Shared by every step that uses the processor. */
export function ProcessorSection({ w, store, processorId }: { w: BoardWorkflow; store: BoardStore; processorId: string }) {
  const wf = w.graph.workflow.id;
  const base = store.processor(processorId, wf);
  const shown = w.graph.processors.get(processorId);
  if (!base || !shown) return <div className="in-row"><span className="in-k">Processor</span><span className="in-v">{shown?.name ?? processorId}</span></div>;
  const set = (key: 'name' | 'version' | 'description', v: string | null) =>
    store.edit(wf, (s) => setProcessorField(s, base, key, v), `field:processor:${processorId}:${key}`);
  // its schemas are locked with it: a slot edit is a change to the processor
  const by = lockerName(store, `processor:${processorId}`, wf);
  const locked = by !== null;
  return (
    <>
      <div className="in-title">Processor</div>
      <LockNote by={by} />
      <TextField key={`${processorId}:pname`} disabled={locked} label="Processor name" value={shown.name} onChange={(v) => set('name', v)} />
      <TextField key={`${processorId}:pversion`} disabled={locked} label="Processor version" value={shown.version} onChange={(v) => set('version', v)} />
      <TextField key={`${processorId}:pdescription`} disabled={locked} label="Processor description" value={shown.description} onChange={(v) => set('description', orNull(v))} />
      {SLOTS.map((slot) => <SlotEditor key={slot} w={w} store={store} processorId={processorId} slot={slot} locked={locked} />)}
    </>
  );
}

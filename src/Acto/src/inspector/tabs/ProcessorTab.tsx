import { SLOT_FIELD } from '../../design/board';
import { setProcessorField } from '../../design/edits';
import { useProcessorLive } from '../../live/LiveContext';
import { livenessText } from '../../live/liveState';
import type { Id } from '../../model/graph';
import { Ro, Row, Sec, TextField } from '../fields';
import { SLOT_LABEL, SLOTS } from '../tabs';
import { EntityBase, orNull, type Ctx } from './shared';

/**
 * The picked step's processor (shared by every step that uses it): its fields in Studio's order (Source hash, Instance
 * id), then its liveness, its three slots read-only (each schema has its own tab) and the steps using it.
 */
export function ProcessorTab({ state, edit, stepId }: Ctx & { stepId: Id }) {
  const processorId = state.steps[stepId]?.processorId ?? null;
  const { known, processor: live } = useProcessorLive(processorId ?? '');
  if (processorId === null) return <Ro><Row k="Processor">none</Row></Ro>;
  const processor = state.processors[processorId];
  if (!processor) return <Ro><Row k="Processor">{processorId}</Row></Ro>;
  const set = (key: 'name' | 'version' | 'description' | 'sourceHash' | 'instanceId', v: string | null) =>
    edit((b) => setProcessorField(b, processorId, key, v), `field:processor:${processorId}:${key}`);
  const users = Object.values(state.steps).filter((s) => s.processorId === processorId).map((s) => s.name);
  const { audit } = processor;
  const k = `processor:${processorId}`;
  return (
    <>
      <EntityBase head={`${processor.name} ${processor.version}`} kind={`processor · used by ${users.length} step${users.length === 1 ? '' : 's'}`}
        k={k} row={processor} set={set}
        meta={{ id: processor.id, createdAt: audit.createdAt, createdBy: audit.createdBy, updatedAt: audit.updatedAt, updatedBy: audit.updatedBy }} />
      <TextField key={`${k}:sourceHash`} label="Source hash" value={processor.sourceHash} onChange={(v) => set('sourceHash', v)} />
      <TextField key={`${k}:instanceId`} label="Instance id" value={processor.instanceId} onChange={(v) => set('instanceId', orNull(v))} />
      <Sec>Related</Sec>
      <Ro>
        <Row k="Liveness">{livenessText(known, live)}</Row>
        {SLOTS.map((slot) => {
          const sid = processor[SLOT_FIELD[slot]];
          const schema = sid === null ? undefined : state.schemas[sid];
          return <Row key={slot} k={SLOT_LABEL[slot]}>{sid === null ? 'none' : schema ? `${schema.name} ${schema.version}` : `${sid} · not loaded`}</Row>;
        })}
        <Row k="Used by">{users.length > 0 ? users.join(', ') : 'no step'}</Row>
      </Ro>
    </>
  );
}

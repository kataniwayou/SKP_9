import { SLOT_FIELD, type BoardState } from '../../design/board';
import type { Id } from '../../model/graph';
import { Sec, TextField } from '../fields';
import { SLOT_LABEL, SLOTS } from '../tabs';
import { EntityBase, LinkChip, locationText, metaOfRow, type Go } from './shared';

/** A stepless processor's card (Schemas mode): read-only, nothing here changes a processor. */
export function ProcessorCardTab({ state, id, go }: { state: BoardState; id: Id; go?: Go }) {
  const p = state.processors[id];
  if (!p) return null;
  const k = `processorcard:${id}`;
  return (
    <>
      <EntityBase head={`${p.name} ${p.version}`} kind="processor · no step" k={k} row={p} meta={metaOfRow({ id: p.id, ...p.audit, updatedAt: p.updatedAt })} set={() => {}} disabled />
      <TextField key={`${k}:sourceHash`} label="Source hash" value={p.sourceHash} disabled onChange={() => {}} />
      <TextField key={`${k}:instanceId`} label="Instance id" value={p.instanceId} disabled onChange={() => {}} />
      <p className="in-note sub in-readonly">Read-only. Acto never changes, copies or deletes a processor.</p>
      <Sec>Related</Sec>
      <dl className="ro"><dt>Steps</dt><dd>none</dd></dl>
      <div className="in-chips" aria-label="Schemas">
        {SLOTS.flatMap((slot) => {
          const sid = p[SLOT_FIELD[slot]];
          const s = sid === null ? undefined : state.schemas[sid];
          return sid === null || !s ? [] : [(
            <LinkChip key={slot} name={`${s.name} ${s.version}`} sub={SLOT_LABEL[slot]} openLabel={`Open schema ${s.name}`}
              {...(go ? { onOpen: () => go([{ kind: 'schema', id: sid }]) } : {})} />
          )];
        })}
      </div>
      <p className="in-note sub">{`Location: ${locationText(p.at)}`}</p>
    </>
  );
}

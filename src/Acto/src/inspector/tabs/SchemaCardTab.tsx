import { schemaRefs, schemaStates, heldBy } from '../../design/schemaStates';
import type { BoardState } from '../../design/board';
import type { Id } from '../../model/graph';
import { Sec } from '../fields';
import { JsonField } from '../JsonField';
import { SLOT_LABEL } from '../tabs';
import { schemaMeta } from './SchemaTab';
import { EntityBase, LinkChip, locationText, type Go } from './shared';

const LETTER = { input: 'I', output: 'O', config: 'C' } as const;

/**
 * A schema card's entity form (Schemas mode): read-only, every field disabled and no edit anywhere. The kind line says
 * what holds it; Related lists the steps using it, the processors holding it and its place on the board.
 */
export function SchemaCardTab({ state, id, go }: { state: BoardState; id: Id; go?: Go }) {
  const schema = state.schemas[id];
  if (!schema) return null;
  const st = schemaStates(state)[id] ?? 'orphan';
  const refs = schemaRefs(state).filter((r) => r.schemaId === id);
  const procOf = (r: (typeof refs)[number]) => (r.owner.kind === 'step' ? state.steps[r.owner.id]?.processorId : r.owner.id) ?? null;
  const procName = (pid: Id | null) => (pid === null ? '' : state.processors[pid]?.name ?? pid);
  const holders = heldBy(state, id);
  const kind = st === 'orphan' ? 'schema · orphan'
    : st === 'held' ? `schema · held by ${holders.map((h) => `${procName(h)} ${state.processors[h]?.version ?? ''}`.trim()).join(', ')}`
      : `schema · ${refs.filter((r) => r.owner.kind === 'step').map((r) => `${LETTER[r.slot]} of ${procName(procOf(r))}`).join(', ')}`;
  const stateNote = st === 'orphan' ? <p className="in-problem sub">Orphan: no processor references this schema.</p>
    : st === 'held' ? <p className="in-note sub">{`Held by ${holders.map((h) => `${procName(h)} ${state.processors[h]?.version ?? ''}`.trim()).join(', ')}, a processor no step uses.`}</p>
      : <p className="in-note sub">In use. Only orphans can be deleted.</p>;
  const stepRefs = refs.filter((r) => r.owner.kind === 'step');
  const k = `schemacard:${id}`;
  return (
    <>
      <EntityBase head={`${schema.name} ${schema.version}`} kind={kind} k={k} row={schema} meta={schemaMeta(schema)} set={() => {}} disabled />
      {schema.definition === null || schema.definition === undefined
        ? <p className="in-note sub">Definition: not loaded</p>
        : <JsonField key={`${k}:definition`} label="Definition" value={schema.definition} onChange={() => {}} disabled />}
      <p className="in-note sub in-readonly">The definition is read-only: a change needs the processor restarted.</p>
      {stateNote}
      <Sec>Related</Sec>
      {stepRefs.length > 0 && <div className="in-chips" aria-label="Used by">
        {stepRefs.map((r) => (
          <LinkChip key={`${r.owner.id}:${r.slot}`} name={state.steps[r.owner.id]?.name ?? r.owner.id} sub={`${SLOT_LABEL[r.slot]} · ${procName(procOf(r))}`}
            openLabel={`Open step ${state.steps[r.owner.id]?.name ?? r.owner.id}`} {...(go ? { onOpen: () => go([{ kind: 'step', id: r.owner.id }]) } : {})} />
        ))}
      </div>}
      {holders.length > 0 && <div className="in-chips" aria-label="Held by">
        {holders.map((h) => (
          <LinkChip key={h} name={procName(h)} openLabel={`Open processor ${procName(h)}`} {...(go ? { onOpen: () => go([{ kind: 'processor', id: h }]) } : {})} />
        ))}
      </div>}
      <p className="in-note sub">{`Location: ${locationText(schema.at)}`}</p>
    </>
  );
}

import type { BoardState, RowAudit } from '../../design/board';
import type { Id } from '../../model/graph';
import { checkPayload, payloadJsonProblem } from '../../model/payloadCheck';
import { AreaField, TextField } from '../fields';
import { MetaToggle, type Meta } from '../MetaToggle';

export type Edit = (fn: (b: BoardState) => BoardState, merge?: string) => void;
/** `base`: the board as BaseAPI last gave it (the saved values JSON is compared with). */
export interface Ctx { state: BoardState; base: BoardState; edit: Edit }

export const orNull = (v: string) => (v === '' ? null : v);
export const stepName = (b: BoardState, id: Id) => b.steps[id]?.name ?? id;
/** A board item's place on the board, as the Location row shows it. */
export const locationText = (at: { x: number; y: number } | null) => (at ? `${Math.round(at.x)}, ${Math.round(at.y)}` : 'not placed');

/** Studio's entity form head: the unique name (`name version`) and the kind line under it. */
export const EntityHead = ({ name, kind }: { name: string; kind: string }) => (
  <><div className="uname" aria-label="Unique name">{name}</div><div className="kind">{kind}</div></>
);

type BaseKey = 'name' | 'version' | 'description';

/**
 * The start every entity tab shares, in Studio's EntityForm order [user, 2026-11-18]: the head, Name, Version, show all,
 * Description (multiline, blank = null). The kind's own fields and its related items follow it in the tab.
 */
export function EntityBase({ head, kind, k, row, meta, set, disabled }: {
  head: string; kind: string; k: string; row: { name: string; version: string; description: string | null }; meta: Meta;
  set: (key: BaseKey, v: string | null) => void; disabled?: boolean;
}) {
  return (
    <>
      <EntityHead name={head} kind={kind} />
      <TextField key={`${k}:name`} label="Name" value={row.name} disabled={disabled} onChange={(v) => set('name', v)} />
      <TextField key={`${k}:version`} label="Version" value={row.version} disabled={disabled} onChange={(v) => set('version', v)} />
      <MetaToggle meta={meta} />
      <AreaField key={`${k}:description`} label="Description" rows={2} value={row.description ?? ''} disabled={disabled} onChange={(v) => set('description', orNull(v))} />
    </>
  );
}

/** A board row's "show all" fields. */
export const metaOfRow = (r: RowAudit & { id: Id; updatedAt: string | null }): Meta => ({
  id: r.id, createdAt: r.createdAt, createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
});

/** A payload's JSON check, then its check against the step's processor's config schema (Studio's note when it passes). */
export function PayloadCheckNote({ state, stepId, payload }: { state: BoardState; stepId: Id; payload: string }) {
  const processorId = state.steps[stepId]?.processorId;
  const processor = processorId ? state.processors[processorId] : undefined;
  const schema = processor?.configSchemaId ? state.schemas[processor.configSchemaId] : undefined;
  // text that is not JSON says so whether or not there is a schema to check it against
  const notJson = payloadJsonProblem(payload);
  if (notJson !== null) return <p className="in-problem sub">{notJson}</p>;
  if (!schema?.definition) return null;
  const r = checkPayload(schema.definition, payload);
  if ('unchecked' in r) return <p className="in-note sub">{r.unchecked}</p>;
  if (r.problems.length === 0) return <p className="in-note sub">{`✓ checked against ${schema.name} ${schema.version}; Save checks it again`}</p>;
  return <>{r.problems.map((p, i) => <p key={i} className="in-problem sub">{p}</p>)}</>;
}

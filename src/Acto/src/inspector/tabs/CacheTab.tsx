import { setCacheField } from '../../design/edits';
import type { Id } from '../../model/graph';
import { Ro, Row, Sec, TextField } from '../fields';
import { CacheItemsTable } from '../CacheItemsTable';
import { EntityBase, locationText, metaOfRow, type Ctx } from './shared';

/** A cache: its fields, its items as a paged table over the server's items (each commit its own undo step, not merged like typing), then who uses it. */
export function CacheTab({ state, edit, id, api }: Ctx & { id: Id }) {
  const cache = state.caches[id];
  if (!cache) return null;
  const set = (key: 'name' | 'version' | 'description' | 'root', v: string | null) =>
    edit((b) => setCacheField(b, id, key, v as never), `field:${id}:${key}`);
  const users = Object.values(state.workflows).filter((w) => w.cacheIds.includes(id)).map((w) => w.name);
  return (
    <>
      <EntityBase head={`${cache.name} ${cache.version}`} kind={users.length ? `cache · used by ${users.join(', ')}` : 'cache'}
        k={id} row={cache} meta={metaOfRow(cache)} set={set} />
      <TextField key={`${id}:root`} label="Root" value={cache.root} onChange={(v) => set('root', v)} />
      <CacheItemsTable key={id} cache={cache} isNew={cache.updatedAt === null} api={api} edit={edit} />
      <Sec>Related</Sec>
      <Ro>
        <Row k="Used by">{users.length ? users.join(', ') : 'no workflow'}</Row>
        <Row k="Location">{locationText(cache.at)}</Row>
      </Ro>
    </>
  );
}

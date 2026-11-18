import { setCacheField } from '../../design/edits';
import type { Id } from '../../model/graph';
import { Ro, Row, Sec, TextField } from '../fields';
import { DictEditor } from '../DictEditor';
import { EntityBase, locationText, metaOfRow, type Ctx } from './shared';

/** A cache: its fields, its items as a key/value table (text with the reason when they are no string dictionary), then who uses it. */
export function CacheTab({ state, base, edit, id }: Ctx & { id: Id }) {
  const cache = state.caches[id];
  if (!cache) return null;
  const set = (key: 'name' | 'version' | 'description' | 'root' | 'items', v: string | null) =>
    edit((b) => setCacheField(b, id, key, v as never), `field:${id}:${key}`);
  const users = Object.values(state.workflows).filter((w) => w.cacheIds.includes(id)).map((w) => w.name);
  return (
    <>
      <EntityBase head={`${cache.name} ${cache.version}`} kind={users.length ? `cache · used by ${users.join(', ')}` : 'cache'}
        k={id} row={cache} meta={metaOfRow(cache)} set={set} />
      <TextField key={`${id}:root`} label="Root" value={cache.root} onChange={(v) => set('root', v)} />
      <DictEditor key={`${id}:items`} label="Items" value={cache.items} saved={base.caches[id]?.items} onChange={(v) => set('items', v)} />
      <Sec>Related</Sec>
      <Ro>
        <Row k="Used by">{users.length ? users.join(', ') : 'no workflow'}</Row>
        <Row k="Location">{locationText(cache.at)}</Row>
      </Ro>
    </>
  );
}

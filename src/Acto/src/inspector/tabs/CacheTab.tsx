import { setCacheField } from '../../design/edits';
import type { Id } from '../../model/graph';
import { Ro, Row, TextField } from '../fields';
import { JsonField } from '../JsonField';
import { MetaToggle } from '../MetaToggle';
import { EntityHead, metaOfRow, orNull, type Ctx } from './shared';

/** A cache: its fields, its items as pretty JSON (as typed when they do not parse) and who uses it. */
export function CacheTab({ state, edit, id }: Ctx & { id: Id }) {
  const cache = state.caches[id];
  if (!cache) return null;
  const set = (key: 'name' | 'version' | 'description' | 'root' | 'items', v: string | null) =>
    edit((b) => setCacheField(b, id, key, v as never), `field:${id}:${key}`);
  const users = Object.values(state.workflows).filter((w) => w.cacheIds.includes(id)).map((w) => w.name);
  return (
    <>
      <EntityHead name={`${cache.name} ${cache.version}`} kind={users.length ? `cache · used by ${users.join(', ')}` : 'cache'} />
      <TextField key={`${id}:name`} label="Name" value={cache.name} onChange={(v) => set('name', v)} />
      <TextField key={`${id}:version`} label="Version" value={cache.version} onChange={(v) => set('version', v)} />
      <MetaToggle meta={metaOfRow(cache)} />
      <TextField key={`${id}:description`} label="Description" value={cache.description} onChange={(v) => set('description', orNull(v))} />
      <TextField key={`${id}:root`} label="Root" value={cache.root} onChange={(v) => set('root', v)} />
      <JsonField key={`${id}:items`} label="Items" value={cache.items} onChange={(v) => set('items', v)} />
      <Ro><Row k="Used by">{users.length ? users.join(', ') : 'no workflow'}</Row></Ro>
    </>
  );
}

import { test, expect } from '../fixtures';
import { addItem, inspector, openAt, pickCache, save, saveButton, storedKey, storedValue, waitLoaded } from '../helpers';
import { seed } from '../seed';
import { API, appendItems, getJson, itemsPage, removeItems, storedItems, type Row } from '../stack';

// Regression 11 (user, 2026-11-24; items model 2026-11-26): a cache's items are rows in BaseApi (cache_items), no longer part of
// the cache row: `GET /caches/{id}` carries `itemCount` and no `items`, and the items go through their own endpoints (append,
// remove, a page by key cursor) with per-entry limits (a key at most 256 characters, no ':') instead of one cap on the whole
// dictionary. Acto's Cache tab reads a page and Save appends/removes through /model/apply; an item the board cannot send is
// refused where it is typed. Valence and WorkflowStudio are gone, and so are the endpoints only they called.

const post = (path: string, body: unknown) => fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the cache row carries itemCount and no items; items are appended, removed and paged over HTTP', async () => {
  const id = await seed({ caches: [{ key: 'c', name: 'e2e-items-api', at: { x: 0, y: 0 }, root: 'e2e-items-api' }] });
  const row = async () => getJson<Row>(`/caches/${id.c}`);
  let r = await row();
  expect(r.itemCount, 'a new cache is empty').toBe(0);
  expect(r, 'no items on the row').not.toHaveProperty('items');

  await appendItems(id.c!, { b: '2', a: '1', c: '3' });
  r = await row();
  expect(r.itemCount).toBe(3);
  expect(r).not.toHaveProperty('items');
  expect((await getJson<Row[]>('/caches')).find((x) => x.id === id.c)).toMatchObject({ itemCount: 3 });

  // a page, ordered by key, with a cursor
  const first = await itemsPage(id.c!, undefined, 2);
  expect(first.items).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
  expect(first.next).toBeTruthy();
  const second = await itemsPage(id.c!, first.next!, 2);
  expect(second.items).toEqual([{ key: 'c', value: '3' }]);
  expect(second.next).toBeNull();

  // an append of an existing key replaces its value; a bad key is refused and changes nothing
  await appendItems(id.c!, { a: 'one' });
  expect(await storedItems(id.c!)).toEqual({ a: 'one', b: '2', c: '3' });
  expect((await post(`/caches/${id.c}/items`, { items: [{ key: 'x:y', value: '1' }] })).status).toBeGreaterThanOrEqual(400);
  expect((await post(`/caches/${id.c}/items`, { items: [{ key: 'k'.repeat(257), value: '1' }] })).status).toBeGreaterThanOrEqual(400);
  expect((await row()).itemCount).toBe(3);

  await removeItems(id.c!, ['b', 'a']);
  expect(await storedItems(id.c!)).toEqual({ c: '3' });
  expect((await row()).itemCount).toBe(1);
});

test('Cache tab edits cross as append/remove and are stored after Save; a key over 256 characters is refused where it is typed', async ({ page }) => {
  const id = await seed({ caches: [{ key: 'c', name: 'e2e-pairs', at: { x: 0, y: 0 }, root: 'e2e-pairs', items: { old: '1', keep: '2' } }] });
  await openAt(page);
  await pickCache(page, id.c!);
  await expect(inspector(page).getByText('2 stored')).toBeVisible();
  await expect(storedValue(page, 'keep')).toHaveValue('2');

  await addItem(page, 'usd', '3.7');
  await addItem(page, 'eur', '4.1');
  await inspector(page).getByRole('button', { name: 'Remove old', exact: true }).click();
  await expect(inspector(page).getByText('2 stored · 3 unsaved')).toBeVisible();
  const sent: { changes?: { op: string; table: string; row?: unknown }[] }[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/model/apply')) sent.push(r.postDataJSON()); });
  expect((await save(page)).applied).toBe(true);

  // on the wire: item changes of their own (the cache row itself is not sent), and in BaseApi: read back page by page
  const items = sent.flatMap((b) => b.changes ?? []).filter((c) => c.table === 'cache_items');
  expect(items.map((c) => c.op).sort()).toEqual(['append', 'remove']);
  expect(JSON.stringify(items)).toContain('"items":[{"key":"usd","value":"3.7"},{"key":"eur","value":"4.1"}]');
  expect(await storedItems(id.c!)).toEqual({ keep: '2', usd: '3.7', eur: '4.1' });
  expect((await getJson<Row>(`/caches/${id.c}`)).itemCount).toBe(3);

  await page.reload();
  await waitLoaded(page);
  // the reload restores the selection: clear it, so the click picks rather than un-picks
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await pickCache(page, id.c!);
  await expect(inspector(page).getByText('3 stored')).toBeVisible();
  await expect(storedValue(page, 'eur')).toHaveValue('4.1');
  await expect(storedValue(page, 'usd')).toHaveValue('3.7');
  await expect(storedKey(page, 'old')).toHaveCount(0);

  // a key one past the limit is refused where it is added and never edited, so there is nothing to send
  await addItem(page, 'k'.repeat(257), 'v');
  await expect(inspector(page).getByRole('alert').getByText('Key must be at most 256 characters')).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  // and at exactly 256 it is fine
  await addItem(page, 'k'.repeat(256), 'v');
  await expect(inspector(page).getByText(/Key must be at most 256 characters/)).toHaveCount(0);
  await expect(inspector(page).getByText('3 stored · 1 unsaved')).toBeVisible();
  await expect(saveButton(page)).toHaveText('Save · 1');
});

test('removed endpoints are gone, the ones Acto uses are not', async () => {
  // plain requests to BaseApi, outside the page (so outside its write guard), on a workflow this run made: it exists, so an
  // endpoint still there would answer it (a random id would 404 either way); if one did, only this e2e- row is touched
  const seeded = await seed({ steps: [{ key: 's', name: 'e2e-gone-s', at: { x: 0, y: 0 } }], workflows: [{ key: 'w', name: 'e2e-gone-w', at: { x: 0, y: 200 }, entry: ['s'] }] });
  const any = seeded.w!;
  expect((await fetch(`${API}/workflows/${any}`)).status, 'the workflow they are asked about exists').toBe(200);
  const gone: [string, string][] = [
    ['PUT', `/workflows/${any}/design`], ['GET', `/workflows/${any}/layout`], ['PUT', `/workflows/${any}/layout`],
    ['GET', `/workflows/${any}/graph`], ['PUT', `/workflows/${any}/graph`], ['POST', `/workflows/${any}/delete`],
    ['GET', '/model/fields'], ['GET', '/model/relations'], ['GET', `/workflows/${any}/molecule`],
  ];
  for (const [method, path] of gone) {
    const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
    expect([404, 405], `${method} ${path}`).toContain(r.status);
  }
  // what Acto calls answers
  const validate = await fetch(`${API}/model/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [] }) });
  expect(validate.status, 'POST /model/validate').toBe(200);
  for (const path of ['/workflows', '/steps', '/caches', '/processors', '/processors/liveness', '/orchestration/live']) {
    expect((await fetch(`${API}${path}`)).status, `GET ${path}`).toBe(200);
  }
});

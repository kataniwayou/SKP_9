import { test, expect } from '../fixtures';
import { addItem, inspector, itemKey, openAt, pickCache, save, saveButton, waitLoaded } from '../helpers';
import { seed } from '../seed';
import { API, getJson, type Row } from '../stack';

// Regression 11 (user, 2026-11-24): a cache's items are rows in BaseApi (cache_items) and cross the API as a list of
// {key, value} pairs, with per-entry limits (a key at most 256 characters, no ':') instead of the old 1 MB cap on the whole
// dictionary; an item the board cannot send is refused where it is typed. Valence and WorkflowStudio are gone, and so are
// the endpoints only they called; the ones Acto uses stay.

test('cache items cross as pairs and survive a reload; a key over 256 characters is refused where it is typed', async ({ page }) => {
  const id = await seed({ caches: [{ key: 'c', name: 'e2e-pairs', at: { x: 0, y: 0 }, root: 'e2e-pairs' }] });
  await openAt(page);
  await pickCache(page, id.c!);
  await addItem(page, 1, 'usd', '3.7');
  await addItem(page, 2, 'eur', '4.1');
  await expect(inspector(page).getByText('2 items')).toBeVisible();
  const sent: unknown[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/model/apply')) sent.push(r.postDataJSON()); });
  expect((await save(page)).applied).toBe(true);

  // on the wire and in BaseApi: a list of pairs, not a dictionary (BaseApi answers them sorted by key)
  expect(JSON.stringify(sent)).toContain('"items":[{"key":"usd","value":"3.7"},{"key":"eur","value":"4.1"}]');
  const raw = await getJson<Row>(`/caches/${id.c}`);
  expect(raw.items).toEqual([{ key: 'eur', value: '4.1' }, { key: 'usd', value: '3.7' }]);

  await page.reload();
  await waitLoaded(page);
  // the reload restores the selection: clear it, so the click picks rather than un-picks
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await pickCache(page, id.c!);
  await expect(inspector(page).getByText('2 items')).toBeVisible();
  await expect(itemKey(page, 1)).toHaveValue('eur');
  await expect(itemKey(page, 2)).toHaveValue('usd');

  // a key one past the limit is marked where it is typed and never committed, so there is nothing to send
  await inspector(page).getByRole('button', { name: '+ Add item' }).click();
  await itemKey(page, 3).fill('k'.repeat(257));
  await itemKey(page, 3).press('Enter');
  await expect(inspector(page).getByText('Key must be at most 256 characters: not committed')).toBeVisible();
  await expect(itemKey(page, 3)).toHaveAttribute('aria-invalid', 'true');
  await expect(saveButton(page)).toBeDisabled();
  // and at exactly 256 it is fine
  await itemKey(page, 3).fill('k'.repeat(256));
  await itemKey(page, 3).press('Enter');
  await expect(inspector(page).getByText(/Key must be at most 256 characters/)).toHaveCount(0);
  await expect(inspector(page).getByText('3 items')).toBeVisible();
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

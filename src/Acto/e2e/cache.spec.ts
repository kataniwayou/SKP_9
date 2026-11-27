import { test, expect } from './fixtures';
import { addItem, inspector, itemsPosition, itemsSummary, openAt, pickCache, showCache, save, saveButton, storedKey, storedValue, waitLoaded } from './helpers';
import { seed } from './seed';
import { storedItems } from './stack';

// A cache's Items table (CacheItemsTable): the stored page read from BaseAPI, this session's edits laid over it; Save appends and
// removes through /model/apply (cache_items) and the table reads the saved items back.

test("a cache's items: add two, save, remove one, save, reload: BaseAPI and the table hold what was saved", async ({ page }) => {
  const id = await seed({ caches: [{ key: 'c', name: 'e2e-items-cache', at: { x: 0, y: 0 }, root: 'e2e-items' }] });
  await openAt(page);
  await pickCache(page, id.c!);
  await expect(inspector(page).getByText('0 stored', { exact: true })).toBeVisible();
  await expect(itemsSummary(page)).toHaveText('no unsaved changes on this page');
  await expect(itemsPosition(page)).toHaveText('no items');
  await expect(saveButton(page)).toBeDisabled();

  await addItem(page, 'usd', '3.7');
  await addItem(page, 'eur', '4.1');
  // added rows show in place (green), counted in the page's summary
  await expect(itemsSummary(page)).toHaveText('on this page: 2 added');
  await expect(storedValue(page, 'usd')).toHaveValue('3.7');
  await expect(saveButton(page)).toContainText('Save · 1');
  expect((await save(page)).applied).toBe(true);
  expect(await storedItems(id.c!)).toEqual({ usd: '3.7', eur: '4.1' });

  // the stored page now lists them, ordered by key (eur, usd), and nothing is unsaved
  await expect(inspector(page).getByText('2 stored', { exact: true })).toBeVisible();
  await expect(storedValue(page, 'eur')).toHaveValue('4.1');
  await expect(itemsSummary(page)).toHaveText('no unsaved changes on this page');
  await expect(itemsPosition(page)).toHaveText('rows 1–2 · page 1 of 1');
  await expect(saveButton(page)).toBeDisabled();

  // a bad key is refused where it is added: nothing is edited
  await addItem(page, 'a:b', 'x');
  await expect(inspector(page).getByRole('alert').getByText("Key must not contain ':'")).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();

  // remove a stored item: struck through until Save
  await inspector(page).getByRole('button', { name: 'Remove eur', exact: true }).click();
  await expect(itemsSummary(page)).toHaveText('on this page: 1 deleted');
  await expect(inspector(page).getByRole('button', { name: 'Restore eur', exact: true })).toBeVisible();
  await expect(saveButton(page)).toContainText('Save · 1');
  expect((await save(page)).applied).toBe(true);
  expect(await storedItems(id.c!)).toEqual({ usd: '3.7' });

  await page.reload();
  await waitLoaded(page);
  await showCache(page, id.c!); // the reload may restore it as picked: a plain click would unpick it
  await expect(inspector(page).getByText('1 stored', { exact: true })).toBeVisible();
  await expect(storedKey(page, 'usd')).toBeVisible();
  await expect(storedValue(page, 'usd')).toHaveValue('3.7');
  await expect(saveButton(page)).toBeDisabled();
});

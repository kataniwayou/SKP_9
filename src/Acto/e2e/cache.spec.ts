import { test, expect } from './fixtures';
import { addItem, inspector, itemKey, itemValue, openAt, pickCache, save, saveButton, waitLoaded } from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// A cache's Items are a key/value table (ported from Studio's DictEditor): add and remove items, Save, reload, items as saved.

test('a cache\'s items: add two, save, remove one, save, reload: BaseAPI and the table hold what was saved', async ({ page }) => {
  const id = await seed({ caches: [{ key: 'c', name: 'e2e-items-cache', at: { x: 0, y: 0 }, root: 'e2e-items' }] });
  await openAt(page);
  await pickCache(page, id.c!);
  await expect(inspector(page).getByText('0 items')).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();

  await addItem(page, 1, 'usd', '3.7');
  await addItem(page, 2, 'eur', '4.1');
  await expect(inspector(page).getByText('2 items')).toBeVisible();
  await expect(saveButton(page)).toContainText('Save · 1');
  expect((await save(page)).applied).toBe(true);
  expect(JSON.parse((await getJson<Row>(`/caches/${id.c}`)).items as string)).toEqual({ usd: '3.7', eur: '4.1' }); // BaseAPI keeps its own layout

  // BaseAPI keeps the keys sorted (eur, usd): the table shows them so after the reload
  // a bad key is marked and not committed; the saved text stays
  await inspector(page).getByRole('button', { name: '+ Add item' }).click();
  await itemKey(page, 3).fill('a:b');
  await itemKey(page, 3).press('Enter');
  await expect(inspector(page).getByText("Key must not contain ':': not committed")).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  await inspector(page).getByRole('button', { name: 'Delete item 3' }).click();
  await expect(inspector(page).getByText('2 items')).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();

  await inspector(page).getByRole('button', { name: 'Delete item 1' }).click();
  await expect(inspector(page).getByText('1 item')).toBeVisible();
  await expect(saveButton(page)).toContainText('Save · 1');
  expect((await save(page)).applied).toBe(true);
  expect(JSON.parse((await getJson<Row>(`/caches/${id.c}`)).items as string)).toEqual({ usd: '3.7' });

  await page.reload();
  await waitLoaded(page);
  await pickCache(page, id.c!);
  await expect(inspector(page).getByText('1 item')).toBeVisible();
  await expect(itemKey(page, 1)).toHaveValue('usd');
  await expect(itemValue(page, 1)).toHaveValue('3.7');
  await expect(saveButton(page)).toBeDisabled();
});

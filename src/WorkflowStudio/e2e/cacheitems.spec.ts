import type { Page } from '@playwright/test';
import { documentPanel, get, inspector, node, openWorkflow, pane, save } from './studio';
import { createThrowaway, expect, removeThrowaway, test, type Throwaway } from './throwaway';

// A cache's items as a key/value table in the Inspector (the user's decision, 2026-10-10), with the real mouse and keys:
// add, edit, delete, a duplicate key red and not committed, the JSON toggle both ways, a refresh, and Save writing the JSON
// object BaseApi keeps. Only this run's throwaway is written (its design save).
test.describe.configure({ mode: 'serial', retries: 0 });
let t: Throwaway;
test.beforeAll(async ({ request }) => { t = await createThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.CACHEITEMS_SHOTS;
const cell = (page: Page, what: 'Key' | 'Value', n: number) => inspector(page).getByRole('textbox', { name: `${what} ${n}`, exact: true });
const cells = (page: Page) => inspector(page).locator('.dict-table .dict-cell').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));

async function typeCell(page: Page, what: 'Key' | 'Value', n: number, text: string): Promise<void> {
  await cell(page, what, n).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('the cache\'s items as a table: add, edit, Tab, delete, a duplicate red and not committed, JSON both ways, a refresh, Save', async ({ page, request }) => {
  await openWorkflow(page, t.workflow);
  const panel = documentPanel(page, t.workflow);
  const cache = node(panel, `cache:${t.cacheId}`);
  await cache.click();
  const table = inspector(page).getByRole('table', { name: 'Items' });
  await expect(table).toBeVisible();
  await expect(inspector(page).getByText('0 items')).toBeVisible();

  // add two rows: the new row's key has focus; Tab goes key -> value -> the next row's key
  const add = inspector(page).getByRole('button', { name: '+ Add item' });
  await add.click();
  await expect(cell(page, 'Key', 1)).toBeFocused();
  await page.keyboard.type('usd');
  await page.keyboard.press('Tab');
  await expect(cell(page, 'Value', 1)).toBeFocused();
  await page.keyboard.type('3.7');
  await page.keyboard.press('Enter');
  await add.click();
  await page.keyboard.type('eur');
  await page.keyboard.press('Tab');
  await page.keyboard.type('4.0');
  await page.keyboard.press('Enter');
  await add.click();
  await page.keyboard.type('gbp');
  await page.keyboard.press('Tab');
  await page.keyboard.type('4.6');
  await page.keyboard.press('Enter');
  await expect(inspector(page).getByText('3 items')).toBeVisible();
  // Tab from a row's value goes to the next row's key (the × is skipped)
  await cell(page, 'Value', 1).click();
  await page.keyboard.press('Tab');
  await expect(cell(page, 'Key', 2)).toBeFocused();
  await expect(page.getByText('● design draft')).toBeVisible();

  // keys typed in a cell never reach the canvas: Delete and arrows edit the text, the cache stays
  await cell(page, 'Value', 2).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Delete');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await expect(cache).toBeVisible();
  await expect(cell(page, 'Value', 2)).toHaveValue('4.0');

  // edit a value, rename a key
  await typeCell(page, 'Value', 2, '3.9');
  await typeCell(page, 'Key', 3, 'jpy');
  expect(await cells(page)).toEqual(['usd', '3.7', 'eur', '3.9', 'jpy', '4.6']);

  // a duplicate key: red with the reason, not committed (the JSON view still says jpy)
  await typeCell(page, 'Key', 3, 'usd');
  await expect(inspector(page).getByText('Duplicate key: not committed')).toBeVisible();
  await expect(cell(page, 'Key', 3)).toHaveAttribute('aria-invalid', 'true');
  await expect(cell(page, 'Key', 1)).not.toHaveAttribute('aria-invalid', 'true');
  if (SHOTS) await inspector(page).screenshot({ path: `${SHOTS}/cache-items-table.png` });
  await typeCell(page, 'Key', 3, 'jpy');
  await expect(inspector(page).getByText(/not committed/)).toHaveCount(0);

  // delete a row
  await inspector(page).getByRole('button', { name: 'Delete item 2' }).click();
  expect(await cells(page)).toEqual(['usd', '3.7', 'jpy', '4.6']);

  // the JSON toggle: the same dictionary as text; an edit there commits on leaving it, and the table follows
  const toggle = inspector(page).getByRole('button', { name: 'JSON' });
  await toggle.click();
  const box = inspector(page).getByRole('textbox', { name: 'Items as JSON' });
  await expect(box).toHaveValue('{\n  "usd": "3.7",\n  "jpy": "4.6"\n}');
  if (SHOTS) await inspector(page).screenshot({ path: `${SHOTS}/cache-items-json.png` });
  await box.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('{"usd":"3.7","jpy":"4.6","chf":"4.1"}');
  // leaving the box commits it
  await page.keyboard.press('Tab');
  await toggle.click();
  expect(await cells(page)).toEqual(['usd', '3.7', 'jpy', '4.6', 'chf', '4.1']);

  // a refresh keeps it (Inspector edits are not in the design's Undo history, as for every field)
  await page.reload();
  await node(documentPanel(page, t.workflow), `cache:${t.cacheId}`).click();
  await expect.poll(() => cells(page)).toEqual(['usd', '3.7', 'jpy', '4.6', 'chf', '4.1']);

  // Save: BaseApi keeps the JSON object (Postgres keeps it as jsonb, in its own key order)
  await save(page);
  await expect(await pane(page, 'Output')).toContainText('Saved and applied');
  const stored = await get<{ items: string }>(request, `caches/${t.cacheId}`);
  expect(JSON.parse(stored.items)).toEqual({ usd: '3.7', jpy: '4.6', chf: '4.1' });
});

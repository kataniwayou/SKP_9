import { documentPanel, expect, liveWorkflows, tab, test } from './studio';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

test('a pane closes from the keyboard on its tab ×', async ({ page }) => {
  const close = tab(page, 'Output').getByRole('button', { name: 'Close Output' });
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Output')).toHaveCount(0);
});

test('a menu gives focus back to its button when Escape closes it', async ({ page }) => {
  const file = page.getByRole('menuitem', { name: 'Workspace' });
  await file.click();
  await expect(page.getByRole('menu', { name: 'Workspace' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(file).toBeFocused();
});

test('the picker opens the workflow chosen with the arrow keys', async ({ page, request }) => {
  const [first, second] = await liveWorkflows(request, 2);
  await page.getByRole('menuitem', { name: 'Workspace' }).click();
  await page.getByRole('menuitem', { name: /Load workflow/ }).click();
  const box = page.getByRole('textbox', { name: 'Search workflows' });
  await expect(page.getByRole('listbox', { name: 'Workflows' }).getByText(first!.label, { exact: true })).toBeVisible();
  const labels = await page.getByRole('option').allTextContents();
  const index = labels.findIndex((l) => l.startsWith(second!.label));
  for (let i = 0; i < index; i++) await box.press('ArrowDown');
  await box.press('Enter');
  await expect(documentPanel(page, second!).locator('.react-flow__node').first()).toBeVisible();
});

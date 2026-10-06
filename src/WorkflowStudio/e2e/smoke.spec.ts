import { expect, test } from '@playwright/test';

test('the studio loads, and the dev server reaches BaseApi', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('SKP Studio');
  expect((await request.get('/api/v1/workflows')).ok()).toBe(true);
});

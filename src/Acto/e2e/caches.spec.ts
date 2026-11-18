import { test, expect } from './fixtures';
import { caNode, cacheEdge, drawCacheLink, inspector, openAt, pickWorkflow, save, saveButton, waitLoaded, wfNode } from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Plan 6 (inspector-tabs spec §5, Workflow tab): a workflow may link several caches, each by the drag from the triangle's back to the cache.

test('one workflow linked to two caches by dragging from its back: saved, and after a reload both lines and both chips are there', async ({ page }) => {
  const id = await seed({
    steps: [{ key: 's', name: 'e2e-cc-step', at: { x: 320, y: 100 } }],
    caches: [
      { key: 'c1', name: 'e2e-cc-one', at: { x: 0, y: 330 }, root: 'e2e-cc-one' },
      { key: 'c2', name: 'e2e-cc-two', at: { x: 260, y: 330 }, root: 'e2e-cc-two' },
    ],
    workflows: [{ key: 'w', name: 'e2e-cc-wf', at: { x: 0, y: 60 }, entry: ['s'] }],
  });
  await openAt(page);
  await drawCacheLink(page, wfNode(page, id.w!), caNode(page, id.c1!));
  await expect(cacheEdge(page, id.w!, id.c1!)).toHaveCount(1);
  await drawCacheLink(page, wfNode(page, id.w!), caNode(page, id.c2!));
  await expect(cacheEdge(page, id.w!, id.c2!)).toHaveCount(1);
  await expect(cacheEdge(page, id.w!, id.c1!)).toHaveCount(1);
  await pickWorkflow(page, id.w!);
  await expect(inspector(page).getByText('Caches · 2')).toBeVisible();

  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(saveButton(page)).toBeDisabled();
  expect(((await getJson<Row>(`/workflows/${id.w}`)).cacheIds as string[]).sort()).toEqual([id.c1!, id.c2!].sort());

  await page.reload();
  await waitLoaded(page);
  await expect(cacheEdge(page, id.w!, id.c1!)).toHaveCount(1);
  await expect(cacheEdge(page, id.w!, id.c2!)).toHaveCount(1);
  // dashed, still lines
  for (const c of [id.c1!, id.c2!]) {
    const dash = await cacheEdge(page, id.w!, c).locator('path.cache-line').evaluate((e) => getComputedStyle(e).strokeDasharray);
    expect(dash, 'a cache line is dashed').not.toBe('none');
  }
  await pickWorkflow(page, id.w!);
  await expect(inspector(page).getByText('Caches · 2')).toBeVisible();
  await expect(inspector(page).locator('.chip', { hasText: 'e2e-cc-one' })).toHaveCount(1);
  await expect(inspector(page).locator('.chip', { hasText: 'e2e-cc-two' })).toHaveCount(1);
  await expect(inspector(page).getByRole('button', { name: 'Remove cache e2e-cc-one' })).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: 'Remove cache e2e-cc-two' })).toBeVisible();
});

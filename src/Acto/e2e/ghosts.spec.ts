import { test, expect } from './fixtures';
import {
  ghost, inspector, openAt, outLine, pickStep, save, saveButton, selbar, stNode, tabLabels, toolbar, waitLoaded,
} from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Plan 6 (inspector-tabs spec §6): a deleted item stays on the board as a ghost (faded, dashed, struck through, "deleted · ghost") until the
// page is reloaded. A ghost's toolbar is Restore · Remove; several ghosts get the bar's Restore · Remove. Only e2e- rows are deleted or made.

const steps = async () => (await getJson<Row[]>('/steps')).filter((s) => s.name.startsWith('e2e-gh-'));
const anyGhost = (page: import('@playwright/test').Page) => page.locator('.react-flow__node.ghost, .react-flow__edge.ghost');

async function deleteStep(page: import('@playwright/test').Page, id: string) {
  await pickStep(page, id);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(stNode(page, id)).toHaveCount(0);
}

test('a deleted step stays as a ghost; Restore makes it real again, unchanged', async ({ page }) => {
  const id = await seed({ steps: [{ key: 's', name: 'e2e-gh-one', at: { x: 300, y: 120 }, next: ['t'] }, { key: 't', name: 'e2e-gh-two', at: { x: 600, y: 120 } }] });
  await openAt(page);
  await expect(anyGhost(page)).toHaveCount(0);
  await deleteStep(page, id.s!);

  const g = ghost(page, 'e2e-gh-one');
  await expect(g).toHaveCount(1);
  await expect(g).toContainText('deleted · ghost');
  expect(Number(await g.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.5);
  await expect(g.locator('.sn')).toHaveCSS('text-decoration-line', 'line-through');
  // its wire out is a ghost too (both ends are drawn)
  await expect(page.locator(`.react-flow__edge.ghost[data-id="ghost:wire:${id.s}:${id.t}"]`)).toHaveCount(1);

  // picked: the Deleted tab and its own toolbar
  await g.locator('.sn').click();
  await expect(tabLabels(page)).toHaveText(['Deleted']);
  await expect(inspector(page).locator('.kind')).toHaveText('deleted · step');
  await expect(toolbar(page, 'ghost').getByRole('button')).toHaveText(['Restore', 'Remove']);
  await toolbar(page, 'ghost').getByRole('button', { name: 'Restore' }).click();
  await expect(stNode(page, id.s!)).toBeVisible();
  await expect(g).toHaveCount(0);
  await expect(anyGhost(page)).toHaveCount(0);
  // the delete was never saved: restoring it leaves the step as BaseAPI has it
  await expect(stNode(page, id.s!).locator('.unsaved-mark')).toHaveCount(0);
  await expect(page.locator(`.react-flow__edge[data-id="wire:${id.s}:${id.t}"]`)).toHaveCount(1);
});

test('a ghost outlives a Save; Restore after it makes the step anew, created by the next Save', async ({ page }) => {
  const id = await seed({ steps: [{ key: 's', name: 'e2e-gh-saved', at: { x: 300, y: 120 } }] });
  await openAt(page);
  await deleteStep(page, id.s!);
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  await expect(outLine(page, /^Pushed \d+ changes?$/)).toHaveCount(1);
  expect(await steps()).toEqual([]);
  // the board re-read after the Save keeps the ghost
  const g = ghost(page, 'e2e-gh-saved');
  await expect(g).toHaveCount(1);

  await g.locator('.sn').click();
  await toolbar(page, 'ghost').getByRole('button', { name: 'Restore' }).click();
  await expect(g).toHaveCount(0);
  const back = page.locator('.react-flow__node-step:not(.ghost)').filter({ hasText: 'e2e-gh-saved' });
  await expect(back).toHaveCount(1);
  await expect(back.locator('.unsaved-mark')).toBeVisible();
  await expect(saveButton(page)).toContainText('Save ·');
  await save(page);
  await expect(outLine(page, /^Pushed \d+ changes?$/)).toHaveCount(1);
  const made = await steps();
  expect(made.map((s) => s.name)).toEqual(['e2e-gh-saved']);
  await expect(page.locator('.unsaved-mark')).toHaveCount(0);
});

test('Remove drops a ghost; Ctrl+click of two ghosts shows the bar Restore · Remove; the ghosts outlive a reload (they belong to the draft) [user, 2026-11-23]', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 'a', name: 'e2e-gh-a', at: { x: 300, y: 60 } },
      { key: 'b', name: 'e2e-gh-b', at: { x: 300, y: 200 } },
      { key: 'c', name: 'e2e-gh-c', at: { x: 300, y: 340 } },
    ],
  });
  await openAt(page);
  // the three deleted at once from the bar
  await pickStep(page, id.a!);
  await pickStep(page, id.b!, true);
  await pickStep(page, id.c!, true);
  await selbar(page).getByRole('button', { name: 'Delete', exact: true }).click();
  for (const n of ['e2e-gh-a', 'e2e-gh-b', 'e2e-gh-c']) await expect(ghost(page, n)).toHaveCount(1);

  // Remove: the ghost is gone for this session, the step stays deleted
  await ghost(page, 'e2e-gh-a').locator('.sn').click();
  await toolbar(page, 'ghost').getByRole('button', { name: 'Remove' }).click();
  await expect(ghost(page, 'e2e-gh-a')).toHaveCount(0);
  await expect(stNode(page, id.a!)).toHaveCount(0);

  // two ghosts with Ctrl: the bar, numbered badges, the pick list
  await ghost(page, 'e2e-gh-b').locator('.sn').click();
  await ghost(page, 'e2e-gh-c').locator('.sn').click({ modifiers: ['Control'] });
  await expect(selbar(page).locator('.selbar-pill')).toHaveText('2 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Restore', 'Remove']);
  await expect(inspector(page).locator('.in-picks li')).toHaveText(['e2e-gh-b', 'e2e-gh-c']);
  await selbar(page).getByRole('button', { name: 'Restore' }).click();
  await expect(stNode(page, id.b!)).toBeVisible();
  await expect(stNode(page, id.c!)).toBeVisible();
  await expect(anyGhost(page)).toHaveCount(0);

  // a ghost again, then a browser reload: the ghost of b comes back with the draft, the removed one of a does not; the deletes of a
  // and b are still pending and c is still there; BaseAPI has all three
  await deleteStep(page, id.b!);
  await expect(ghost(page, 'e2e-gh-b')).toHaveCount(1);
  await page.reload();
  await waitLoaded(page);
  await expect(ghost(page, 'e2e-gh-b')).toHaveCount(1);
  await expect(anyGhost(page)).toHaveCount(1);
  await expect(stNode(page, id.c!)).toBeVisible();
  await expect(stNode(page, id.a!)).toHaveCount(0);
  await expect(stNode(page, id.b!)).toHaveCount(0);
  await expect(saveButton(page)).toContainText('Save ·');
  expect((await steps()).map((s) => s.name).sort()).toEqual(['e2e-gh-a', 'e2e-gh-b', 'e2e-gh-c']);
});

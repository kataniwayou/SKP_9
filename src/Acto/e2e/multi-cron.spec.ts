import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { entryEdge, field, inspector, openAt, pickEdge, save, saveButton, selectWorkflowAlone, tab, toolbar, waitLoaded } from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// A workflow has no cron of its own: each entry arrow carries one, edited together in the Workflow tab's Schedules section (or one at a
// time in the arrow's Link tab), saved as the row's entryCrons. Writes only a throwaway workflow and steps (e2e-...); never Start/Stop.

const FAST = '*/10 * * * * *';
const SLOW = '*/30 * * * * *';
const LINK_EDIT = '*/20 * * * * *';

const schedule = (page: Page, step: string) => inspector(page).getByTestId(`schedule:${step}`);
const cronIn = (page: Page, step: string) => schedule(page, step).getByRole('textbox', { name: 'Cron' });
const undo = (page: Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });
const redo = (page: Page) => inspector(page).getByRole('button', { name: 'Redo', exact: true });

const label = (page: Page, wf: string, step: string) => entryEdge(page, wf, step).locator('.entry-cron');

const stored = async (name: string) => (await getJson<Row[]>('/workflows')).find((w) => w.name === name)!;

test('a workflow with two entry arrows: each arrow its own cron, edited from the Schedules section and the Link tab, undone, cleared, saved', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 'a', name: 'e2e-mcron-a', at: { x: 300, y: 40 } },
      { key: 'b', name: 'e2e-mcron-b', at: { x: 300, y: 220 } },
    ],
    workflows: [{ key: 'w', name: 'e2e-mcron-wf', at: { x: 0, y: 130 }, entry: ['a', 'b'] }],
  });
  const [A, B] = [id.a!, id.b!];
  await openAt(page);

  // 1. both arrows from the Schedules section: one row per entry step, in entry order
  await selectWorkflowAlone(page, id.w!);
  await expect(inspector(page).locator('[data-testid^="schedule:"]')).toHaveCount(2);
  await expect(schedule(page, A).locator('.sec-sub')).toHaveText('e2e-mcron-a');
  await expect(schedule(page, B).locator('.sec-sub')).toHaveText('e2e-mcron-b');
  await expect(cronIn(page, A)).toHaveAttribute('placeholder', 'not scheduled');
  await cronIn(page, A).fill(SLOW);
  await cronIn(page, B).fill(FAST);
  await expect(schedule(page, A)).toContainText(/30 seconds/i);
  await expect(schedule(page, B)).toContainText(/10 seconds/i);
  await expect(entryEdge(page, id.w!, A).locator('.entry-cron')).toHaveText(`⏱ ${SLOW}`);
  await expect(entryEdge(page, id.w!, B).locator('.entry-cron')).toHaveText(`⏱ ${FAST}`);

  // 2. Save keeps both through a reload: the Schedules rows and the arrows' labels
  await expect(saveButton(page)).toContainText('Save ·');
  expect((await save(page)).applied).toBe(true);
  expect((await stored('e2e-mcron-wf')).entryCrons).toEqual({ [A]: SLOW, [B]: FAST });
  await page.reload();
  await waitLoaded(page);
  await selectWorkflowAlone(page, id.w!);
  await expect(cronIn(page, A)).toHaveValue(SLOW);
  await expect(cronIn(page, B)).toHaveValue(FAST);
  await expect(label(page, id.w!, A)).toHaveText(`⏱ ${SLOW}`);
  await expect(label(page, id.w!, B)).toHaveText(`⏱ ${FAST}`);

  // 3. B edited in its Link tab: the Schedules section shows it
  await pickEdge(page, entryEdge(page, id.w!, B));
  await tab(page, 'Link').click();
  await expect(field(page, 'Cron')).toHaveValue(FAST);
  await field(page, 'Cron').fill(LINK_EDIT);
  await expect(entryEdge(page, id.w!, B).locator('.entry-cron')).toHaveText(`⏱ ${LINK_EDIT}`);
  await selectWorkflowAlone(page, id.w!);
  await expect(cronIn(page, B)).toHaveValue(LINK_EDIT);
  await expect(cronIn(page, A)).toHaveValue(SLOW);

  // 4. after the reload the history is empty, so undo takes back the Link-tab edit of B alone (B returns to its saved cron); redo restores it
  await expect(undo(page)).toBeEnabled();
  await undo(page).click();
  await expect(cronIn(page, B)).toHaveValue(FAST);
  await expect(cronIn(page, A)).toHaveValue(SLOW);
  await expect(redo(page)).toBeEnabled();
  await redo(page).click();
  await expect(cronIn(page, B)).toHaveValue(LINK_EDIT);
  await expect(cronIn(page, A)).toHaveValue(SLOW);

  // 5. B cleared: only A's cron is left, on A's arrow alone
  await cronIn(page, B).fill('');
  await expect(label(page, id.w!, B)).toHaveCount(0);
  await expect(label(page, id.w!, A)).toHaveText(`⏱ ${SLOW}`);
  await expect(cronIn(page, B)).toHaveValue('');

  // 6. A cleared too: not scheduled
  await cronIn(page, A).fill('');
  await expect(label(page, id.w!, A)).toHaveCount(0);
  await expect(label(page, id.w!, B)).toHaveCount(0);
  for (const step of [A, B]) {
    await expect(cronIn(page, step)).toHaveValue('');
    await expect(cronIn(page, step)).toHaveAttribute('placeholder', 'not scheduled');
  }
  expect((await save(page)).applied).toBe(true);
  expect((await stored('e2e-mcron-wf')).entryCrons ?? {}).toEqual({});

  // 7. an arrow that has a cron is deleted: its cron goes with it and BaseAPI accepts the Save (A still gives the workflow an entry)
  await cronIn(page, B).fill(FAST);
  expect((await save(page)).applied).toBe(true);
  expect((await stored('e2e-mcron-wf')).entryCrons).toEqual({ [B]: FAST });
  await pickEdge(page, entryEdge(page, id.w!, B));
  await toolbar(page, 'entry').getByRole('button', { name: 'Delete' }).click();
  await expect(entryEdge(page, id.w!, B)).toHaveCount(0);
  await selectWorkflowAlone(page, id.w!);
  await expect(inspector(page).locator('[data-testid^="schedule:"]')).toHaveCount(1);
  expect((await save(page)).applied).toBe(true);
  const after = await stored('e2e-mcron-wf');
  expect(after.entryStepIds).toEqual([A]);
  expect(after.entryCrons ?? {}).toEqual({});

  // 8. the throwaway rows are deleted by the fixture after the test
});

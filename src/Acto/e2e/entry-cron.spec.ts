import { test, expect } from './fixtures';
import { entryEdge, field, inspector, openAt, pickEdge, save, saveButton, tab, waitLoaded } from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// An entry arrow's own cron: set in the Link tab, saved, shown on the arrow and in the workflow's entry list, back after a reload.
// Writes only a throwaway workflow (e2e-...); never Start/Stop.

const CRON = '*/10 * * * * *';

test('an entry arrow keeps its own cron through Save and a reload', async ({ page }) => {
  const id = await seed({
    steps: [
      { key: 'a', name: 'e2e-ecron-a', at: { x: 300, y: 40 } },
      { key: 'b', name: 'e2e-ecron-b', at: { x: 300, y: 220 } },
    ],
    workflows: [{ key: 'w', name: 'e2e-ecron-wf', at: { x: 0, y: 130 }, entry: ['a', 'b'], entryCrons: { a: '0 0 * * * *' } }],
  });
  await openAt(page);

  await pickEdge(page, entryEdge(page, id.w!, id.b!));
  await tab(page, 'Link').click();
  await expect(field(page, 'Cron')).toHaveValue('');
  await expect(field(page, 'Cron')).toHaveAttribute('placeholder', 'not scheduled');
  await field(page, 'Cron').fill(CRON);
  await expect(inspector(page)).toContainText(/10 seconds/i);
  await expect(entryEdge(page, id.w!, id.b!).locator('.entry-cron')).toHaveText(`⏱ ${CRON}`);
  await expect(entryEdge(page, id.w!, id.a!).locator('.entry-cron')).toHaveText('⏱ 0 0 * * * *');
  await expect(saveButton(page)).toContainText('Save ·');

  expect((await save(page)).applied).toBe(true);
  const saved = (await getJson<Row[]>('/workflows')).find((w) => w.name === 'e2e-ecron-wf')!;
  expect(saved.entryCrons).toEqual({ [id.a!]: '0 0 * * * *', [id.b!]: CRON });

  await page.reload();
  await waitLoaded(page);
  await pickEdge(page, entryEdge(page, id.w!, id.b!));
  await tab(page, 'Link').click();
  await expect(field(page, 'Cron')).toHaveValue(CRON);
  await expect(entryEdge(page, id.w!, id.b!).locator('.entry-cron')).toHaveText(`⏱ ${CRON}`);

  // cleared again: the arrow is unscheduled (no workflow cron to fall back on)
  await field(page, 'Cron').fill('');
  await expect(entryEdge(page, id.w!, id.b!).locator('.entry-cron')).toHaveText('⏱ not scheduled'); // an arrow with no cron says so [user, 2026-11-25]
  await expect(entryEdge(page, id.w!, id.a!).locator('.entry-cron')).toHaveText('⏱ 0 0 * * * *');
  expect((await save(page)).applied).toBe(true);
});

import { test, expect } from './fixtures';
import {
  cacheTool, dropTool, field, ghost, openAt, outLine, pickStep, PROC_B, regionPoint, renameTo, saveButton, selectWorkflowAlone, stNode, toolbar, toolboxStep,
  waitLoaded, wfNode, workflowTool,
} from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Discard [user, 2026-11-25]: a button left of Save drops every unsaved change at once; Save's count resets and both buttons go
// disabled. It is one undo step (Ctrl+Z brings the changes back), and it never writes to BaseAPI.

const discardButton = (page: import('@playwright/test').Page) => page.locator('button.discard-board');

test('Discard drops every unsaved change: Save\'s count resets, both disable, the board is BaseAPI\'s again; Ctrl+Z brings them back', async ({ page }) => {
  const id = await seed({
    steps: [{ key: 's', name: 'e2e-discard-step', at: { x: 300, y: 100 } }],
    workflows: [{ key: 'w', name: 'e2e-discard-wf', at: { x: 0, y: 30 }, entry: ['s'] }],
  });
  await openAt(page);
  // nothing unsaved: both disabled, Discard left of Save
  await expect(discardButton(page)).toBeDisabled();
  await expect(saveButton(page)).toHaveText('Save');
  const [d, s] = [await discardButton(page).boundingBox(), await saveButton(page).boundingBox()];
  expect(d!.x + d!.width).toBeLessThanOrEqual(s!.x);

  // two changes: a rename and a moved step
  await selectWorkflowAlone(page, id.w!);
  await field(page, 'Name').fill('e2e-discard-wf-renamed');
  const step = stNode(page, id.s!);
  const box = (await step.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 70, { steps: 8 });
  await page.mouse.up();
  await expect(saveButton(page)).toHaveText('Save · 2');
  await expect(discardButton(page)).toBeEnabled();
  await expect(discardButton(page)).toHaveAttribute('title', 'Discard all 2 unsaved changes (Ctrl+Z brings them back)');

  await discardButton(page).click();
  await expect(saveButton(page)).toHaveText('Save');
  await expect(saveButton(page)).toBeDisabled();
  await expect(discardButton(page)).toBeDisabled();
  await expect(wfNode(page, id.w!).locator('.tri-nm')).toHaveText('e2e-discard-wf');
  await expect(wfNode(page, id.w!).locator('.unsaved-mark')).toHaveCount(0);
  await expect(stNode(page, id.s!).locator('.unsaved-mark')).toHaveCount(0);
  expect((await stNode(page, id.s!).boundingBox())!.x).toBeCloseTo(box.x, 0);
  await expect(outLine(page, 'Discarded 2 unsaved changes — Ctrl+Z brings them back')).toBeVisible();
  // BaseAPI was never written
  expect((await getJson<Row>(`/workflows/${id.w}`)).name).toBe('e2e-discard-wf');

  // one undo step: Ctrl+Z brings both back, Ctrl+Y discards them again
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+z');
  await expect(saveButton(page)).toHaveText('Save · 2');
  await expect(wfNode(page, id.w!).locator('.tri-nm')).toHaveText('e2e-discard-wf-renamed');
  await page.keyboard.press('Control+y');
  await expect(saveButton(page)).toHaveText('Save');

  // and the draft went with them: a reload starts clean
  await page.reload();
  await waitLoaded(page);
  await expect(saveButton(page)).toHaveText('Save');
  await expect(discardButton(page)).toBeDisabled();
  await expect(wfNode(page, id.w!).locator('.tri-nm')).toHaveText('e2e-discard-wf');
});

// Only a delete makes a ghost [user, 2026-11-25]: a create taken back by Ctrl+Z or by Discard leaves nothing behind.
test('a new triangle, step or cache taken back by Ctrl+Z or by Discard leaves no ghost; a delete does', async ({ page }) => {
  await openAt(page);
  const ghosts = page.locator('.react-flow__node.ghost');
  const ghostsBefore = await ghosts.count();
  const pane = page.locator('.react-flow__pane');

  // Ctrl+Z of each create
  for (const [tool, kind] of [[workflowTool(page), 'workflow'], [toolboxStep(page, PROC_B), 'step'], [cacheTool(page), 'cache']] as const) {
    const made = await dropTool(page, tool, kind, await regionPoint(page, { x: 120, y: 140 }));
    await pane.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Control+z');
    await expect(page.locator(`.react-flow__node[data-id$="${made}"]`)).toHaveCount(0);
    await expect(ghosts, `${kind} undone`).toHaveCount(ghostsBefore);
  }

  // Discard of all three at once
  await dropTool(page, workflowTool(page), 'workflow', await regionPoint(page, { x: 120, y: 140 }));
  await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 400, y: 140 }));
  await dropTool(page, cacheTool(page), 'cache', await regionPoint(page, { x: 120, y: 320 }));
  await expect(saveButton(page)).toHaveText(/^Save · \d+$/);
  await discardButton(page).click();
  await expect(saveButton(page)).toHaveText('Save');
  await expect(ghosts, 'discarded creates').toHaveCount(ghostsBefore);

  // a delete still makes a ghost
  const step = await dropTool(page, toolboxStep(page, PROC_B), 'step', await regionPoint(page, { x: 400, y: 140 }));
  await renameTo(page, 'e2e-discard-ghost');
  await pane.click({ position: { x: 20, y: 20 } });
  await pickStep(page, step);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  await expect(ghost(page, 'e2e-discard-ghost')).toHaveCount(1);
});

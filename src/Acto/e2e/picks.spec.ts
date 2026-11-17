import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  drawWire, emptyPoint, frameOf, inspector, openBoard, openEmptyBoard, pickFrame, pickStep, pickWire, selbar, stepsOf, throwaway,
  toolbar, wiresOf,
} from './helpers';

// Feature 4 (picks and the selection bar) and feature 16 (the Delete key does nothing). Throwaway frames, never saved,
// and pre-existing ones only picked: nothing is sent.

const badge = (page: Page, sel: string) => page.locator(`${sel} .pick-no`);
const pill = (page: Page) => selbar(page).locator('.selbar-pill');

test('click picks one, Ctrl+click adds and removes, the bar and numbered badges follow, an empty click clears', async ({ page }) => {
  await openEmptyBoard(page);
  const w1 = await throwaway(page, 2);
  const w2 = await throwaway(page, 1);
  await drawWire(page, w1.steps[0]!, w1.steps[1]!);
  const [a, b] = w1.steps as [ReturnType<Page['locator']>, ReturnType<Page['locator']>];
  const c = w2.steps[0]!;
  const wire = wiresOf(page, w1.id).first();
  const aSel = `[data-id="${await a.getAttribute('data-id')}"]`;
  const bSel = `[data-id="${await b.getAttribute('data-id')}"]`;
  const cSel = `[data-id="${await c.getAttribute('data-id')}"]`;

  // one pick: its toolbar with the little arrow, no badge, no bar
  await pickStep(a);
  await expect(a).toHaveClass(/selected/);
  await expect(toolbar(page, 'step')).toBeVisible();
  await expect(toolbar(page, 'step').getByRole('button')).toHaveText(['Copy', 'Delete']);
  await expect(toolbar(page, 'step').locator('.toolbar-arrow')).toBeAttached();
  await expect(page.locator('.pick-no')).toHaveCount(0);
  await expect(selbar(page)).toHaveCount(0);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('step');

  // Ctrl+click adds: no toolbar, the bar with Copy and Delete, numbered badges in pick order
  await pickStep(b, true);
  await expect(toolbar(page, 'step')).toHaveCount(0);
  await expect(pill(page)).toHaveText('2 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Copy', 'Delete']);
  await expect(badge(page, aSel)).toHaveText('1');
  await expect(badge(page, bSel)).toHaveText('2');
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('2 selected');
  await expect(inspector(page).locator('.in-picks li')).toHaveText([await a.locator('.sn').innerText(), await b.locator('.sn').innerText()]);

  // a wire and a step of another workflow: still parts (steps and wires), Copy and Delete
  await pickWire(page, wire, true);
  await expect(pill(page)).toHaveText('3 SELECTED');
  await expect(page.locator('.pick-wire .pick-no')).toHaveText('3');
  await pickStep(c, true);
  await expect(pill(page)).toHaveText('4 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Copy', 'Delete']);
  await expect(inspector(page).locator('.in-picks li')).toHaveCount(4);
  await expect(inspector(page).locator('.in-picks li').nth(2)).toHaveAttribute('data-kind', 'wire');
  await expect(inspector(page)).toContainText(`Undo and Redo act on ${w2.name}, the workflow of the last one picked.`);

  // Ctrl+click a picked one removes it: the numbers close up
  await pickStep(a, true);
  await expect(pill(page)).toHaveText('3 SELECTED');
  await expect(a).not.toHaveClass(/selected/);
  await expect(badge(page, aSel)).toHaveCount(0);
  await expect(badge(page, bSel)).toHaveText('1');
  await expect(page.locator('.pick-wire .pick-no')).toHaveText('2');
  await expect(badge(page, cSel)).toHaveText('3');

  // a workflow with them: nothing in common
  await pickFrame(w2.frame, true);
  await expect(pill(page)).toHaveText('4 SELECTED');
  await expect(selbar(page).locator('.selbar-text')).toHaveText('no action in common');
  await expect(selbar(page).getByRole('button')).toHaveCount(0);
  await expect(badge(page, `[data-id="wf:${w2.id}"]`)).toHaveText('4');

  // a click on empty board clears every pick
  const empty = await emptyPoint(page);
  await page.mouse.click(empty.x, empty.y);
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect(page.locator('.pick-no')).toHaveCount(0);
  await expect(inspector(page)).toContainText('Select a workflow, step or wire to see and edit it here.');

  // workflows only: Save n (the unsaved ones) and Delete; Start/Stop never pressed
  await pickFrame(w1.frame);
  await expect(toolbar(page, 'workflow')).toBeVisible();
  await pickFrame(w2.frame, true);
  await expect(pill(page)).toHaveText('2 SELECTED');
  await expect(selbar(page).getByRole('button', { name: 'Save 2', exact: true })).toBeVisible();
  await expect(selbar(page).getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await expect(badge(page, `[data-id="wf:${w1.id}"]`)).toHaveText('1');
  await expect(badge(page, `[data-id="wf:${w2.id}"]`)).toHaveText('2');
});

test('Esc clears the picks', async ({ page }) => {
  // APP BUG (the brief's feature 4: "Esc/empty click clears"): Esc leaves every pick as it was (the selection bar,
  // the badges and the Inspector's list stay). An empty click does clear them (the test above). Spec §6 names Esc only
  // for cancelling a drag, so this may be a gap in the spec as much as in the code.
  test.fail();
  await openEmptyBoard(page);
  const w = await throwaway(page, 2);
  await pickStep(w.steps[0]!);
  await pickStep(w.steps[1]!, true);
  await expect(pill(page)).toHaveText('2 SELECTED');
  await page.keyboard.press('Escape');
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect(inspector(page)).toContainText('Select a workflow, step or wire to see and edit it here.');
});

test('the Delete and Backspace keys do nothing to picked steps, wires or frames', async ({ page, stack }) => {
  await openEmptyBoard(page);
  const w = await throwaway(page, 2);
  await drawWire(page, w.steps[0]!, w.steps[1]!);
  const undoBtn = inspector(page).getByRole('button', { name: 'Undo', exact: true });
  for (const pick of [() => pickStep(w.steps[0]!), () => pickWire(page, wiresOf(page, w.id).first()), () => pickFrame(w.frame)]) {
    await pick();
    for (const key of ['Delete', 'Backspace']) await page.keyboard.press(key);
  }
  await pickStep(w.steps[0]!);
  await pickStep(w.steps[1]!, true);
  await pickWire(page, wiresOf(page, w.id).first(), true);
  for (const key of ['Delete', 'Backspace']) await page.keyboard.press(key);
  await expect(stepsOf(page, w.id)).toHaveCount(2);
  await expect(wiresOf(page, w.id)).toHaveCount(1);
  await expect(frameOf(page, w.id)).toBeVisible();
  // and nothing was recorded: three undos take the wire and the two steps away, then there is nothing left to undo
  await pickFrame(w.frame);
  for (let i = 0; i < 3; i++) await undoBtn.click();
  await expect(stepsOf(page, w.id)).toHaveCount(0);
  await expect(undoBtn).toBeDisabled();

  // a pre-existing workflow and one of its steps: still there, still saved (the guard checks the unsaved tags too)
  await openBoard(page);
  let pre = '';
  for (const wf of stack.workflows) if (!pre && !stack.designed.includes(wf.id) && await stepsOf(page, wf.id).count() > 0) pre = wf.id;
  expect(pre, 'a pre-existing workflow with steps').not.toBe('');
  const frame = frameOf(page, pre);
  await pickFrame(frame);
  for (const key of ['Delete', 'Backspace']) await page.keyboard.press(key);
  const step = stepsOf(page, pre).first();
  await step.click();
  await expect(step).toHaveClass(/selected/);
  for (const key of ['Delete', 'Backspace']) await page.keyboard.press(key);
  await expect(step).toBeVisible();
  await expect(frame.locator('.unsaved-tag')).toHaveCount(0);
});

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  cachesOf, cacheTool, dragOnto, drawWire, field, inspector, openEmptyBoard, outLine, pickFrame, pickStep, PROC_A, throwaway, toolbar,
  wiresOf,
} from './helpers';

// Feature 8: the Inspector's editors, Undo/Redo. Throwaway frames; only the "Undo back to saved" test saves one (a
// throwaway with no processor edit). Processor and schema-slot fields are edited and undone, never saved (the guard
// refuses a save that carries one).

const undoBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });
const redoBtn = (page: Page) => inspector(page).getByRole('button', { name: 'Redo', exact: true });
/** Focus off the fields (Ctrl+Z / Ctrl+Y are the browser's own while typing in one). */
const blur = (page: Page) => inspector(page).locator('.ins-title').click();

test('workflow fields: name, version, cron (with its text), description; typing in a field is one undo step', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 2);
  await drawWire(page, f.steps[0]!, f.steps[1]!);
  await pickFrame(f.frame);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('workflow');
  await expect(inspector(page).locator('.ins-title small')).toContainText('unsaved');
  const name = field(page, 'Name');
  await expect(name).toHaveValue(f.name);
  await expect(undoBtn(page)).toBeEnabled();
  await expect(redoBtn(page)).toBeDisabled();

  // several keystrokes in one field: one undo step
  await name.click();
  await name.press('End');
  await name.pressSequentially('-renamed');
  await expect(f.frame.locator('.nm')).toHaveText(`${f.name}-renamed`);
  await expect(inspector(page).locator('.ph .hw')).toHaveText(`${f.name}-renamed`);
  await undoBtn(page).click();
  await expect(f.frame.locator('.nm')).toHaveText(f.name);
  await expect(name).toHaveValue(f.name);
  await expect(redoBtn(page)).toBeEnabled();
  await redoBtn(page).click();
  await expect(f.frame.locator('.nm')).toHaveText(`${f.name}-renamed`);
  // the keys do the same, off the fields
  await blur(page);
  await page.keyboard.press('Control+z');
  await expect(f.frame.locator('.nm')).toHaveText(f.name);
  await page.keyboard.press('Control+y');
  await expect(f.frame.locator('.nm')).toHaveText(`${f.name}-renamed`);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await expect(f.frame.locator('.nm')).toHaveText(`${f.name}-renamed`);

  await field(page, 'Version').fill('2.3.4');
  await expect(f.frame.locator('.meta')).toHaveText('2.3.4 · not scheduled');
  await expect(inspector(page).locator('.in-note')).toHaveText('not scheduled');
  await field(page, 'Cron').fill('0 */5 * * * *');
  const note = inspector(page).locator('.in-note');
  await expect(note).not.toHaveText('not scheduled');
  await expect(note).not.toHaveText('0 */5 * * * *');
  await expect(note).toContainText(/5 minutes/);
  await expect(f.frame.locator('.meta')).toHaveText(`2.3.4 · ${await note.innerText()}`);
  await field(page, 'Description').fill('made by the e2e suite');
  await expect(field(page, 'Description')).toHaveValue('made by the e2e suite');
  // the read-outs
  const ro = (k: string) => inspector(page).locator('dt', { hasText: new RegExp(`^${k}$`) }).locator('xpath=following-sibling::dd[1]');
  await expect(ro('Steps')).toHaveText('2');
  await expect(ro('Wires')).toHaveText('1');
  // emptying the cron unschedules it
  await field(page, 'Cron').fill('');
  await expect(f.frame.locator('.meta')).toHaveText('2.3.4 · not scheduled');
});

test('step fields: name, version, description, entry condition (every wire into it follows)', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 2);
  await drawWire(page, f.steps[0]!, f.steps[1]!);
  const b = f.steps[1]!;
  await pickStep(b);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('step');
  await expect(inspector(page).locator('.ins-title small')).toHaveText(`in ${f.name}`);
  const name = field(page, 'Name');
  await name.fill('e2e-step');
  await expect(b.locator('.sn')).toHaveText('e2e-step');
  await field(page, 'Version').fill('9.9.9');
  await expect(b.locator('.nf .mt')).toHaveText('9.9.9');
  await field(page, 'Description').fill('a step of the e2e suite');
  await expect(field(page, 'Description')).toHaveValue('a step of the e2e suite');

  const wire = wiresOf(page, f.id).first();
  await expect(wire.locator('g.link-wire')).toHaveAttribute('data-condition', 'Completed');
  const cond = field(page, 'Entry condition · colours every wire into this step');
  await expect(cond.locator('option')).toHaveText(['C · Completed', 'F · Failed', 'X · Cancelled', 'A · Always', 'N · Never']);
  await cond.selectOption({ label: 'F · Failed' });
  await expect(wire.locator('g.link-wire')).toHaveAttribute('data-condition', 'Failed');
  await expect(wire.locator('text.pilltx')).toHaveText('F');
  await expect(wire.locator('path.wire')).toHaveAttribute('stroke', '#E0482F');
  await cond.selectOption({ label: 'A · Always' });
  await expect(wire.locator('text.pilltx')).toHaveText('A');
  // two changes in a row to the same field are one undo step, like typing
  await undoBtn(page).click();
  await expect(wire.locator('text.pilltx')).toHaveText('C');
  await expect(cond).toHaveValue('1');
  await redoBtn(page).click();
  await expect(wire.locator('text.pilltx')).toHaveText('A');
});

/** A throwaway with one step, saved (so its graph, the processor's schemas with it, is read back), the step picked. */
async function savedWithStep(page: Page) {
  await openEmptyBoard(page);
  const f = await throwaway(page, 1);
  await pickFrame(f.frame);
  const name = `e2e-insp-${Date.now()}`;
  await field(page, 'Name').fill(name);
  await toolbar(page, 'workflow').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(outLine(page, `${name}: Kibana diagram published`)).toHaveCount(1);
  await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
  const s = page.locator(`.react-flow__node-step[data-id^="st:${f.id}:"]`).first();
  await pickStep(s);
  return { ...f, name, step: s };
}

test('assignment payload: a payload the config schema refuses shows its problems and is kept; Remove assignment takes it away', async ({ page }) => {
  const f = await savedWithStep(page);
  const payload = field(page, 'Payload · JSON');
  await expect(payload).toHaveValue('');
  await expect(inspector(page).getByRole('button', { name: 'Remove assignment' })).toHaveCount(0);
  // archive-expander-config: { maxDepth: integer >= 1 }
  await payload.fill('{"maxDepth": 0}');
  await expect(inspector(page).locator('.in-problem')).toContainText([/\/maxDepth: must be >= 1/]);
  await expect(inspector(page).getByRole('button', { name: 'Remove assignment' })).toBeVisible();
  await expect(f.frame.locator('.unsaved-tag')).toBeVisible();
  // kept: away and back, it is still there with its problem
  await pickFrame(f.frame);
  await pickStep(f.step);
  await expect(field(page, 'Payload · JSON')).toHaveValue('{"maxDepth": 0}');
  await expect(inspector(page).locator('.in-problem').first()).toBeVisible();
  await field(page, 'Payload · JSON').fill('{"maxDepth": 2}');
  await expect(inspector(page).locator('.in-problem')).toHaveCount(0);
  await inspector(page).getByRole('button', { name: 'Remove assignment' }).click();
  await expect(field(page, 'Payload · JSON')).toHaveValue('');
  await expect(inspector(page).getByRole('button', { name: 'Remove assignment' })).toHaveCount(0);
  // the payload was one undo step (typing in one field), Remove assignment another: two undos are back to saved
  await undoBtn(page).click();
  await expect(field(page, 'Payload · JSON')).toHaveValue('{"maxDepth": 2}');
  await undoBtn(page).click();
  await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
});

test('a payload that is not JSON says so, and is kept', async ({ page }) => {
  // Was an app bug (fixed 2026-11-18): text that is not JSON showed nothing at all under the payload field.
  const f = await savedWithStep(page);
  await field(page, 'Payload · JSON').fill('{"maxDepth": ');
  await pickFrame(f.frame);
  await pickStep(f.step);
  await expect(field(page, 'Payload · JSON')).toHaveValue('{"maxDepth": ');
  await expect(inspector(page).locator('.in-problem, .in-note').filter({ hasText: /JSON/ })).toBeVisible({ timeout: 3000 });
});

test("a step just dropped from the toolbox has its payload checked against the processor's config schema", async ({ page }) => {
  // Was an app bug (fixed 2026-11-18): a step added from the toolbox showed its processor's schema slots as "definition
  // not loaded" and checked no payload until its workflow was saved; the schemas now come from BaseAPI's schema list.
  await openEmptyBoard(page);
  const f = await throwaway(page, 1);
  await pickStep(f.steps[0]!);
  // the same payload a saved workflow's step shows a problem for (the test above)
  await field(page, 'Payload · JSON').fill('{"maxDepth": 0}');
  await expect(inspector(page).locator('.in-problem').first()).toBeVisible({ timeout: 3000 });
});

test('cache fields: name, version, description, root, items', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 0);
  const fb = (await f.frame.boundingBox())!;
  await dragOnto(page, cacheTool(page), fb.x + fb.width / 2, fb.y + fb.height / 2);
  const chip = cachesOf(page, f.id).first();
  await chip.click();
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('cache');
  await expect(inspector(page).locator('.ins-title small')).toHaveText(`cache · in ${f.name}`);
  await field(page, 'Name').fill('e2e-cache');
  await expect(chip.locator('.cache-nm')).toHaveText('e2e-cache');
  await field(page, 'Version').fill('3.0.0');
  await field(page, 'Description').fill('a cache of the e2e suite');
  await field(page, 'Root').fill('$.root');
  await field(page, 'Items').fill('{"k": 1}');
  for (const [k, v] of [['Version', '3.0.0'], ['Description', 'a cache of the e2e suite'], ['Root', '$.root'], ['Items', '{"k": 1}']] as const) {
    await expect(field(page, k)).toHaveValue(v);
  }
  await expect(toolbar(page, 'cache')).toBeVisible();
});

test('processor and schema-slot fields edit, and Undo takes the edit back (never saved)', async ({ page }) => {
  const f = await savedWithStep(page);
  const s = f.step;
  const pname = field(page, 'Processor name');
  await expect(pname).toHaveValue(PROC_A);
  await pname.fill(`${PROC_A}-e2e`);
  await expect(s.locator('.sp2')).toHaveText(`${PROC_A}-e2e`);
  await expect(f.frame.locator('.unsaved-tag')).toBeVisible();
  await undoBtn(page).click();
  await expect(s.locator('.sp2')).toHaveText(PROC_A);
  await expect(field(page, 'Processor name')).toHaveValue(PROC_A);
  const desc = await field(page, 'Processor description').inputValue();
  await field(page, 'Processor description').fill('changed and undone');
  await undoBtn(page).click();
  await expect(field(page, 'Processor description')).toHaveValue(desc);

  // the Config slot: its schema's fields
  const slot = field(page, 'Config schema name');
  await expect(slot).toBeVisible();
  const was = await slot.inputValue();
  await slot.fill(`${was}-e2e`);
  await expect(field(page, 'Config schema name')).toHaveValue(`${was}-e2e`);
  await expect(f.frame.locator('.unsaved-tag')).toBeVisible();
  await undoBtn(page).click();
  await expect(field(page, 'Config schema name')).toHaveValue(was);
  await expect(field(page, 'Config schema definition')).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: 'Clear Config' })).toBeVisible();
  // every edit undone: back to what was saved, nothing to save
  await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
  await expect(undoBtn(page)).toBeDisabled();
});

test('Undo back to the saved state clears the unsaved tag', async ({ page }) => {
  await openEmptyBoard(page);
  const f = await throwaway(page, 1);
  await pickFrame(f.frame);
  const name = `e2e-undo-${Date.now()}`;
  await field(page, 'Name').fill(name);
  await toolbar(page, 'workflow').getByRole('button', { name: 'Save', exact: true }).click();
  // the save is done (an edit made while it runs is refused) once the diagram is published
  await expect(outLine(page, `${name}: Kibana diagram published`)).toHaveCount(1);
  await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
  await expect(undoBtn(page)).toBeDisabled();
  await field(page, 'Description').fill('an edit to undo');
  await expect(f.frame.locator('.unsaved-tag')).toBeVisible();
  await expect(inspector(page).locator('.ins-title small')).toContainText('unsaved');
  await undoBtn(page).click();
  await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
  await expect(inspector(page).locator('.ins-title small')).not.toContainText('unsaved');
  await redoBtn(page).click();
  await expect(f.frame.locator('.unsaved-tag')).toBeVisible();
  await undoBtn(page).click();
  await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
});

import { LIVE } from './standin';
import { expect, test } from './valence';

// Field checks and BaseApi's dry run (spec §3c, §4): edits are virtual; each field is checked as BaseApi's rules say while
// typing; an edit that breaks a rule is unfinished (no halo, Apply waits); BaseApi's dry run judges the whole change set
// 600 ms after it settles and writes nothing. The schema definition is frozen while a processor uses it (the unlock).

const AMBER = '#fbbf24';

test('a broken version is marked and unfinished; fixed, it is a change with the amber halo and Apply counts it', async ({ v }) => {
  const step = `step:${v.api.project.steps[0]!.id}`;
  await v.pin(step);
  await v.fill({ version: 'one' });
  await expect(v.inspector().locator('.ferr').first()).toContainText('Version');
  await expect(v.inspector().locator('.insp-virtual.unfinished')).toContainText('Unfinished edit: fix the marked field');
  expect(await v.halo(step)).not.toBe(AMBER);
  await expect(v.page.locator('.menubar .ap-b')).toHaveAttribute('aria-disabled', 'true');

  const runs = v.api.dryRuns.length;
  await v.fill({ version: '9.9.9' });
  await expect(v.inspector().locator('.ferr')).toHaveCount(0);
  await expect(v.inspector().locator('.insp-virtual')).toContainText('● Changed in Valence only, not applied');
  await v.dryRunAfter(runs);
  expect(await v.halo(step)).toBe(AMBER);
  const sent = v.api.dryRuns.at(-1)!;
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ op: 'update', table: 'steps', id: step.split(':')[1] });
  expect(sent[0]!.row?.version).toBe('9.9.9');
  expect(await v.said(/^Dry run by BaseApi/)).toMatch(/^Dry run by BaseApi: 1 change, all pass/);
  await expect(v.page.locator('.menubar .ap-b')).toHaveAttribute('aria-disabled', 'false');
  await expect(v.page.locator('.menubar .ap-b')).toHaveText(/Apply\s*1/);
  // the edited name shows on the canvas label too; the Canvas tab is dirty
  await expect(v.page.locator('.doctab.dirty')).toHaveCount(1);
});

test('BaseApi\'s rules while typing: name length, cron fields, cache root', async ({ v }) => {
  const wf = v.key('wf', 'simple-abc');
  await v.pin(wf);
  await v.fill({ name: 'x'.repeat(201) });
  await expect(v.field('name')).toHaveAttribute('aria-invalid', 'true');
  await v.fill({ name: 'simple-abc' });
  await v.fill({ cronExpression: 'every day' });
  await expect(v.field('cronExpression')).toHaveAttribute('aria-invalid', 'true');
  await v.fill({ cronExpression: '0 */6 * * *' });
  await expect(v.field('cronExpression')).not.toHaveAttribute('aria-invalid', 'true');

  const cache = `cache:${v.api.project.caches[0]!.id}`;
  await v.pin(cache);
  await v.fill({ root: 'a:b' });
  await expect(v.field('root')).toHaveAttribute('aria-invalid', 'true');
  await v.fill({ items: '{"seed":' });
  await expect(v.field('items')).toHaveAttribute('aria-invalid', 'true');
});

test('the schema definition is frozen while a processor uses it, and opens when that arrow is deleted', async ({ v }) => {
  const schema = v.api.project.schemas.find((s) => s.name === 'kafka-importer-config')!;
  const proc = v.api.project.processors.find((p) => [p.inputSchemaId, p.outputSchemaId, p.configSchemaId].includes(schema.id))!;
  const slot = proc.configSchemaId === schema.id ? 'config' : proc.inputSchemaId === schema.id ? 'input' : 'output';
  const sk = `schema:${schema.id}`, pk = `proc:${proc.id}`;

  await v.pin(sk);
  await v.park();
  await expect(v.field('definition')).not.toBeEditable();
  await expect(v.inspector().locator('.fhint.locked')).toContainText(`Frozen: used by ${proc.name}`);
  await expect(v.field('name')).toBeEditable();

  await v.pinArrow(slot, pk, sk);
  await v.canvasKey('Delete');
  await v.pin(sk);
  await v.park();
  await expect(v.inspector().locator('.fhint.open')).toContainText('Open: no processor uses this schema in Valence');
  await expect(v.field('definition')).toBeEditable();

  // a definition that is not a JSON Schema is marked, no change; a valid one is a change
  await v.fill({ definition: '{"type": 5}' });
  await expect(v.inspector().locator('.ferr').first()).toBeVisible();
  await v.fill({ definition: '{"type":"object","properties":{"value":{"type":"string"}}}' });
  await expect(v.inspector().locator('.insp-virtual')).toContainText('● Changed in Valence only, not applied');

  // undo the definition edits, then the arrow's delete: frozen again
  await v.canvasKey('Control+z');
  await v.canvasKey('Control+z');
  await v.canvasKey('Control+z');
  await v.pin(sk);
  await v.park();
  await expect(v.inspector().locator('.fhint.locked')).toContainText('Frozen: used by');
  await expect(v.field('definition')).not.toBeEditable();
});

test('a change BaseApi\'s dry run refuses: its words under the field, unfinished, no halo, Apply waits', async ({ v }) => {
  test.skip(LIVE, 'the refusal is the stand-in\'s');
  v.api.refuse = (c) => (c.table === 'steps'
    ? { status: 400, title: 'One or more validation errors occurred.', errors: { Description: ['Description is refused by the stand-in.'] } }
    : null);
  const step = `step:${v.api.project.steps[0]!.id}`;
  await v.pin(step);
  const runs = v.api.dryRuns.length;
  await v.fill({ description: 'refused please' });
  await v.dryRunAfter(runs);
  await expect(v.inspector().locator('.ferr.remote')).toHaveText('BaseApi: Description is refused by the stand-in.');
  await expect(v.inspector().locator('.insp-virtual.unfinished')).toContainText("BaseApi's dry run refuses it");
  expect(await v.halo(step)).not.toBe(AMBER);
  expect(await v.said(/^Dry run by BaseApi/)).toMatch(/^Dry run by BaseApi: 1 of 1 refused/);
  await expect(v.page.locator('.menubar .ap-b')).toHaveAttribute('aria-disabled', 'true');

  // BaseApi passes it now: the next change's dry run clears the refusal
  v.api.refuse = () => null;
  const again = v.api.dryRuns.length;
  await v.fill({ description: 'passed now' });
  await v.dryRunAfter(again);
  await expect(v.inspector().locator('.ferr.remote')).toHaveCount(0);
  expect(await v.halo(step)).toBe(AMBER);
});

test('Apply opens the confirmation with every change and the workflows it affects; Cancel and Escape close it, nothing is sent', async ({ v }) => {
  const step = v.api.project.steps[0]!;
  await v.pin(`step:${step.id}`);
  const runs = v.api.dryRuns.length;
  await v.fill({ description: 'to be confirmed' });
  await v.dryRunAfter(runs);
  const apply = v.page.locator('.menubar .ap-b');
  await expect(apply).toHaveAttribute('aria-disabled', 'false');

  await apply.click();
  const dlg = v.page.getByRole('dialog', { name: 'Apply changes' });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.ap-t')).toHaveText('Apply 1 change to BaseApi?');
  await expect(dlg.locator(`.ap-row[data-atom="step:${step.id}"]`)).toContainText(step.name);
  await expect(dlg.locator('.ap-chip.u')).toContainText('1 updated');
  await expect(dlg.locator('.ap-note')).toContainText('All or nothing');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);

  await apply.click();
  await expect(dlg).toBeVisible();
  await v.page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  // the draft is untouched
  expect((await v.session()).edits?.[`step:${step.id}`]?.description).toBe('to be confirmed');
});

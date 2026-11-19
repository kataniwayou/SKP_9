import { test, expect } from './fixtures';
import {
  COLLAPSER, FETCHER, childTab, entry, field, inspector, newStep, newWorkflow, openAt, payloadOf, pickStep, rowNamed, save,
  selectWorkflowAlone, stNode, tab, unsavedCount,
} from './helpers';
import { getJson, type Row } from './stack';

// [user, 2026-11-19] "I create new step kafkaexporter, wire it up to new workflow and select both, it didn't populate on payload the json
// placeholders same as studio": Studio's "＋ Create" lays a new assignment's payload out from the step's processor's config schema
// (payloadSkeleton: a required key as a "<type>" marker the check names, an optional one as its default or its type's empty value).
// Everything is built through the UI from an empty region; the rows are e2e- ones (the teardown removes them).

const P = 'e2e-mk-';

test('＋ Create on a new step lays the payload out from its config schema; the check names the placeholders; filled in, it saves', async ({ page }) => {
  await openAt(page);
  const wf = await newWorkflow(page, { x: 0, y: 60 }, `${P}wf`);
  const st = await newStep(page, FETCHER, { x: 300, y: 60 }, `${P}fetch`);
  await entry(page, wf, st);

  // the workflow with the new step: Step › the workflow's tab has no assignment yet, and offers ＋ Create
  await selectWorkflowAlone(page, wf);
  await pickStep(page, st);
  await expect(stNode(page, st).locator('.node.sel')).toHaveCount(1);
  await tab(page, 'Step').click();
  await childTab(page, 'Step', `${P}wf`).click();
  await expect(inspector(page)).toContainText(`No assignment yet for ${P}wf`);
  await expect(field(page, 'Payload')).toHaveCount(0); // as Studio: no Payload editor until the assignment exists
  const before = await unsavedCount(page);
  await inspector(page).getByRole('button', { name: '＋ Create' }).click();

  // named as Studio names it: <step name>-assignment, version 1.0.0
  await expect(inspector(page).locator('[aria-label="Unique name"]')).toHaveText(`${P}fetch-assignment 1.0.0`);
  // the payload as Studio lays it out from file-fetcher-config: both required integers as markers, the optional array empty
  const box = await payloadOf(page, `${P}wf`);
  const laidOut = { maximumSizeBytes: '<integer>', minimumSizeBytes: '<integer>', allowedExtensions: [] };
  await expect(box).toHaveValue(JSON.stringify(laidOut, null, 2));
  await expect(inspector(page).getByRole('button', { name: '＋ Create' })).toHaveCount(0);
  await expect(inspector(page).locator('.in-problem', { hasText: '/maximumSizeBytes: still a placeholder: fill in an integer' })).toHaveCount(1);
  await expect(inspector(page).locator('.in-problem', { hasText: '/minimumSizeBytes: still a placeholder: fill in an integer' })).toHaveCount(1);
  await expect(stNode(page, st).locator('.key-chip')).toContainText('3 keys');
  expect(await unsavedCount(page)).toBeGreaterThan(before);

  // filled in: the check passes, and Save stores exactly that payload on the new step for the new workflow
  const filled = { maximumSizeBytes: 1024, minimumSizeBytes: 0, allowedExtensions: ['csv'] };
  await box.fill(JSON.stringify(filled, null, 2));
  await expect(inspector(page).locator('.in-problem')).toHaveCount(0);
  await expect(inspector(page)).toContainText('✓ checked against file-fetcher-config');
  const answer = await save(page);
  expect(answer.applied).toBe(true);
  const w = await rowNamed('workflows', `${P}wf`);
  const s = await rowNamed('steps', `${P}fetch`);
  const rows = (await getJson<Row[]>('/assignments')).filter((a) => (w.assignmentIds as string[]).includes(a.id as string));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.stepId).toBe(s.id);
  expect(JSON.parse(rows[0]!.payload as string)).toEqual(filled);
  expect(rows[0]!.name).toBe(`${P}fetch-assignment`);
});

test('Remove assignment takes the Payload editor away and brings ＋ Create back, as Studio; ＋ Create again lays the skeleton out', async ({ page }) => {
  await openAt(page);
  const wf = await newWorkflow(page, { x: 0, y: 460 }, `${P}wf3`);
  const st = await newStep(page, FETCHER, { x: 300, y: 460 }, `${P}fetch3`);
  await entry(page, wf, st);
  await selectWorkflowAlone(page, wf);
  await pickStep(page, st);
  await childTab(page, 'Step', `${P}wf3`).click();
  await inspector(page).getByRole('button', { name: '＋ Create' }).click();
  await (await payloadOf(page, `${P}wf3`)).fill('{"minimumSizeBytes": 1, "maximumSizeBytes": 2}');
  await expect(stNode(page, st).locator('.key-chip')).toContainText('2 keys');

  await inspector(page).getByRole('button', { name: 'Remove assignment' }).click();
  await expect(field(page, 'Payload')).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: 'Remove assignment' })).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: '＋ Create' })).toBeVisible();
  await expect(inspector(page)).toContainText(`No assignment yet for ${P}wf3`);
  await expect(stNode(page, st).locator('.key-chip')).toHaveCount(0);

  await inspector(page).getByRole('button', { name: '＋ Create' }).click();
  await expect(field(page, 'Payload')).toHaveValue(JSON.stringify({ maximumSizeBytes: '<integer>', minimumSizeBytes: '<integer>', allowedExtensions: [] }, null, 2));
});

test('＋ Create on a step whose processor\'s config schema has no properties makes {}; Undo takes the new assignment back', async ({ page }) => {
  await openAt(page);
  const wf = await newWorkflow(page, { x: 0, y: 260 }, `${P}wf2`);
  const st = await newStep(page, COLLAPSER, { x: 300, y: 260 }, `${P}collapse`);
  await entry(page, wf, st);
  await selectWorkflowAlone(page, wf);
  await pickStep(page, st);
  await childTab(page, 'Step', `${P}wf2`).click();
  await inspector(page).getByRole('button', { name: '＋ Create' }).click();
  await expect(await payloadOf(page, `${P}wf2`)).toHaveValue('{}');
  await expect(stNode(page, st).locator('.key-chip')).toContainText('0 keys');
  await inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(inspector(page).getByRole('button', { name: '＋ Create' })).toBeVisible();
  await expect(stNode(page, st).locator('.key-chip')).toHaveCount(0);
  await expect(field(page, 'Payload')).toHaveCount(0);
});

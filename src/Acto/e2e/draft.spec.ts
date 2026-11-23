import { test, expect } from './fixtures';
import { field, ghost, openAt, outLine, pickStep, saveButton, selectWorkflowAlone, stNode, toolbar, waitLoaded, wfNode } from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// The draft lives in localStorage and Save pushes only after one dry run of every changed workflow passes [user, 2026-11-23].
// Nothing here starts or stops a workflow; every row is an e2e- row.

test('a draft with a problem (a cycle) is not pushed: Output lists it, the triangle shows its count, and the draft survives a reload', async ({ page }) => {
  // seeded straight through BaseAPI (no Acto rule), so the workflow already has a cycle s1 → s2 → s1
  const id = await seed({
    steps: [
      { key: 's1', name: 'e2e-draft-one', at: { x: 300, y: 100 }, next: ['s2'] },
      { key: 's2', name: 'e2e-draft-two', at: { x: 600, y: 100 }, next: ['s1'] },
    ],
    workflows: [{ key: 'w', name: 'e2e-draft-wf', at: { x: 0, y: 30 }, entry: ['s1'] }],
  });
  await openAt(page);
  await selectWorkflowAlone(page, id.w!);
  await field(page, 'Name').fill('e2e-draft-wf-renamed');

  const applied: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/model/apply') applied.push(r.url()); });
  const checked = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/workflows/validate');
  await saveButton(page).click();
  await checked;
  await expect(outLine(page, /^Not pushed: \d+ problems? in 1 workflow$/)).toHaveCount(1);
  await expect(outLine(page, /^e2e-draft-wf-renamed: /).first()).toBeVisible();
  await expect(wfNode(page, id.w!).locator('.tri-problems')).toBeVisible();
  expect(applied).toEqual([]);
  expect((await getJson<Row>(`/workflows/${id.w}`)).name).toBe('e2e-draft-wf');

  // the draft is kept: a reload shows the rename still unsaved
  await page.reload();
  await waitLoaded(page);
  await expect(wfNode(page, id.w!).locator('.tri-nm')).toHaveText('e2e-draft-wf-renamed');
  await expect(saveButton(page)).toContainText('Save ·');
});

test('a deleted step stays a ghost across a reload, still waiting for Save', async ({ page }) => {
  const id = await seed({ steps: [{ key: 's', name: 'e2e-draft-lone', at: { x: 300, y: 100 } }] });
  await openAt(page);
  await pickStep(page, id.s!);
  await toolbar(page, 'step').getByRole('button', { name: 'Delete' }).click();
  await expect(stNode(page, id.s!)).toHaveCount(0);
  await expect(ghost(page, 'e2e-draft-lone')).toHaveCount(1);
  await page.reload();
  await waitLoaded(page);
  await expect(ghost(page, 'e2e-draft-lone')).toHaveCount(1);
  await expect(stNode(page, id.s!)).toHaveCount(0);
  await expect(saveButton(page)).toContainText('Save · 1');
});

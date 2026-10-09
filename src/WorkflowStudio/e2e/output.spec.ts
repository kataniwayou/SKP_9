import type { Locator, Page } from '@playwright/test';
import { documentPanel, edge, freeWire, inspector, layOn, node, openWorkflow, outputLines, problems, save, shapeByHand, tab } from './studio';
import { createCircuitThrowaway, expect, removeThrowaway, test, type CircuitThrowaway } from './throwaway';

// Output is the only message pane (the user's decisions, 2026-10-09): the current problems pinned red at its top, then
// the log of what Save did, from "Save started" through BaseApi's own log to the alignment, errors red, kept across a
// refresh. Real mouse and keyboard. The browser writes only Save of this run's throwaway (`e2e-9-…`: a, b, c
// Completed, d Failed; wf -> a, a -> b, a -> d, b -> c). The tests build on each other's state, so they run in order.
test.describe.configure({ mode: 'serial', retries: 0 });
let t: CircuitThrowaway;
test.beforeAll(async ({ request }) => { t = await createCircuitThrowaway(request); });
test.afterAll(async ({ request }) => { await removeThrowaway(request); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

const SHOTS = process.env.OUTPUT_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const RED = 'rgb(248, 113, 113)';

async function open(page: Page): Promise<Locator> {
  await openWorkflow(page, t.workflow);
  return documentPanel(page, t.workflow);
}

/** Picks step `id` on the canvas and types `text` over one of its Inspector fields, with the real keyboard. */
async function typeInto(page: Page, panel: Locator, id: string, label: string, text: string): Promise<void> {
  await node(panel, id).click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText('STEP');
  await inspector(page).getByLabel(label, { exact: true }).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}

/** Output's lines as [text without the time, is it red]. */
async function lines(page: Page): Promise<{ text: string; red: boolean; name: string }[]> {
  return (await outputLines(page)).evaluateAll((els) => els.map((el) => ({
    text: [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(),
    red: el.classList.contains('err'),
    name: el.querySelector('b')?.textContent ?? '',
  })));
}

/** Each of `wanted` is the start of a line, in this order; returns those lines. */
function inOrder(all: { text: string; red: boolean }[], wanted: string[]): { text: string; red: boolean }[] {
  let from = 0;
  return wanted.map((w) => {
    const at = all.findIndex((l, i) => i >= from && l.text.startsWith(w));
    expect(at, `"${w}" after line ${from} in:\n${all.map((l) => l.text).join('\n')}`).toBeGreaterThanOrEqual(0);
    from = at + 1;
    return all[at]!;
  });
}

test('there is no Problems pane: not in the dock, the View menu or after Reset; an old session holding one loads without it', async ({ page }) => {
  await open(page);
  await expect(tab(page, 'Output')).toBeVisible();
  await expect(tab(page, 'Problems')).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'View' }).click();
  await expect(page.getByRole('menuitem', { name: /Output/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Problems/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Reset window layout/ }).click();
  await expect(tab(page, 'Problems')).toHaveCount(0);
  await expect(tab(page, 'Output')).toBeVisible();

  // a session written before 2026-10-09: Problems tabbed with Output, Problems the shown tab
  await page.waitForTimeout(500); // the session is written 300 ms after the last change
  const planted = await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('skp.studio.session')!);
    const visit = (n: { type: string; data: unknown }): boolean => {
      if (n.type === 'leaf') {
        const g = n.data as { views: string[]; activeView?: string };
        if (!g.views.includes('output')) return false;
        g.views.unshift('problems');
        g.activeView = 'problems';
        return true;
      }
      return (n.data as { type: string; data: unknown }[]).some(visit);
    };
    const found = visit(s.dock.dock.grid.root);
    s.dock.dock.panels.problems = { ...s.dock.dock.panels.output, id: 'problems', title: 'Problems' };
    s.dock.hidden = []; s.dock.homes = { output: { ref: 'problems', direction: 'within', size: 0, layout: [] } };
    sessionStorage.setItem('skp.studio.session', JSON.stringify(s));
    localStorage.setItem('skp.studio.session', JSON.stringify(s));
    return found;
  });
  expect(planted).toBe(true);
  await page.reload();
  const panel = documentPanel(page, t.workflow);
  await expect(panel.locator('.react-flow__node').first()).toBeVisible();
  await expect(tab(page, 'Problems')).toHaveCount(0);
  await expect(tab(page, 'Output')).toBeVisible();
  await expect(page.locator('.toast')).not.toContainText('could not be restored');
  // no empty place: every group in the dock shows a tab
  expect(await page.locator('.dv-groupview').evaluateAll((gs) => gs.filter((g) => g.querySelectorAll('.dv-tab').length === 0).length)).toBe(0);
});

test('a short circuit is pinned red at the top of Output, above the log; clicking it picks both wires', async ({ page }) => {
  const panel = await open(page);
  const ab = `${t.a}->${t.b}`;
  await shapeByHand(page, panel, ab);
  const f = await freeWire(page, panel, t.c);
  await layOn(page, panel, f, ab);

  const pinned = await problems(page);
  const row = pinned.getByRole('listitem').filter({ hasText: 'overlaps' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('b')).toHaveCSS('color', RED);
  await expect(row.locator('.pd')).toHaveCSS('color', RED);
  // pinned above the log, which goes on below it
  const pane = page.locator('[data-pane="output"]');
  expect(await pane.evaluate((el) => [...el.children].map((c) => c.getAttribute('role')))).toEqual(['list', 'log']);
  expect((await pinned.boundingBox())!.y).toBeLessThan((await pane.getByRole('log').boundingBox())!.y);
  await shot(page, '1-short-circuit-pinned');

  await row.click();
  await expect(edge(panel, ab).locator('.wire.picked')).toHaveCount(1);
  await expect(edge(panel, f).locator('.wire.picked')).toHaveCount(1);
  // keyboard: the row is focusable and Enter picks too
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(edge(panel, f).locator('.wire.picked')).toHaveCount(1);
});

test('a Save with a change: Output logs it from "Save started" through BaseApi\'s stages to the alignment, in order, no red', async ({ page, request }) => {
  const panel = await open(page);
  await typeInto(page, panel, t.c, 'Description', 'e2e log');
  await save(page);

  const all = await lines(page);
  const got = inOrder(all, [
    'Save started: sending 1 step and the layout',
    'BaseApi · design stored on the workflow',
    'BaseApi · dry run started',
    'BaseApi · schemas: nothing to do',
    'BaseApi · processors: nothing to do',
    'BaseApi · caches: nothing to do',
    'BaseApi · steps: 1 step to check',
    `BaseApi · step '${t.tag}-c': description none → 'e2e log'`,
    'BaseApi · steps: 1 updated',
    'BaseApi · wires: nothing to do',
    'BaseApi · assignments: nothing to do',
    'BaseApi · workflow: nothing to do',
    'BaseApi · dry run passed: 1 change, no errors',
    'BaseApi · committed: the entities hold the design; the stored design is emptied',
    'Saved and applied',
    'graph re-read: 4 steps, 4 links',
    'drawing',
    'nothing left stored: the entities hold the design, the layout is kept',
  ]);
  expect(got.filter((l) => l.red)).toEqual([]);
  // the drawing was not touched: nothing for settling to change
  expect(got[16]!.text).toMatch(/^drawing(: the workflow's own wires, nothing to settle| agrees with BaseApi's links)$/);
  expect(new Set((await lines(page)).map((l) => l.name))).toEqual(new Set([t.tag]));
  expect((await request.get(`/api/v1/steps/${t.c}`).then((r) => r.json()) as { description: string }).description).toBe('e2e log');
  await shot(page, '2-save-log');
});

test('a Save BaseApi refuses: the refused entity, its stage, the dry run and the rollback in red; then a refresh keeps the log', async ({ page }) => {
  const panel = await open(page);
  await typeInto(page, panel, t.c, 'Version', 'abc');
  await save(page);

  const all = await lines(page);
  const got = inOrder(all, [
    'Save started: sending 1 step and the layout',
    'BaseApi · steps: 1 step to check',
    `BaseApi · step '${t.tag}-c': version: `,
    'BaseApi · steps: 1 refused',
    'BaseApi · dry run failed: 1 error on 1 entity',
    'BaseApi · rolled back: no entity was changed; the design stays stored on the workflow',
    'Saved; not applied: 1 error',
    'graph re-read: 4 steps, 4 links',
    'drawing',
    'design stored on the workflow, not applied: the drawing shows the stored design',
  ]);
  expect(got.map((l) => l.red)).toEqual([false, false, true, true, true, true, true, false, false, true]);
  expect(got[8]!.text).toMatch(/^drawing(: the workflow's own wires, nothing to settle| agrees with BaseApi's links)$/);
  await expect((await outputLines(page)).filter({ hasText: 'dry run failed' })).toHaveCSS('color', RED);
  const pinned = await problems(page);
  await expect(pinned.getByRole('listitem')).toHaveCount(1);
  await expect(pinned.getByRole('listitem')).toContainText('version');
  await shot(page, '3-refused-red');

  // a refresh keeps the log, line for line, red as it was
  const before = await lines(page);
  await page.waitForTimeout(500); // the session is written 300 ms after the last change
  await page.reload();
  await expect(documentPanel(page, t.workflow).locator('.react-flow__node').first()).toBeVisible();
  expect(await lines(page)).toEqual(before);
  await shot(page, '4-after-refresh');
});

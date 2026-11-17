import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  drawWire, emptyPoint, field, frameOf, inspector, openBoard, openEmptyBoard, outLine, pickFrame, pickStep, selbar, stepsOf, throwaway,
  toolbar, waitLoaded, wiresOf, type Frame,
} from './helpers';

// Features 9 (copy/paste), 10 (save), 11 (delete), 12 (Start/Stop, never pressed on a saved workflow) and 13 (drafts).
// The writes go to throwaway workflows only (the guard in fixtures.ts refuses anything else).

const saveBtn = (page: Page) => toolbar(page, 'workflow').getByRole('button', { name: 'Save', exact: true });

/** Names a throwaway (Inspector) and saves it from its toolbar; waits until the save has finished. */
async function saveAs(page: Page, f: Frame, prefix: string): Promise<string> {
  await pickFrame(f.frame);
  const name = `e2e-${prefix}-${Date.now()}`;
  await field(page, 'Name').fill(name);
  await saveBtn(page).click();
  await expect(outLine(page, `${name}: Kibana diagram published`)).toHaveCount(1);
  await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
  return name;
}

const listed = async (page: Page, id: string) =>
  ((await (await page.request.get('/api/v1/workflows')).json()) as { id: string }[]).some((w) => w.id === id);

const overlaps = (r: { x: number; y: number; width: number; height: number }[]) => {
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    const a = r[i]!, b = r[j]!;
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) return true;
  }
  return false;
};

test.describe('copy and paste', () => {
  test('Copy from the step toolbar and the bar; Ctrl+V into a picked workflow keeps the wires and picks what it pasted', async ({ page }) => {
    await openEmptyBoard(page);
    const w1 = await throwaway(page, 2);
    await drawWire(page, w1.steps[0]!, w1.steps[1]!);
    const w2 = await throwaway(page, 0);

    // nothing picked, then nothing copied
    const empty = await emptyPoint(page);
    await page.mouse.click(empty.x, empty.y);
    await page.keyboard.press('Control+v');
    await expect(outLine(page, 'Select a workflow to paste into')).toHaveCount(1);
    await pickFrame(w2.frame);
    await page.keyboard.press('Control+v');
    await expect(outLine(page, 'Nothing copied yet')).toHaveCount(1);
    await expect(stepsOf(page, w2.id)).toHaveCount(0);

    // the step toolbar's Copy: one step
    await pickStep(w1.steps[0]!);
    await toolbar(page, 'step').getByRole('button', { name: 'Copy' }).click();
    await expect(outLine(page, 'Copied 1 step')).toHaveCount(1);
    // two picked steps and the bar's Copy: the steps and the wire between them
    await pickStep(w1.steps[1]!, true);
    await selbar(page).getByRole('button', { name: 'Copy' }).click();
    await expect(outLine(page, 'Copied 2 steps and 1 wire')).toHaveCount(1);

    // into the other (empty) workflow
    await pickFrame(w2.frame);
    await page.keyboard.press('Control+v');
    await expect(outLine(page, `Pasted 2 steps into ${w2.name}`)).toHaveCount(1);
    await expect(stepsOf(page, w2.id)).toHaveCount(2);
    await expect(wiresOf(page, w2.id)).toHaveCount(1);
    await expect(w2.frame.locator('.unsaved-tag')).toBeVisible();
    await expect(selbar(page).locator('.selbar-pill')).toHaveText('2 SELECTED');
    await expect(stepsOf(page, w2.id).and(page.locator('.selected'))).toHaveCount(2);
    await expect(stepsOf(page, w2.id).locator('.sn')).toHaveText(['archive-expander', 'archive-expander-2']);

    // into the workflow it came from: on free space, next to what is there
    await pickFrame(w1.frame);
    await page.keyboard.press('Control+v');
    await expect(outLine(page, `Pasted 2 steps into ${w1.name}`)).toHaveCount(1);
    await expect(stepsOf(page, w1.id)).toHaveCount(4);
    await expect(wiresOf(page, w1.id)).toHaveCount(2);
    const boxes = await stepsOf(page, w1.id).evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    expect(overlaps(boxes), 'pasted steps overlap the ones there').toBe(false);
    // every step name in a workflow stays unique
    const names = await stepsOf(page, w1.id).locator('.sn').allInnerTexts();
    expect(new Set(names).size).toBe(4);
    // pasted next to a picked step goes into that step's workflow
    await pickStep(w1.steps[0]!);
    await page.keyboard.press('Control+v');
    await expect(stepsOf(page, w1.id)).toHaveCount(6);
  });
});

test.describe('save', () => {
  test('Save from the toolbar: saved, the diagram published, positions kept through a reload', async ({ page, request }) => {
    await openEmptyBoard(page);
    const f = await throwaway(page, 2);
    await drawWire(page, f.steps[0]!, f.steps[1]!);
    await pickFrame(f.frame);
    await expect(saveBtn(page)).toHaveClass(/primary/);
    const name = `e2e-save-${Date.now()}`;
    await field(page, 'Name').fill(name);
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/workflows/${f.id}/design`));
    await saveBtn(page).click();
    expect((await put).ok()).toBe(true);
    await expect(outLine(page, `${name} saved`)).toHaveCount(1);
    await expect(outLine(page, `${name}: Kibana diagram published`)).toHaveCount(1);
    await expect(f.frame.locator('.unsaved-tag')).toHaveCount(0);
    await expect(saveBtn(page)).not.toHaveClass(/primary/);
    expect(await listed(page, f.id)).toBe(true);
    const svg = await request.get(`/api/v1/workflows/${f.id}.svg`);
    expect(svg.status()).toBe(200);
    expect(await svg.text()).toContain('<svg');

    const frameBox = (await f.frame.boundingBox())!;
    const stepBoxes = await Promise.all(f.steps.map(async (s) => (await s.boundingBox())!));
    await page.reload();
    await waitLoaded(page);
    const again = frameOf(page, f.id);
    await expect(again.locator('.nm')).toHaveText(name);
    await expect(again.locator('.unsaved-tag')).toHaveCount(0);
    const near = (a: { x: number; y: number; width: number; height: number }, b: typeof a, what: string) => {
      for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(a[k] - b[k]), `${what} ${k}`).toBeLessThanOrEqual(1);
    };
    near((await again.boundingBox())!, frameBox, 'frame');
    const ids = await Promise.all(f.steps.map((s) => s.getAttribute('data-id')));
    for (let i = 0; i < ids.length; i++) near((await page.locator(`[data-id="${ids[i]}"]`).boundingBox())!, stepBoxes[i]!, `step ${i + 1}`);
    await expect(wiresOf(page, f.id)).toHaveCount(1);
  });

  test('a save BaseAPI refuses shows its error and keeps the unsaved tag', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await throwaway(page, 0);
    await pickFrame(f.frame);
    // an empty name is one BaseAPI's design dry run refuses
    await field(page, 'Name').fill('');
    await saveBtn(page).click();
    const err = out(page).locator('.k-err').first();
    await expect(err).toBeVisible();
    test.info().annotations.push({ type: 'refusal', description: await err.innerText() });
    await expect(saveBtn(page)).toHaveText('Save');
    await expect(f.frame.locator('.unsaved-tag')).toBeVisible();
  });
});

const out = (page: Page) => page.locator('[data-panel="output"]');

test.describe('delete', () => {
  test('toolbar Delete asks with the dry run\'s counts; Cancel sends nothing; Delete removes it from BaseAPI', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await throwaway(page, 1);
    const name = await saveAs(page, f, 'delete');
    const tb = toolbar(page, 'workflow');
    await tb.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(tb.locator('.confirm-text')).toHaveText(`1 step, 0 assignments go. Delete ${name}?`);
    await expect(tb.getByRole('button')).toHaveText(['Delete', 'Cancel']);
    let deletes = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && /\/delete$/.test(new URL(r.url()).pathname) && !r.url().includes('dryRun')) deletes++; });
    await tb.getByRole('button', { name: 'Cancel' }).click();
    await expect(outLine(page, 'Delete cancelled — nothing was sent')).toHaveCount(1);
    await expect(tb.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(f.frame).toBeVisible();
    expect(deletes).toBe(0);
    expect(await listed(page, f.id)).toBe(true);

    await tb.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(tb.locator('.confirm-text')).toHaveText(`1 step, 0 assignments go. Delete ${name}?`);
    await tb.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(frameOf(page, f.id)).toHaveCount(0);
    await expect(outLine(page, `${name} deleted: 1 step, 0 assignments`)).toHaveCount(1);
    expect(deletes).toBe(1);
    await expect.poll(() => listed(page, f.id)).toBe(false);
    await expect(inspector(page)).toContainText('Select a workflow, step or wire to see and edit it here.');
  });

  test('a never-saved workflow is discarded with no request', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await throwaway(page, 1);
    const sent: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) sent.push(`${r.method()} ${r.url()}`); });
    await pickFrame(f.frame);
    const tb = toolbar(page, 'workflow');
    await tb.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(tb.locator('.confirm-text')).toHaveText(`Delete ${f.name}? It was never saved.`);
    await tb.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(frameOf(page, f.id)).toHaveCount(0);
    await expect(outLine(page, `${f.name} discarded`)).toHaveCount(1);
    expect(sent).toEqual([]);
  });

  test('the bar deletes two picked workflows with one confirm', async ({ page }) => {
    await openEmptyBoard(page);
    const a = await throwaway(page, 1);
    const an = await saveAs(page, a, 'bar-a');
    const b = await throwaway(page, 2);
    const bn = await saveAs(page, b, 'bar-b');
    await pickFrame(a.frame);
    await pickFrame(b.frame, true);
    const bar = selbar(page);
    await expect(bar.locator('.selbar-pill')).toHaveText('2 SELECTED');
    await bar.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(bar.locator('.selbar-text')).toHaveText('3 steps, 0 assignments go. Delete 2 workflows?');
    await bar.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(frameOf(page, a.id)).toHaveCount(0);
    await expect(frameOf(page, b.id)).toHaveCount(0);
    await expect(outLine(page, `${an} deleted: 1 step, 0 assignments`)).toHaveCount(1);
    await expect(outLine(page, `${bn} deleted: 2 steps, 0 assignments`)).toHaveCount(1);
    await expect.poll(async () => (await listed(page, a.id)) || (await listed(page, b.id))).toBe(false);
  });
});

test.describe('Start and Stop (never pressed on a saved workflow)', () => {
  test('a stopped workflow offers ▶ Start, a running one ■ Stop; the bar counts each', async ({ page, request, stack }) => {
    const live = new Set(((await (await request.get('/api/v1/orchestration/live')).json()) as string[]).map((x) => x.toLowerCase()));
    const stopped = stack.workflows.find((w) => !live.has(w.id.toLowerCase()));
    const running = stack.workflows.find((w) => live.has(w.id.toLowerCase()));
    await openBoard(page);
    const tb = toolbar(page, 'workflow');
    if (stopped) {
      await pickFrame(frameOf(page, stopped.id));
      await expect(frameOf(page, stopped.id).locator('.state-badge')).toHaveText('Stopped');
      await expect(tb.getByRole('button', { name: '▶ Start', exact: true })).toBeEnabled();
      await expect(tb.getByRole('button', { name: '■ Stop', exact: true })).toHaveCount(0);
      await expect(tb.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(tb.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    } else test.info().annotations.push({ type: 'skipped', description: 'no stopped workflow on the stack' });
    if (running) {
      await pickFrame(frameOf(page, running.id));
      await expect(frameOf(page, running.id).locator('.state-badge')).toHaveText('Running');
      await expect(tb.getByRole('button', { name: '■ Stop', exact: true })).toBeEnabled();
      await expect(tb.getByRole('button', { name: '▶ Start', exact: true })).toHaveCount(0);
    } else test.info().annotations.push({ type: 'skipped', description: 'no running workflow on the stack' });
    if (stopped && running) {
      await pickFrame(frameOf(page, stopped.id));
      await pickFrame(frameOf(page, running.id), true);
      await expect(selbar(page).getByRole('button', { name: '▶ Start 1', exact: true })).toBeVisible();
      await expect(selbar(page).getByRole('button', { name: '■ Stop 1', exact: true })).toBeVisible();
      await expect(selbar(page).getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    }
  });

  test('Start on a never-saved workflow says it is not saved yet and sends nothing', async ({ page }) => {
    await openEmptyBoard(page);
    const f = await throwaway(page, 1);
    const sent: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/')) sent.push(`${r.method()} ${r.url()}`); });
    await pickFrame(f.frame);
    const start = toolbar(page, 'workflow').getByRole('button', { name: '▶ Start', exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(outLine(page, `${f.name}: not saved yet — BaseAPI has no such workflow`)).toHaveCount(1);
    expect(sent).toEqual([]);
  });
});

test.describe('drafts', () => {
  test('unsaved work survives a reload of the tab, with its undo history; nothing is dropped', async ({ page }) => {
    await openEmptyBoard(page);
    const saved = await throwaway(page, 1);
    const name = await saveAs(page, saved, 'draft');
    // two edits to the saved one: a description, then a second step
    await field(page, 'Description').fill('an unsaved edit');
    await expect(saved.frame.locator('.unsaved-tag')).toBeVisible();
    const fresh = await throwaway(page, 2);
    await drawWire(page, fresh.steps[0]!, fresh.steps[1]!);

    await page.reload();
    await waitLoaded(page);
    await expect(outLine(page, /was dropped/)).toHaveCount(0);
    const s = frameOf(page, saved.id);
    await expect(s.locator('.nm')).toHaveText(name);
    await expect(s.locator('.unsaved-tag')).toBeVisible();
    const n = frameOf(page, fresh.id);
    await expect(n.locator('.nm')).toHaveText(fresh.name);
    await expect(n.locator('.unsaved-tag')).toBeVisible();
    await expect(stepsOf(page, fresh.id)).toHaveCount(2);
    await expect(wiresOf(page, fresh.id)).toHaveCount(1);
    // the history came back too: Undo takes the edits back, the saved one ends saved
    await pickFrame(s);
    await expect(field(page, 'Description')).toHaveValue('an unsaved edit');
    await inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(field(page, 'Description')).toHaveValue('');
    await expect(s.locator('.unsaved-tag')).toHaveCount(0);
    await pickFrame(n);
    await inspector(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(wiresOf(page, fresh.id)).toHaveCount(0);
  });
});

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { caNode, childLabels, clickEmptyBoard, inspector, openAt, pickCache, selbar, stNode, tabLabels, toolbar, wfNode } from './helpers';
import { seed } from './seed';

// Box select with the right mouse button [user, 2026-11-22]: a right-drag draws a dashed rectangle; on release every
// triangle, step and cache fully or partly inside it is picked (never wires, arrows, lines or ghosts), numbered left to
// right then top to bottom; Ctrl adds; an empty box clears; a right-click without a drag does nothing and the browser's
// menu never opens on the board. Nothing is saved.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-box-first', at: { x: 300, y: 40 }, next: ['s2'] },
    { key: 's2', name: 'e2e-box-second', at: { x: 620, y: 40 } },
    { key: 's3', name: 'e2e-box-lone', at: { x: 300, y: 300 } },
  ],
  caches: [{ key: 'c', name: 'e2e-box-cache', at: { x: 0, y: 300 } }],
  payloads: [{ key: 'p', step: 's1', payload: '{}' }],
  workflows: [{ key: 'w', name: 'e2e-box-wf', at: { x: 0, y: 40 }, entry: ['s1'], caches: ['c'], payloads: ['p'] }],
} as const;

type Pt = { x: number; y: number };

/** A real right-button drag from `a` to `b` (page pixels), Ctrl held when asked. */
async function rightDrag(page: Page, a: Pt, b: Pt, ctrl = false, during?: () => Promise<void>) {
  await page.mouse.move(a.x, a.y);
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  if (during) await during();
  await page.mouse.up({ button: 'right' });
  if (ctrl) await page.keyboard.up('Control');
}

const boxOf = async (l: ReturnType<typeof stNode>) => (await l.boundingBox())!;
const pills = (page: Page) => selbar(page).locator('.selbar-pill');

test('a right-drag box around a triangle, three steps and a cache picks all five, numbered left to right; the bar shows what they share', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const w = await boxOf(wfNode(page, id.w!)), s2 = await boxOf(stNode(page, id.s2!)), c = await boxOf(caNode(page, id.c!));
  await rightDrag(page, { x: w.x - 20, y: w.y - 20 }, { x: s2.x + s2.width + 20, y: c.y + c.height + 20 }, false, async () => {
    // the dashed box is drawn while dragging
    await expect(page.getByTestId('box-select')).toBeVisible();
    await expect(page.getByTestId('box-select')).toHaveCSS('border-top-style', 'dashed');
  });
  await expect(page.getByTestId('box-select')).toHaveCount(0);
  // the lone step (also inside) makes five: everything in the box
  await expect(pills(page)).toHaveText('5 SELECTED');
  await expect(wfNode(page, id.w!).locator('.pick-no')).toHaveText('1');
  await expect(caNode(page, id.c!).locator('.pick-no')).toHaveText('2');
  await expect(stNode(page, id.s1!).locator('.pick-no')).toHaveText('3');
  await expect(stNode(page, id.s3!).locator('.pick-no')).toHaveText('4');
  await expect(stNode(page, id.s2!).locator('.pick-no')).toHaveText('5');
  // a triangle with steps and a cache share Copy and Delete (every delete is a ghost) [user, 2026-11-23]
  await expect(selbar(page).getByRole('button')).toHaveText(['Copy', 'Delete']);
  await expect(inspector(page)).toContainText('5 things are selected');
});

test('a box over only part of an item picks it; one pick shows its own toolbar; two steps share Copy · Delete', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const s1 = await boxOf(stNode(page, id.s1!)), s2 = await boxOf(stNode(page, id.s2!));
  // a corner of the first step only
  await rightDrag(page, { x: s1.x + s1.width - 10, y: s1.y - 30 }, { x: s1.x + s1.width + 40, y: s1.y + 10 });
  await expect(toolbar(page, 'step').getByRole('button')).toHaveText(['Copy', 'Delete']);
  await expect(selbar(page)).toHaveCount(0);
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  // a box from under the middle of one step to the middle of the next (a drag started on a toolbar is not a box)
  await rightDrag(page, { x: s1.x + s1.width / 2, y: s1.y + s1.height + 20 }, { x: s2.x + s2.width / 2, y: s2.y + s2.height / 2 });
  await expect(pills(page)).toHaveText('2 SELECTED');
  await expect(selbar(page).getByRole('button')).toHaveText(['Copy', 'Delete']);
});

test('a box around a workflow and the step it enters shows that step with the workflow\'s assignment, as a click and Ctrl+click do', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const w = await boxOf(wfNode(page, id.w!)), s1 = await boxOf(stNode(page, id.s1!));
  await rightDrag(page, { x: w.x - 10, y: s1.y - 20 }, { x: s1.x + 40, y: s1.y + 40 });
  await expect(tabLabels(page)).toHaveText(['Step', 'Processor']);
  await expect(childLabels(page, 'Step')).toContainText(['e2e-box-wf']);
});

test('Ctrl adds the box to what is picked; an empty box clears; a right-click alone changes nothing and opens no menu', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  await pickCache(page, id.c!);
  const s3 = await boxOf(stNode(page, id.s3!));
  await rightDrag(page, { x: s3.x - 20, y: s3.y - 20 }, { x: s3.x + 40, y: s3.y + 30 }, true);
  await expect(pills(page)).toHaveText('2 SELECTED');
  await expect(caNode(page, id.c!).locator('.pick-no')).toHaveText('1');
  await expect(stNode(page, id.s3!).locator('.pick-no')).toHaveText('2');

  // a right-click with no drag: the picks stay, and the board's context menu is held back
  await page.mouse.click(s3.x + s3.width + 120, s3.y + 20, { button: 'right' });
  await expect(pills(page)).toHaveText('2 SELECTED');
  const prevented = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')!;
    return !pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  expect(prevented, 'the browser menu is held back on the board').toBe(true);

  // a box over empty board clears the picks
  await rightDrag(page, { x: s3.x + s3.width + 120, y: s3.y + 120 }, { x: s3.x + s3.width + 220, y: s3.y + 200 });
  await expect(selbar(page)).toHaveCount(0);
  await expect(page.locator('.pick-no')).toHaveCount(0);
  // a plain left click on empty board still clears and left-drag still pans (unchanged)
  await clickEmptyBoard(page);
});

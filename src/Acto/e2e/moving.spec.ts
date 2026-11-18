import { test, expect } from './fixtures';
import { caNode, dragBy, flowPos, inspector, openAt, pickCache, pickStep, selectWorkflowAlone, save, stNode, wfNode } from './helpers';
import { seed } from './seed';
import { getJson, type Row } from './stack';

// Spec §5: dragging a triangle, step or cache moves only that item and changes only its location; several picked items drag together as one
// undo step; a click with a wobbling hand is a click. Real mouse gestures at zoom 1.

const SEED = {
  steps: [
    { key: 's1', name: 'e2e-mov-first', at: { x: 300, y: 120 } },
    { key: 's2', name: 'e2e-mov-second', at: { x: 600, y: 120 } },
  ],
  caches: [{ key: 'c1', name: 'e2e-mov-cache', at: { x: 40, y: 380 } }],
  workflows: [{ key: 'w', name: 'e2e-mov-wf', at: { x: 0, y: 30 }, entry: ['s1'], caches: ['c1'] }],
} as const;

/** A drag moves the item by the mouse's travel less what the click slop swallowed before the drag began (up to CLICK_SLOP + a step of the move). */
const travelled = (got: number, want: number) => {
  expect(Math.abs(got), `moved ${got} for a drag of ${want}`).toBeLessThanOrEqual(Math.abs(want));
  expect(Math.abs(got), `moved ${got} for a drag of ${want}`).toBeGreaterThanOrEqual(Math.abs(want) - 14);
  expect(Math.sign(got)).toBe(Math.sign(want));
};

const undoBtn = (page: import('@playwright/test').Page) => inspector(page).getByRole('button', { name: 'Undo', exact: true });

test('dragging a triangle, a step and a cache moves each alone; the Inspector\'s location and the unsaved mark follow; Undo puts it back', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const at = async () => ({ w: await flowPos(wfNode(page, id.w!)), s1: await flowPos(stNode(page, id.s1!)), s2: await flowPos(stNode(page, id.s2!)), c: await flowPos(caNode(page, id.c1!)) });
  const start = await at();

  // the triangle: grabbed on its body, not a handle
  await dragBy(page, wfNode(page, id.w!), 40, 60, { x: 60, y: 30 });
  const a = await at();
  travelled(a.w.x - start.w.x, 40);
  travelled(a.w.y - start.w.y, 60);
  expect(a.s1).toEqual(start.s1); expect(a.s2).toEqual(start.s2); expect(a.c).toEqual(start.c);
  await expect(wfNode(page, id.w!).locator('.unsaved-mark')).toBeVisible();
  await expect(stNode(page, id.s1!).locator('.unsaved-mark')).toHaveCount(0);
  await selectWorkflowAlone(page, id.w!);
  await expect(inspector(page).locator('dt', { hasText: 'Location' }).locator('xpath=following-sibling::dd[1]'))
    .toHaveText(`${Math.round(a.w.x)}, ${Math.round(a.w.y)}`);

  // the step (by its name line, so the grab is not on a handle)
  await dragBy(page, stNode(page, id.s2!), -70, 90, { x: 100, y: 25 });
  const b = await at();
  travelled(b.s2.x - a.s2.x, -70);
  travelled(b.s2.y - a.s2.y, 90);
  expect(b.w).toEqual(a.w); expect(b.s1).toEqual(a.s1); expect(b.c).toEqual(a.c);
  await expect(stNode(page, id.s2!).locator('.unsaved-mark')).toBeVisible();

  // the cache
  await dragBy(page, caNode(page, id.c1!), 120, -40, { x: 80, y: 28 });
  const c = await at();
  travelled(c.c.x - b.c.x, 120);
  travelled(c.c.y - b.c.y, -40);
  expect(c.w).toEqual(b.w); expect(c.s2).toEqual(b.s2);
  await expect(caNode(page, id.c1!).locator('.unsaved-mark')).toBeVisible();

  // three drags, three undo steps, newest first
  await undoBtn(page).click();
  expect(await flowPos(caNode(page, id.c1!))).toEqual(b.c);
  await undoBtn(page).click();
  expect(await flowPos(stNode(page, id.s2!))).toEqual(a.s2);
  await undoBtn(page).click();
  expect(await flowPos(wfNode(page, id.w!))).toEqual(start.w);
  await expect(page.locator('.unsaved-mark')).toHaveCount(0);
  await expect(undoBtn(page)).toBeDisabled();
});

test('picked steps and caches drag together by the same amount, and that is one undo step; a triangle never joins', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const at = async () => ({ w: await flowPos(wfNode(page, id.w!)), s1: await flowPos(stNode(page, id.s1!)), s2: await flowPos(stNode(page, id.s2!)), c: await flowPos(caNode(page, id.c1!)) });
  const start = await at();
  await pickStep(page, id.s1!);
  await pickStep(page, id.s2!, true);
  await pickCache(page, id.c1!, true);
  await dragBy(page, stNode(page, id.s1!), 50, 70, { x: 100, y: 25 });
  const moved = await at();
  for (const k of ['s1', 's2', 'c'] as const) {
    travelled(moved[k].x - start[k].x, 50);
    travelled(moved[k].y - start[k].y, 70);
    // the same amount for every one of them
    expect(moved[k].x - start[k].x).toBe(moved.s1.x - start.s1.x);
    expect(moved[k].y - start[k].y).toBe(moved.s1.y - start.s1.y);
  }
  expect(moved.w).toEqual(start.w);
  // all three picked, one step to undo
  await expect(page.locator('.pick-no')).toHaveCount(3);
  await undoBtn(page).click();
  expect(await at()).toEqual(start);
  await expect(undoBtn(page)).toBeDisabled();
});

test('a click that wobbles a few pixels is a click: it picks and moves nothing; a drag past the slop moves', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const start = await flowPos(stNode(page, id.s1!));
  // 5 px of wobble, down and up on the step
  await dragBy(page, stNode(page, id.s1!), 3, 4, { x: 100, y: 25 });
  expect(await flowPos(stNode(page, id.s1!))).toEqual(start);
  await expect(stNode(page, id.s1!).locator('.unsaved-mark')).toHaveCount(0);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('step');
  await expect(undoBtn(page)).toBeDisabled();
  // the same on a triangle and a cache
  const w0 = await flowPos(wfNode(page, id.w!));
  await dragBy(page, wfNode(page, id.w!), 2, 3, { x: 60, y: 30 });
  expect(await flowPos(wfNode(page, id.w!))).toEqual(w0);
  await expect(inspector(page).locator('.ph .cnt')).toHaveText('workflow');
  const c0 = await flowPos(caNode(page, id.c1!));
  await dragBy(page, caNode(page, id.c1!), 3, 2, { x: 80, y: 28 });
  expect(await flowPos(caNode(page, id.c1!))).toEqual(c0);
  await expect(page.locator('.unsaved-mark')).toHaveCount(0);
  // past the slop it moves
  await dragBy(page, stNode(page, id.s1!), 20, 0, { x: 100, y: 25 });
  travelled((await flowPos(stNode(page, id.s1!))).x - start.x, 20);
});

test('Esc during a drag puts the item back; the arrow keys nudge what is picked by 8 px, one undo step while a key repeats', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const start = await flowPos(stNode(page, id.s2!));
  await dragBy(page, stNode(page, id.s2!), 80, 80, { x: 100, y: 25 }, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => flowPos(stNode(page, id.s2!))).toEqual(start);
  await expect(page.locator('.unsaved-mark')).toHaveCount(0);

  await pickStep(page, id.s2!);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const n = await flowPos(stNode(page, id.s2!));
  expect(n.x - start.x).toBe(8);
  expect(n.y - start.y).toBe(8);
  await undoBtn(page).click();
  await undoBtn(page).click();
  expect(await flowPos(stNode(page, id.s2!))).toEqual(start);
});

test('Save keeps where things were dragged: BaseAPI holds the new locations and a reload shows them there', async ({ page }) => {
  const id = await seed(SEED);
  await openAt(page);
  const was = { w: await flowPos(wfNode(page, id.w!)), s1: await flowPos(stNode(page, id.s1!)) };
  await dragBy(page, wfNode(page, id.w!), 30, 100, { x: 60, y: 30 });
  await dragBy(page, stNode(page, id.s1!), -20, 50, { x: 100, y: 25 });
  const now = { w: await flowPos(wfNode(page, id.w!)), s1: await flowPos(stNode(page, id.s1!)) };
  await save(page);
  const w = await getJson<Row>(`/workflows/${id.w}`);
  const s1 = await getJson<Row>(`/steps/${id.s1}`);
  expect([w.boardX, w.boardY]).toEqual([now.w.x, now.w.y]);
  expect([s1.boardX, s1.boardY]).toEqual([now.s1.x, now.s1.y]);
  travelled(now.w.y - was.w.y, 100);
  await page.reload();
  expect(await flowPos(wfNode(page, id.w!))).toEqual(now.w);
  expect(await flowPos(stNode(page, id.s1!))).toEqual(now.s1);
});
